// The burn crank. Every CRANK_MS (3 minutes), for every live coin: whatever creator fees pump.fun
// has paid into the coin's own key buy the coin back at an exact token amount, and exactly that
// amount is burned, all in ONE transaction. It lands whole or not at all.
//
// Who pays what:
//   the coin's fees  → the buy, and nothing else (100%)
//   the master       → the network fee, the token account, pump's volume account, and a short
//                      loan of WSOL rent that the same transaction pays back
//
// Money safety:
//   - the coin key keeps a fixed floor (890,880 lamports, paid by the master at launch), so a buy
//     can never leave it rent-paying, and the budget is "everything above the floor"
//   - the buy's max cost is cut so it can never exceed the budget, slippage included
//   - the signature is journaled on the coin BEFORE broadcast; while it is unsettled the coin is
//     skipped. A second transaction could only ever spend fees that really arrived, but a receipt
//     must never be written twice or lost.
//   - receipts are measured from the confirmed transaction, never from the quote.
import { config } from './config.js'
import {
  getMaster, coinKeyFor, submit, settled, txMeta, transferSol, tipIx, isKilled, SYSTEM_RENT_FLOOR, getConnection, sol, pk,
} from './solana.js'
import {
  readVaults, collectIxs, curveBuyExact, ammBuyExact, burnIx, readCurves, accumulatorOf, initAccumulatorIx,
  creatorVaultPda, ammVaultAta, wsolAtaOf, wsolAccountsOf, closeIntoOwnerIx, DECIMALS,
} from './pump.js'
import { readCoins, patchCoin, appendReceipt } from './store.js'

/**
 * Pure. What one cycle can do for a coin, in lamports (BigInt):
 *   key   the coin key's balance (floor + unspent fees)     curve / amm  what waits in pump's vaults
 * → { budget, topUp, curve, amm } or null when there is less than `min` to spend.
 * A key below its floor (it should never be) is topped back up by the master first.
 */
export function planBuyback({ key, curve, amm, floor = SYSTEM_RENT_FLOOR, min, max = null, withCurve = true }) {
  key = BigInt(key); curve = BigInt(curve); amm = BigInt(amm)
  if (!withCurve) curve = 0n
  const above = key > floor ? key - floor : 0n
  const topUp = key < floor ? floor - key : 0n
  let budget = above + (curve > 0n ? curve : 0n) + (amm > 0n ? amm : 0n)
  if (budget < BigInt(min)) return null
  // A cap per cycle: everything is still collected, the rest waits in the coin key for the next one.
  if (max != null && budget > BigInt(max)) budget = BigInt(max)
  return { budget, topUp, curve: curve > 0n, amm: amm > 0n }
}

/**
 * Pure. What a confirmed buyback actually spent: the net lamports that left the coin's own
 * accounts (its key + pump's two fee vaults for it + its temporary WSOL account). The master's
 * loan comes in and goes out inside the set, so it nets to zero.
 * `keys` = account addresses in transaction order; pre/post = lamport arrays.
 */
export function measureSpent({ keys, pre, post }, own) {
  let out = 0n
  keys.forEach((k, i) => { if (own.has(k)) out += BigInt(pre[i]) - BigInt(post[i]) })
  return out
}

let wsolRent = null
async function wsolRentLamports() {
  if (wsolRent == null) wsolRent = BigInt(await getConnection().getMinimumBalanceForRentExemption(165))
  return wsolRent
}

/**
 * The instructions of one buyback, for any master `m` and coin key `k` (addresses). Pure over the
 * chain reads it makes; the simulator calls it with real coins' creators. null = nothing to do.
 */
