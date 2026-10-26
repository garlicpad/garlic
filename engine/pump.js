// pump.fun wrappers for SOL-quoted coins (@pump-fun/pump-sdk 4.2 + pump-swap-sdk 1.20).
//
// The money model in one paragraph: every coin is created with `user` = the master wallet (it pays
// the rent, there is no dev buy) and `creator` = the coin's own derived key. pump.fun pays that
// coin's creator fees into that key's vaults (the curve's lamport vault, and PumpSwap's WSOL vault
// after graduation) and nowhere else. Every cycle, ONE transaction collects them into the coin key,
// buys the coin with all of it at an EXACT token amount, and burns exactly that amount. It lands
// whole or not at all: there is never a bought-but-unburned state to recover from.
import BN from 'bn.js'
import { createRequire } from 'module'
import { PublicKey } from '@solana/web3.js'
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createBurnCheckedInstruction, createCloseAccountInstruction,
} from '@solana/spl-token'
import { getConnection, pk } from './solana.js'

// The SDKs' ESM builds import a named `BN` from Anchor's CommonJS module, which Node 22 cannot
// see. Their CommonJS builds work on every Node: load those.
const require = createRequire(import.meta.url)
const {
  PUMP_SDK, OnlinePumpSdk, bondingCurvePda, creatorVaultPda, canonicalPumpPoolPda, PUMP_PROGRAM_ID,
  getBuyTokenAmountFromSolAmount, bondingCurveMarketCap, userVolumeAccumulatorPda: curveAccumulatorPda,
} = require('@pump-fun/pump-sdk')
const {
  OnlinePumpAmmSdk, PUMP_AMM_SDK, buyQuoteInput, coinCreatorVaultAuthorityPda, coinCreatorVaultAtaPda, PUMP_AMM_PROGRAM_ID,
  userVolumeAccumulatorPda: ammAccumulatorPda,
} = require('@pump-fun/pump-swap-sdk')

export { bondingCurvePda, creatorVaultPda, canonicalPumpPoolPda, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID }
export const DECIMALS = 6

let _online = null, _onlineAmm = null
export function online() { if (!_online) _online = new OnlinePumpSdk(getConnection()); return _online }
export function onlineAmm() { if (!_onlineAmm) _onlineAmm = new OnlinePumpAmmSdk(getConnection()); return _onlineAmm }

let ctxCache = null
export async function ctx() {
  if (ctxCache && Date.now() - ctxCache.at < 60_000) return ctxCache
  const [global, feeConfig] = await Promise.all([online().fetchGlobal(), online().fetchFeeConfig()])
  ctxCache = { at: Date.now(), global, feeConfig }
  return ctxCache
}

/** The program that owns a mint. pump's create_v2 coins are Token-2022, but read it. */
const programCache = new Map()
export async function tokenProgramOf(mint) {
  const key = String(mint)
  if (programCache.has(key)) return programCache.get(key)
  const info = await getConnection().getAccountInfo(pk(mint), 'confirmed')
  if (!info) throw new Error(`mint ${mint} does not exist`)
  let p
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) p = TOKEN_2022_PROGRAM_ID
  else if (info.owner.equals(TOKEN_PROGRAM_ID)) p = TOKEN_PROGRAM_ID
  else throw new Error(`mint ${mint} is owned by ${info.owner.toBase58()}, not a token program`)
  programCache.set(key, p)
  return p
}

/* ---------------- the launch ---------------- */

/** `create_v2`, SOL-quoted, no buy. The master pays; the coin key is the creator. */
export async function createIx({ mint, name, symbol, uri, creator, payer }) {
  return PUMP_SDK.createV2Instruction({
    mint: pk(mint), name, symbol, uri,
    creator: pk(creator),
    user: pk(payer),
    mayhemMode: false, // mayhem doubles supply and lets pump's agent trade the coin on its own
  })
}

/**
 * pump keeps a per-trader volume account (curve and PumpSwap each have one). A buy creates it on
 * first use and the BUYER pays its rent, which would come out of a coin's fees. The master creates
 * it instead: at launch for the curve, at the first graduated cycle for PumpSwap.
 */
