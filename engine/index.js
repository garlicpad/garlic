// The engine: HTTP API for the site, plus three cranks.
//
//   burns      every 3 min: every live coin's fees buy it back and burn it (burn.js)
//   launches   every 20 s: settle any launch whose create had an unknown fate (launch.js)
//   board      every 30 s: curve figures, supplies and graduated market caps for the board
//
// Nothing broadcasts until LIVE=true. A file named KILL in DATA_DIR stops every broadcast.
import express from 'express'
import { config, assertConfig } from './config.js'
import { masterAddress, balanceOf, sol, isKilled, getMaster } from './solana.js'
import { readCurves, readSupplies } from './pump.js'
import { crankBurns, crankStatus } from './burn.js'
import { launchCoin, checkCoin, reconcileLaunches } from './launch.js'
import { launchMessage, detailsHash } from './auth.js'
import { validateCoin } from './vamp.js'
import { readHosted } from './ipfs.js'
import { readCoins, readReceipts, coinByMint, burnTotals } from './store.js'
import { solPrice, solPriceCached, graduatedCaps } from './market.js'
import { rateLimit, sweepLimiter } from './limit.js'

assertConfig()

const app = express()
app.set('trust proxy', true)
app.use(express.json({ limit: '8mb' }))
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', config.corsOrigin)
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Secret')
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  const code = e.code && Number.isInteger(e.code) ? e.code : 500
  if (code >= 500) console.error('[api]', e)
  res.set('Cache-Control', 'no-store')
  res.status(code).json({ error: String(e.message || 'failed').slice(0, 300), ...(e.rule ? { rule: e.rule } : {}), ...(e.mint ? { mint: e.mint } : {}), ...(e.url ? { url: e.url } : {}), ...(e.id ? { id: e.id } : {}) })
})
const edge = (res, seconds) => res.set('Cache-Control', `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=${seconds * 3}`)
const noStore = res => res.set('Cache-Control', 'no-store')
const requireAdmin = (req, res) => {
  if (!config.adminSecret || req.get('X-Admin-Secret') !== config.adminSecret) { res.status(403).json({ error: 'forbidden' }); return false }
  return true
}

/* ---------------- the board's figures, refreshed by a crank ---------------- */

const board = { at: 0, figures: new Map(), supplies: new Map(), caps: new Map() }
async function refreshBoard() {
  const coins = readCoins().filter(c => c.status === 'live' && c.mint)
  if (!coins.length) { board.at = Date.now(); return }
  const mints = coins.map(c => c.mint)
  const [figures, supplies] = await Promise.all([readCurves(mints), readSupplies(mints)])
  const grads = mints.filter(m => !figures.get(m) || figures.get(m).graduated)
  const caps = grads.length ? await graduatedCaps(grads) : new Map()
  await solPrice()
  Object.assign(board, { at: Date.now(), figures, supplies, caps })
}

const INITIAL_SUPPLY = 1_000_000_000
const short = a => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : null)

/** What the site may see of a coin. No folds, no signatures in flight, no reservations. */
function publicCoin(c) {
  const f = board.figures.get(c.mint) || null
  const supply = board.supplies.get(c.mint) ?? null
  const usd = solPriceCached()
  const graduated = !!(f?.graduated)
  const mcapUsd = graduated ? (board.caps.get(c.mint)?.mcapUsd ?? null) : (f?.mcapSol != null && usd ? f.mcapSol * usd : null)
  return {
    mint: c.mint, name: c.name, symbol: c.symbol, description: c.description, image: c.image ? `/api/img/${c.mint}` : null,
    links: c.links, launcher: c.launcher, launcherShort: short(c.launcher), coinKey: c.coinKey,
    launchedAt: c.launchedAt || c.createdAt, sig: c.sig || null,
    mcapSol: f?.mcapSol ?? null, mcapUsd, progress: f?.progress ?? null, graduated,
    supply, burnedPct: supply != null ? Math.max(0, (INITIAL_SUPPLY - supply) / INITIAL_SUPPLY) : 0,
    burn: burnTotals().get(c.mint) || { count: 0, tokens: 0, sol: 0, lastAt: 0 }, lastBurnAt: burnTotals().get(c.mint)?.lastAt || null,
  }
}

const liveCoins = () => readCoins().filter(c => c.status === 'live' && c.mint)
const SORTS = {
  new: (a, b) => b.launchedAt - a.launchedAt,
  mcap: (a, b) => (b.mcapUsd || 0) - (a.mcapUsd || 0),
  burned: (a, b) => (b.burn.sol || 0) - (a.burn.sol || 0),
  graduating: (a, b) => (b.graduated ? -1 : b.progress || 0) - (a.graduated ? -1 : a.progress || 0),
}

/* ---------------- public ---------------- */

app.get('/api/health', (_req, res) => { noStore(res); res.json({ ok: true, brand: config.brand, live: config.live }) })