export async function buybackIxs({ m, k, mint, vaults, graduated, withCurve = true, assumeAccumulator = false }) {
  const lam = x => BigInt(Math.round(x * 1e9))
  const plan = planBuyback({ ...vaults, min: lam(config.minBuybackSol), max: lam(config.maxBuybackSol), withCurve })
  if (!plan) return null
  // pump's volume account for the coin key: the master creates it, in a small transaction of its
  // own (it would push the biggest buyback over the size limit). The buyback follows next cycle.
  const accInfo = assumeAccumulator || await getConnection().getAccountInfo(accumulatorOf(k, graduated), 'confirmed')
  if (!accInfo && !assumeAccumulator) return { initOnly: true, ixs: [await initAccumulatorIx(k, m, graduated)], units: 60_000, plan }

  // A buy worth sandwiching goes to Jito only, with the full slippage headroom. A small one goes
  // public with a tight one: there is too little in it to pay a bot more than our tip would cost.
  const priv = plan.budget >= lam(config.privateBuybackMinSol)
  const ixs = []
  if (priv) ixs.push(tipIx(m, config.jitoTipLamports))
  if (plan.topUp) ixs.push(transferSol(m, k, plan.topUp))

  let loan = 0n
  if (plan.amm || graduated) {
    loan = await wsolRentLamports()
    ixs.push(transferSol(m, k, loan)) // the WSOL account's rent, for the length of this transaction
  }
  ixs.push(...await collectIxs(k, { curve: plan.curve, amm: plan.amm }))

  const args = { mint, coinKey: k, payer: m, budget: plan.budget, slippagePct: priv ? config.slippagePct : config.publicSlippagePct }
  const buy = graduated ? await ammBuyExact({ ...args, wsolRent: 0n }) : await curveBuyExact(args)
  if (!buy) return null
  ixs.push(...buy.ixs)
  ixs.push(burnIx({ ata: buy.ata, mint, coinKey: k, tokens: buy.tokens, tokenProgram: buy.tokenProgram }))
  if (loan) ixs.push(transferSol(k, m, loan)) // paid back

  const own = new Set([k, creatorVaultPda(pk(k)).toBase58(), ammVaultAta(k).toBase58(), wsolAtaOf(k).toBase58()])
  return { ixs, plan, buy, own, private: priv, units: graduated ? 450_000 : 300_000 }
}

/** The one transaction for one of our coins, or null when there is nothing to do. */
export async function buildBuyback(coin, vaults, graduated, opts = {}) {
  const master = getMaster()
  const key = coinKeyFor(coin.id)
  if (!master || !key || key.publicKey.toBase58() !== coin.coinKey) throw new Error('coin key does not derive from this master')
  const b = await buybackIxs({ m: master.publicKey.toBase58(), k: coin.coinKey, mint: coin.mint, vaults, graduated, ...opts })
  return b && { ...b, signers: b.initOnly ? [master] : [master, key] }
}

// Tried in order until the transaction fits in 1232 bytes: everything, then without the curve
// vault's leftovers (a graduated coin's last curve fees wait). A private buy never falls back to a
// public send: if neither fits, the cycle is skipped.
export const VARIANTS = [{}, { withCurve: false }]

/**
 * Close every stray WSOL account the coin key owns into the coin key (see wsolAccountsOf), in a
 * small transaction of its own. Only moves money from the coin's accounts into the coin's key.
 * → number of accounts closed.
 */
async function sweepStrays(coin, master, key) {
  const strays = await wsolAccountsOf(coin.coinKey)
  if (!strays.length) return 0
  const ixs = strays.slice(0, 8).map(a => closeIntoOwnerIx(a.address, coin.coinKey))
  await submit({ payer: master.publicKey, instructions: ixs, signers: [master, key], units: 30_000 + 10_000 * ixs.length, what: `sweep ${ixs.length} WSOL account(s) of $${coin.symbol}` })
  return ixs.length
}

/** Settle a coin's in-flight buyback, if any. → true when the coin is free for a new one. */
async function settlePending(coin) {
  const p = coin.pending
  if (!p) return true
  const landed = await settled(p.sig, p.lvbh)
  if (landed === null) return false
  if (landed === false) { patchCoin(coin.id, { pending: null }); return true }
  return recordReceipt(coin, p) // false while the RPC has not caught up: the coin waits, `pending` stays
}

/** Write the receipt for a confirmed buyback, measured from the chain, and clear the pending mark. → true when written. */
async function recordReceipt(coin, p) {
  const info = await txMeta(p.sig)
  if (!info) return false // the RPC has not caught up: keep `pending`, try again next cycle
  // static keys, then lookup-table writables, then readonlies: the order the balance arrays use
  const keys = info.transaction.message.getAccountKeys({ accountKeysFromLookups: info.meta.loadedAddresses })
    .keySegments().flat().map(x => x.toBase58())
  const spent = measureSpent({ keys, pre: info.meta.preBalances, post: info.meta.postBalances }, new Set(p.own))
  const tokens = BigInt(p.tokens)
  const r = appendReceipt({
    sig: p.sig, mint: coin.mint, symbol: coin.symbol, coinId: coin.id, route: p.route,
    tokens: Number(tokens) / 10 ** DECIMALS, sol: sol(spent), slot: info.slot, at: (info.blockTime || Math.floor(Date.now() / 1000)) * 1000,
  })
  // totals are summed from the receipts themselves (store.burnTotals), never kept on the coin
  patchCoin(coin.id, { pending: null, lastBurnAt: Date.now(), lastError: null })
  if (r) console.log(`[burn] $${coin.symbol}: bought back and burned ${r.tokens.toFixed(0)} for ${r.sol.toFixed(6)} SOL (${p.sig})`)
  return true
}

