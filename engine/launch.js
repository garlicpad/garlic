// Launching a coin. The launcher signs a message in their wallet (no SOL moves from them); the
// master wallet creates the coin on pump.fun in one private transaction and pays everything.
//
// Order of operations, and why:
//   1. validate + fingerprint the picture + check the signature   (cheap, no state)
//   2. spam gates: launches open, hourly cap, wallet cooldown, balances
//   3. anti-vamp: ticker, name, X link, picture against every coin we hold; then "already trading
//      elsewhere with real money"
//   4. RESERVE under the journal lock, re-running the local checks on fresh data, so two launches
//      racing for one ticker can't both win
//   5. metadata, then ONE transaction: fund the coin key's floor + create_v2 (no buy) + pump's
//      volume account for the coin key. Signature journaled BEFORE broadcast; sent to the Jito
//      block engine only, so nobody sees the mint before it exists.
//   6. landed → live. failed / provably expired → released. unknown → settled later, never rebuilt.
import { Keypair } from '@solana/web3.js'
import { randomBytes } from 'crypto'
import { config } from './config.js'
import {
  getMaster, coinKeyFor, submit, settled, tipIx, transferSol, balanceOf, isKilled, SYSTEM_RENT_FLOOR, sol, isPubkey,
} from './solana.js'
import { createIx, initAccumulatorIx } from './pump.js'
import { validateCoin, findClash, reservedClash, foldTicker, foldName, xKey, CLASH_TEXT, HOLDING } from './vamp.js'
import { fingerprint } from './images.js'
import { checkImage, uploadMetadata, removeHosted } from './ipfs.js'
import { tradingElsewhere } from './market.js'
import { requireSigned, launchMessage, detailsHash } from './auth.js'
import { readCoins, insertCoin, patchCoin, locked } from './store.js'

const err = (code, msg, extra = {}) => Object.assign(new Error(msg), { code, ...extra })

/** A data URL or bare base64 → Buffer. */
export function decodeImage(s) {
  const m = /^data:[^;]+;base64,(.*)$/s.exec(String(s || ''))
  const b64 = m ? m[1] : String(s || '')
  if (!b64) throw err(400, 'a picture is required')
  const buf = Buffer.from(b64, 'base64')
  checkImage({ buffer: buf })
  return buf
}

const FAILS_PER_WALLET_HOUR = 5
// Launches this process is working on right now: the reconciler leaves them alone.
const inFlight = new Set()
const bootAt = Date.now()

/** The spam gates. Pure over the coin list. */
export function gate(coins, wallet, now = Date.now()) {
  // Only launches that got as far as a signature count against the hourly cap: a request that
  // fails validation or simulation costs the master nothing, so it must not be able to fill the line.
  const lastHour = coins.filter(c => c.createdAt > now - 3600_000 && c.sig)
  if (lastHour.length >= config.maxLaunchesPerHour) throw err(429, 'the launch line is full this hour, try again in a few minutes')
  const fails = coins.filter(c => c.launcher === wallet && c.status === 'failed' && !c.sig && c.createdAt > now - 3600_000)
  if (fails.length >= FAILS_PER_WALLET_HOUR) throw err(429, 'too many failed launches from this wallet, try again in an hour')
  const cool = config.walletCooldownMin * 60_000
  const mine = coins.filter(c => c.launcher === wallet && HOLDING.has(c.status) && c.createdAt > now - cool)
  if (mine.length) {
    const wait = Math.ceil((mine[0].createdAt + cool - now) / 60_000)
    throw err(429, `one launch per wallet every ${config.walletCooldownMin} minutes, try again in ${wait} min`)
  }
}

const RESERVED = () => ({ tickers: config.reservedTickers, names: config.reservedNames })
const reservedText = rule => (rule === 'ticker' ? `$${config.coinSymbol} is garlic's own coin. Pick a ticker of your own.` : `that name belongs to garlic's own coin.`)

/** The local anti-vamp check, as a refusal the site can show. */
export function clashError(coins, cand) {
  const r = reservedClash(RESERVED(), cand)
  if (r) return err(409, reservedText(r.rule), { rule: r.rule })
  const c = findClash(coins, cand, config.imageDistance)
  if (!c) return null
  return err(409, CLASH_TEXT[c.rule](c.symbol), { rule: c.rule, mint: c.mint })
}