app.get('/api/stats', wrap(async (_req, res) => {
  const coins = liveCoins()
  const receipts = readReceipts()
  edge(res, 5)
  res.json({
    brand: config.brand, live: config.live, killed: isKilled(), launchesOpen: config.launchesOpen,
    master: masterAddress(), coinMint: config.coinMint || null, coinSymbol: config.coinSymbol, xUrl: config.xUrl || null,
    coins: coins.length,
    burning: coins.filter(c => burnTotals().has(c.mint)).length,
    solBoughtBack: receipts.reduce((s, r) => s + (r.sol || 0), 0),
    buybacks: receipts.length,
    solUsd: solPriceCached(),
    crank: crankStatus(),
    rules: { cooldownMin: config.walletCooldownMin, launcherMinSol: config.launcherMinSol, crankMin: config.crankMs / 60_000 },
  })
}))

app.get('/api/coins', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase()
  const sort = SORTS[req.query.sort] ? String(req.query.sort) : 'new'
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60))
  let list = liveCoins().map(publicCoin)
  if (q) list = list.filter(c => c.symbol.toLowerCase().includes(q.replace(/^\$/, '')) || c.name.toLowerCase().includes(q) || c.mint === q)
  list.sort(SORTS[sort])
  edge(res, 5)
  res.json({ coins: list.slice(0, limit), total: list.length, boardAt: board.at })
}))

app.get('/api/coins/:mint', wrap(async (req, res) => {
  const c = coinByMint(req.params.mint)
  if (!c || c.status !== 'live') throw Object.assign(new Error('no such coin'), { code: 404 })
  edge(res, 5)
  res.json({ coin: publicCoin(c), receipts: readReceipts().filter(r => r.mint === c.mint).slice(-50).reverse() })
}))

app.get('/api/receipts', wrap(async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
  const all = readReceipts()
  edge(res, 5)
  res.json({ receipts: all.slice(-limit).reverse(), total: all.length })
}))

// Metadata JSON + pictures the engine hosts for each coin (the URI written into the mint).
app.get('/api/m/:name', wrap(async (req, res) => {
  const f = readHosted(req.params.name)
  if (!f) throw Object.assign(new Error('not found'), { code: 404 })
  res.set('Content-Type', f.type)
  res.set('Cache-Control', 'public, max-age=31536000, immutable')
  res.send(f.body)
}))

// A coin's picture by mint, for the board.
app.get('/api/img/:mint', wrap(async (req, res) => {
  const c = coinByMint(req.params.mint)
  const name = c?.image ? String(c.image).split('/').pop() : null
  const f = name ? readHosted(name) : null
  if (f) {
    res.set('Content-Type', f.type)
    res.set('Cache-Control', 'public, max-age=31536000, immutable')
    return res.send(f.body)
  }
  if (c?.image && /^https:\/\//.test(c.image)) return res.redirect(302, c.image)
  throw Object.assign(new Error('not found'), { code: 404 })
}))

// The exact message a launcher signs (the site builds it the same way; this keeps them in step).
app.post('/api/launch-message', wrap(async (req, res) => {
  noStore(res)
  const b = req.body || {}
  let d
  try { d = validateCoin(b) } catch (e) { d = { name: String(b.name || '').trim(), symbol: String(b.symbol || '').trim().replace(/^\$+/, ''), description: '', x: '', telegram: '', website: '' } }
  res.json({ message: launchMessage({ brand: config.brand, name: d.name, symbol: d.symbol, imageSha: String(b.imageSha || ''), details: detailsHash(d), ts: Number(b.ts) }) })
}))

app.post('/api/check', rateLimit({ cost: 2 }), wrap(async (req, res) => {
  noStore(res)
  res.json(await checkCoin(req.body || {}))
}))

app.post('/api/launch', rateLimit({ cost: 10 }), wrap(async (req, res) => {
  noStore(res)
  const out = await launchCoin(req.body || {})
  if (out.dryRun) return res.json(out)
  refreshBoard().catch(() => {})
  res.json({ coin: publicCoin(out) })
}))

/* ---------------- admin ---------------- */

app.get('/api/admin/status', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return
  noStore(res)
  const m = getMaster()
  const coins = readCoins()
  res.json({
    live: config.live, killed: isKilled(), master: masterAddress(), masterSol: m ? sol(await balanceOf(m.publicKey)) : null,
    crank: crankStatus(),
    coins: coins.map(c => ({ id: c.id, symbol: c.symbol, mint: c.mint, status: c.status, pending: c.pending || null, lastError: c.lastError || null, burn: burnTotals().get(c.mint) || null })),
  })
}))
app.post('/api/admin/crank', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return
  noStore(res)
  res.json({ done: await crankBurns() })
}))

/* ---------------- cranks ---------------- */

const busy = new Set()
const every = (name, ms, fn) => {
  const tick = async () => {
    if (busy.has(name)) return
    busy.add(name)
    try { await fn() } catch (e) { console.warn(`[${name}]`, String(e.message).slice(0, 160)) } finally { busy.delete(name) }
  }
  setTimeout(tick, 3000)
  setInterval(tick, ms)
}

if (!process.env.GARLIC_NO_CRANKS) {
  every('board', config.curvesRefreshMs, refreshBoard)
  every('launches', 20_000, reconcileLaunches)
  every('burns', config.crankMs, crankBurns)
}
setInterval(sweepLimiter, 5 * 60_000)
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e?.message || e))
process.on('uncaughtException', e => console.error('[uncaughtException]', e?.message || e))

app.listen(config.port, config.host, () => {
  console.log(`[engine] ${config.brand} on ${config.host}:${config.port}, LIVE=${config.live}, master ${masterAddress() || '(none)'}`)
})