export const accumulatorOf = (user, amm = false) => (amm ? ammAccumulatorPda(pk(user)) : curveAccumulatorPda(pk(user)))
export async function initAccumulatorIx(user, payer, amm = false) {
  return amm
    ? PUMP_AMM_SDK.initUserVolumeAccumulator({ payer: pk(payer), user: pk(user) })
    : PUMP_SDK.initUserVolumeAccumulator({ payer: pk(payer), user: pk(user) })
}

/* ---------------- the fee vaults ---------------- */

/** The PumpSwap WSOL vault that holds a graduated coin's creator fees for `creator`. */
export function ammVaultAta(creator) {
  return coinCreatorVaultAtaPda(coinCreatorVaultAuthorityPda(pk(creator)), NATIVE_MINT, TOKEN_PROGRAM_ID)
}

let rentCache = null
/** Rent-exempt minimum of a 0-byte account (what the curve vault must keep). */
export async function rent0() {
  if (rentCache) return rentCache
  rentCache = BigInt(await getConnection().getMinimumBalanceForRentExemption(0))
  return rentCache
}

/**
 * Everything waiting for each creator key, read in batches:
 * Map(creator → { key, curve, amm, ammAtaExists, total }) — lamports, BigInt.
 * `key` is the coin key's own balance (it always keeps the 890,880 floor; anything above is unspent fees).
 */
export async function readVaults(creators) {
  const conn = getConnection()
  const r0 = await rent0()
  const out = new Map()
  for (let i = 0; i < creators.length; i += 33) {
    const chunk = creators.slice(i, i + 33)
    const addrs = chunk.flatMap(c => [pk(c), creatorVaultPda(pk(c)), ammVaultAta(c)])
    const infos = await conn.getMultipleAccountsInfo(addrs, 'confirmed')
    chunk.forEach((c, j) => {
      const [k, v, a] = infos.slice(j * 3, j * 3 + 3)
      const key = BigInt(k?.lamports ?? 0)
      const curve = v ? BigInt(v.lamports) - r0 : 0n
      // A WSOL token account: the amount is the u64 at offset 64.
      let amm = 0n
      if (a && a.owner.equals(TOKEN_PROGRAM_ID) && a.data.length >= 72) amm = a.data.readBigUInt64LE(64)
      out.set(c, { key, curve: curve > 0n ? curve : 0n, amm, ammAtaExists: !!a, total: (curve > 0n ? curve : 0n) + amm })
    })
  }
  return out
}

/**
 * Collect a coin's fees into its coin key, as lamports. The coin key signs as creator and as
 * payer, so the SDK's AMM leg creates the key's WSOL account, collects into it and closes it again
 * (unwrapping) in the same transaction; the WSOL rent for that moment comes from a loan the
 * master makes inside the same transaction (see burn.js). Legs with nothing in them are left out.
 */
export async function collectIxs(coinKey, { curve = false, amm = false } = {}) {
  if (!curve && !amm) return []
  const all = await online().collectCoinCreatorFeeInstructions(pk(coinKey), pk(coinKey))
  return all.filter(ix => (ix.programId.equals(PUMP_PROGRAM_ID) ? curve : amm))
}
export const wsolAtaOf = owner => getAssociatedTokenAddressSync(NATIVE_MINT, pk(owner), true, TOKEN_PROGRAM_ID)

/**
 * Every WSOL token account the coin key owns. PumpSwap's collect does not need the creator's
 * signature and pays into ANY WSOL account the creator owns, so a stranger can move a graduated
 * coin's fees out of the vault the planner reads into an account of their choosing (still ours,
 * but invisible). The crank closes all of them into the coin key before planning.
 * → [{ address, lamports }]
 */