/** A dry check for the create form, as the launcher types. Nothing is reserved. */
export async function checkCoin({ symbol, name, x, image }) {
  const coins = readCoins()
  const cand = { ticker: symbol || '', name: name || '', x: x ? xKey(x) : null }
  if (image) Object.assign(cand, await fingerprint(decodeImage(image)))
  const out = { ticker: 'ok', name: 'ok', x: 'ok', picture: image ? 'ok' : null }
  // each rule on its own, so the form can mark every field
  const owned = (rule, part) => {
    const c = findClash(coins, { ticker: '\u0000', name: '', x: null, ...part }, config.imageDistance)
    return c && c.rule === rule ? CLASH_TEXT[rule](c.symbol) : 'ok'
  }
  if (symbol) {
    if (!foldTicker(symbol)) out.ticker = 'needs at least one letter or number'
    else {
      const c = findClash(coins, { ticker: symbol, name: '', x: null }, config.imageDistance)
      out.ticker = reservedClash(RESERVED(), { ticker: symbol, name: '' }) ? reservedText('ticker') : c?.rule === 'ticker' ? CLASH_TEXT.ticker(c.symbol) : 'ok'
      if (out.ticker === 'ok') {
        const ext = await tradingElsewhere(symbol, new Set(coins.map(c2 => c2.mint).filter(Boolean)))
        if (ext) out.ticker = elsewhereText(ext)
      }
    }
  }
  if (name && foldName(name)) out.name = reservedClash(RESERVED(), { ticker: '', name }) ? reservedText('name') : owned('name', { name })
  if (cand.x) out.x = owned('x', { x: cand.x })
  else if (x) out.x = 'must be an x.com post, account or community'
  if (image) out.picture = owned('picture', { imgSha: cand.imgSha, imgHash: cand.imgHash })
  return out
}