const state = { running: false, lastRunAt: 0, lastDoneAt: 0, lastError: null, last: [] }
export const crankStatus = () => ({ ...state, everyMs: config.crankMs, nextAt: state.lastRunAt ? state.lastRunAt + config.crankMs : null })

/** One cycle over every live coin. One coin's failure never stops the others. */
export async function crankBurns() {
  if (state.running) return []
  state.running = true
  state.lastRunAt = Date.now()
  const done = []
  try {
    const coins = readCoins().filter(c => c.status === 'live' && c.mint && c.coinKey)
    if (!coins.length) return done
    const vaults = await readVaults(coins.map(c => c.coinKey))
    const curves = await readCurves(coins.map(c => c.mint))
    for (const c0 of coins) {
      if (isKilled()) break
      const coin = readCoins().find(c => c.id === c0.id)
      try {
        if (!(await settlePending(coin))) continue
        let v = vaults.get(coin.coinKey)
        const f = curves.get(coin.mint)
        // an unreadable curve is "unknown", never "graduated": skip the coin this cycle
        if (!v || !f) continue
        const graduated = !!f.graduated
        if (graduated) {
          // fees a stranger collected into another WSOL account of ours: close them into the key first
          const swept = await sweepStrays(coin, getMaster(), coinKeyFor(coin.id))
          if (swept) {
            if (!config.live) continue // dry run: the sweep was only simulated, the balances did not move
            v = (await readVaults([coin.coinKey])).get(coin.coinKey)
          }
        }
        let built = null, res = null
        for (const opts of VARIANTS) {
          built = await buildBuyback(coin, v, graduated, opts).catch(e => {
            if (e.migrating) return null // curve complete, pool not there yet: next cycle
            throw e
          })
          if (!built) break
          if (built.initOnly) {
            await submit({ payer: built.signers[0].publicKey, instructions: built.ixs, signers: built.signers, units: built.units, what: `volume account for $${coin.symbol}` })
            built = null
            break
          }
          try {
            res = await submit({
              payer: built.signers[0].publicKey, instructions: built.ixs, signers: built.signers, units: built.units,
              what: `buyback $${coin.symbol}`, private: built.private,
              onSig: (sig, lvbh) => patchCoin(coin.id, { pending: { sig, lvbh, tokens: built.buy.tokens.toString(), route: built.buy.route, own: [...built.own], at: Date.now() } }),
            })
            break
          } catch (e) {
            if (/over the 1232 limit/.test(String(e.message))) continue
            throw e
          }
        }
        if (!built || !res) continue
        if (res.dryRun) { done.push({ symbol: coin.symbol, dryRun: true, budget: sol(built.plan.budget), tokens: built.buy.tokens.toString() }); continue }
        const fresh = readCoins().find(c => c.id === coin.id)
        if (fresh?.pending) await recordReceipt(fresh, fresh.pending) // false: written next cycle by settlePending
        done.push({ symbol: coin.symbol, sig: res.sig })
      } catch (e) {
        const msg = String(e.message || e).slice(0, 200)
        // landed-with-error or provably expired: nothing moved. Clear `pending` only if it is THIS
        // transaction's mark (a sweep or a volume-account init can fail too, and must not wipe it).
        const cur = readCoins().find(c => c.id === coin.id)
        if (/TX_FAILED|TX_NOT_LANDED/.test(msg) && e.sig && cur?.pending?.sig === e.sig) patchCoin(coin.id, { pending: null, lastError: msg })
        // CONFIRM_UNKNOWN keeps `pending`; settlePending resolves it next cycle
        else patchCoin(coin.id, { lastError: msg })
        console.warn(`[burn] $${coin.symbol}: ${msg}`)
      }
    }
    state.lastError = null
  } catch (e) {
    state.lastError = String(e.message).slice(0, 200)
    console.warn(`[burn] cycle: ${state.lastError}`)
  } finally {
    state.running = false
    state.lastDoneAt = Date.now()
    state.last = done
  }
  return done
}