export async function wsolAccountsOf(owner) {
  const r = await getConnection().getTokenAccountsByOwner(pk(owner), { mint: NATIVE_MINT }, 'confirmed')
  return r.value.map(a => ({ address: a.pubkey.toBase58(), lamports: BigInt(a.account.lamports) }))
}
/** Close a token account the coin key owns, every lamport (WSOL + rent) into the coin key. */
export const closeIntoOwnerIx = (account, owner) => createCloseAccountInstruction(pk(account), pk(owner), pk(owner), [], TOKEN_PROGRAM_ID)

/* ---------------- the buyback ---------------- */

export const ataOf = (mint, owner, program) => getAssociatedTokenAddressSync(pk(mint), pk(owner), true, program)

/**
 * Pure: the size of a buy that can never take more than `budget` lamports. The program is told
 * it may spend `size × (1 + slippage)`, so the size is cut to leave that headroom inside the budget.
 */
export function sizeForBudget(budget, slippagePct) {
  const b = BigInt(budget)
  if (b <= 0n) return 0n
  return (b * 1000n) / BigInt(1000 + Math.floor(slippagePct * 10))
}

/**
 * A curve buy of EXACT `tokens` paid by the coin key, max cost ≤ budget. The token account is
 * created (idempotently) by the master, so the coin's fees pay for the coin and nothing else.
 * Throws { graduated } once the curve is complete.
 */
export async function curveBuyExact({ mint, coinKey, payer, budget, slippagePct }) {
  const { global, feeConfig } = await ctx()
  const tokenProgram = await tokenProgramOf(mint)
  const st = await online().fetchBuyState(pk(mint), pk(coinKey), tokenProgram, NATIVE_MINT)
  const bc = st.bondingCurve
  if (bc.complete || bc.virtualTokenReserves.isZero()) throw Object.assign(new Error('curve is complete'), { graduated: true })
  const size = sizeForBudget(budget, slippagePct)
  const tokens = BigInt(getBuyTokenAmountFromSolAmount({
    global, feeConfig, mintSupply: bc.tokenTotalSupply, bondingCurve: bc,
    amount: new BN(size.toString()), quoteMint: NATIVE_MINT,
  }).toString())
  if (tokens <= 0n) return null
  const ata = ataOf(mint, coinKey, tokenProgram)
  const ixs = [createAssociatedTokenAccountIdempotentInstruction(pk(payer), ata, pk(coinKey), pk(mint), tokenProgram)]
  // associatedUserAccountInfo: non-null tells the SDK not to add its own create (paid by the coin key)
  ixs.push(...await PUMP_SDK.buyInstructions({
    global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: bc,
    associatedUserAccountInfo: st.associatedUserAccountInfo || { lamports: 1 },
    mint: pk(mint), user: pk(coinKey), amount: new BN(tokens.toString()), solAmount: new BN(size.toString()),
    slippage: slippagePct, tokenProgram,
  }))
  const maxSol = size + (size * BigInt(Math.floor(slippagePct * 10))) / 1000n // the SDK's own formula
  if (maxSol > BigInt(budget)) throw new Error(`curve buy: max cost ${maxSol} above budget ${budget}`)
  return { route: 'curve', tokens, maxSol, ixs, tokenProgram, ata }
}

/**
 * A PumpSwap buy of EXACT `tokens` (base out) paid by the coin key from SOL, max quote ≤ budget.
 * The SDK wraps the SOL into the coin key's WSOL account and closes it again in the same tx; the
 * WSOL account's rent is borrowed from the budget for the length of the transaction.
 */