const usd = n => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}k`)
const elsewhereText = e => `$${e.symbol} already trades on ${e.chain} at ${usd(e.mcap || e.liq)}. Pick a ticker of your own.`

/**
 * The create transaction's instructions: (Jito tip) + the coin key's floor + create_v2 with the
 * coin key as creator and no buy + pump's volume account for the coin key. All paid by `m`.
 */
export async function createTxIxs({ m, coinKey, mint, name, symbol, uri }) {
  const ixs = []
  if (config.privateSend) ixs.push(tipIx(m, config.jitoTipLamports))
  ixs.push(transferSol(m, coinKey, SYSTEM_RENT_FLOOR))
  ixs.push(await createIx({ mint, name, symbol, uri, creator: coinKey, payer: m }))
  ixs.push(await initAccumulatorIx(coinKey, m, false))
  return ixs
}

/** The whole launch. Returns the public coin (or { dryRun }) — throws a coded error otherwise. */
export async function launchCoin(body) {
  if (!config.launchesOpen) throw err(503, 'launches are paused')
  if (isKilled()) throw err(503, 'launches are paused')
  const master = getMaster()
  if (!master) throw err(503, 'the master wallet is not configured')

  const d = validateCoin(body)
  const wallet = String(body.wallet || '')
  if (!isPubkey(wallet)) throw err(400, 'connect a wallet first')
  const buf = decodeImage(body.image)
  const fp = await fingerprint(buf)
  requireSigned(wallet, launchMessage({ brand: config.brand, name: d.name, symbol: d.symbol, imageSha: fp.imgSha, details: detailsHash(d), ts: body.ts }), body.signature, body.ts)

  // 2. spam gates
  gate(readCoins(), wallet)
  const [masterBal, launcherBal] = await Promise.all([balanceOf(master.publicKey), balanceOf(wallet)])
  if (sol(masterBal) < config.masterFloorSol) throw err(503, 'launches are paused while the master wallet is topped up')
  if (sol(launcherBal) < config.launcherMinSol) throw err(403, `your wallet needs at least ${config.launcherMinSol} SOL in it to launch (nothing is charged)`)

  // 3. anti-vamp
  const cand = { ticker: d.symbol, name: d.name, x: d.x ? xKey(d.x) : null, ...fp }
  const c1 = clashError(readCoins(), cand)
  if (c1) throw c1
  const ext = await tradingElsewhere(d.symbol, new Set(readCoins().map(c => c.mint).filter(Boolean)))
  if (ext) throw err(409, elsewhereText(ext), { rule: 'elsewhere', url: ext.url })

  // 4. reserve, atomically
  const id = randomBytes(12).toString('hex')
  const key = coinKeyFor(id)
  const coin = locked(() => {
    const coins = readCoins()
    gate(coins, wallet)
    const c2 = clashError(coins, cand)
    if (c2) throw c2
    return insertCoin({
      id, status: 'reserved', createdAt: Date.now(),
      name: d.name, symbol: d.symbol, description: d.description,
      links: { x: d.x || null, telegram: d.telegram || null, website: d.website || null },
      launcher: wallet, coinKey: key.publicKey.toBase58(), mint: null,
      folds: { ticker: foldTicker(d.symbol), name: foldName(d.name), x: cand.x, imgSha: fp.imgSha, imgHash: fp.imgHash },
      burn: { count: 0, tokens: 0, sol: 0 },
    })
  })

  // 5. metadata + the one transaction
  inFlight.add(id)
  let meta = null
  try {
    meta = await uploadMetadata({ buffer: buf }, { name: d.name, symbol: d.symbol, description: d.description, twitter: d.x, telegram: d.telegram, website: d.website })
    const mintKp = Keypair.generate()
    const mint = mintKp.publicKey.toBase58()
    patchCoin(id, { mint, uri: meta.uri, image: meta.image })
    const ixs = await createTxIxs({ m: master.publicKey.toBase58(), coinKey: coin.coinKey, mint, name: d.name, symbol: d.symbol, uri: meta.uri })
    const res = await submit({
      payer: master.publicKey, instructions: ixs, signers: [master, mintKp], units: 260_000,
      what: `create $${d.symbol}`, private: config.privateSend,
      onSig: (sig, lvbh) => patchCoin(id, { status: 'sending', sig, lvbh }),
    })
    if (res.dryRun) {
      patchCoin(id, { status: 'failed', lastError: 'dry run: simulated, not sent' })
      removeHosted(meta)
      return { dryRun: true, mint, symbol: d.symbol, unitsConsumed: res.sim?.unitsConsumed ?? null }
    }
    // It landed. If recording that fails, the record stays 'sending' and the reconciler marks it live.
    try { return patchCoin(id, { status: 'live', launchedAt: Date.now(), lastError: null }) } catch (e) {
      console.error(`[launch] $${d.symbol} landed (${res.sig}) but could not be marked live: ${e.message}`)
      return { ...coin, mint, sig: res.sig, status: 'live', launchedAt: Date.now() }
    }
  } catch (e) {
    const msg = String(e.message || e).slice(0, 200)
    let signed = null
    try { signed = readCoins().find(c => c.id === id)?.sig || null } catch {}
    // Once a signature exists, only a landed-with-error or a provably expired transaction is a failure.
    // Anything else is an unknown fate: the reconciler settles it against the chain, never a rebuild.
    if (signed && !/TX_FAILED|TX_NOT_LANDED/.test(msg)) {
      try { patchCoin(id, { status: 'unknown', lastError: msg }) } catch {}
      throw err(202, 'sent, waiting for the chain to confirm it. It shows up on the board when it lands.', { id })
    }
    try { patchCoin(id, { status: 'failed', lastError: msg }) } catch {}
    if (!signed && meta) removeHosted(meta)
    throw err(e.code && e.code < 500 ? e.code : 502, `launch failed: ${msg}`)
  } finally {
    inFlight.delete(id)
  }
}

/** Launches whose fate is unknown, or that died mid-flight: settle them against the chain. */
export async function reconcileLaunches() {
  for (const c of readCoins()) {
    if (inFlight.has(c.id)) continue
    // a reservation that never got a signature, left by an earlier process (this one would be in flight)
    if (c.status === 'reserved' && !c.sig && c.createdAt < bootAt) {
      patchCoin(c.id, x => (x.status === 'reserved' && !x.sig ? { status: 'failed', lastError: 'never sent (engine restarted mid-launch)' } : {}))
      continue
    }
    if (c.sig && (c.status === 'sending' || c.status === 'unknown' || (c.status === 'failed' && !c.settledFailed))) {
      // 'failed' with a signature is re-checked too: a landed create must never stay released
      const s = await settled(c.sig, c.lvbh)
      if (s === true && c.status !== 'live') patchCoin(c.id, { status: 'live', launchedAt: c.launchedAt || Date.now(), lastError: null })
      else if (s === false && c.status !== 'failed') patchCoin(c.id, { status: 'failed', lastError: 'the create never landed' })
      else if (s === false && c.status === 'failed') patchCoin(c.id, { settledFailed: true })
    }
  }
}