export async function ammBuyExact({ mint, coinKey, payer, budget, slippagePct, wsolRent }) {
  const tokenProgram = await tokenProgramOf(mint)
  const poolKey = canonicalPumpPoolPda(pk(mint))
  let st
  try { st = await onlineAmm().swapSolanaState(poolKey, pk(coinKey)) } catch (e) {
    if (/Pool account not found/i.test(String(e.message))) throw Object.assign(new Error('migrating to PumpSwap'), { migrating: true })
    throw e
  }
  // The collect leg earlier in the same transaction closes the key's WSOL account, so the buy must
  // always create (and close) its own: never trust the account's state at build time.
  st = { ...st, userQuoteAccountInfo: null }
  const room = BigInt(budget) - BigInt(wsolRent)
  const size = sizeForBudget(room, slippagePct)
  if (size <= 0n) return null
  const common = {
    baseReserve: st.poolBaseAmount, quoteReserve: st.poolQuoteAmount, virtualQuoteReserves: st.pool.virtualQuoteReserves,
    globalConfig: st.globalConfig, baseMintAccount: st.baseMintAccount, baseMint: st.baseMint, coinCreator: st.pool.coinCreator,
    creator: st.pool.creator, feeConfig: st.feeConfig, quoteMint: st.pool.quoteMint, isMayhemMode: st.pool.isMayhemMode, creatorFeeBps: st.pool.creatorFeeBps,
  }
  const q = buyQuoteInput({ ...common, quote: new BN(size.toString()), slippage: slippagePct })
  const tokens = BigInt(q.base.toString())
  const maxSol = BigInt(q.maxQuote.toString())
  if (tokens <= 0n) return null
  if (maxSol > room) throw new Error(`amm buy: max quote ${maxSol} above budget ${room}`)
  const ata = ataOf(mint, coinKey, tokenProgram)
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(pk(payer), ata, pk(coinKey), pk(mint), tokenProgram),
    ...await PUMP_AMM_SDK.buyInstructions(st, q.base, q.maxQuote),
  ]
  return { route: 'amm', tokens, maxSol, ixs, tokenProgram, ata }
}

/** Burn exactly `tokens` from the coin key's account. The supply goes down. */
export const burnIx = ({ ata, mint, coinKey, tokens, tokenProgram }) =>
  createBurnCheckedInstruction(ata, pk(mint), pk(coinKey), BigInt(tokens), DECIMALS, [], tokenProgram)

/* ---------------- curves, for the board ---------------- */

export function decodeCurve(info) {
  if (!info) return null
  try { return PUMP_SDK.decodeBondingCurveNullable(info) } catch { return null }
}

/** The numbers the board shows. A graduated curve has its reserves zeroed: guarded here. */
export function curveFigures(bc, global) {
  if (!bc) return null
  const vt = Number(bc.virtualTokenReserves.toString())
  if (bc.complete || vt <= 0) return { mcapSol: null, progress: 1, graduated: true }
  const mcapRaw = bondingCurveMarketCap({
    mintSupply: bc.tokenTotalSupply, virtualQuoteReserves: bc.virtualQuoteReserves, virtualTokenReserves: bc.virtualTokenReserves,
  })
  const initial = Number(global.initialRealTokenReserves.toString())
  const real = Number(bc.realTokenReserves.toString())
  return {
    mcapSol: Number(mcapRaw.toString()) / 1e9,
    progress: initial > 0 ? Math.min(1, Math.max(0, (initial - real) / initial)) : 0,
    graduated: false,
    supply: Number(bc.tokenTotalSupply.toString()) / 10 ** DECIMALS,
  }
}

/** Read many curves in one call; one bad curve never takes the others down. */
export async function readCurves(mints) {
  const out = new Map()
  if (!mints.length) return out
  const { global } = await ctx()
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100)
    const infos = await getConnection().getMultipleAccountsInfo(chunk.map(m => bondingCurvePda(pk(m))), 'confirmed')
    chunk.forEach((m, j) => { try { out.set(m, curveFigures(decodeCurve(infos[j]), global)) } catch { out.set(m, null) } })
  }
  return out
}

/** Live token supply (it only goes down here). Map(mint → number). */
export async function readSupplies(mints) {
  const out = new Map()
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100)
    const infos = await getConnection().getMultipleAccountsInfo(chunk.map(m => pk(m)), 'confirmed')
    chunk.forEach((m, j) => {
      const d = infos[j]?.data
      // SPL / Token-2022 mint: supply is the u64 at offset 36
      if (d && d.length >= 44) out.set(m, Number(d.readBigUInt64LE(36)) / 10 ** DECIMALS)
    })
  }
  return out
}

export const NATIVE = NATIVE_MINT
export const isPumpProgram = id => new PublicKey(id).equals(PUMP_PROGRAM_ID)
