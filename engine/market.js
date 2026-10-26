// Outside market data: the SOL price, "is this ticker already trading somewhere with real money",
// and market caps of graduated coins. Read-only, cached, and every call times out.
import { config } from './config.js'
import { foldTicker } from './vamp.js'

const get = (url, ms = 8000) => fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(ms) }).then(r => (r.ok ? r.json() : null)).catch(() => null)

let solUsd = { at: 0, v: 0 }
/** SOL in USD, from two sources; the last good value is kept when both fail. */
export async function solPrice() {
  if (Date.now() - solUsd.at < 60_000 && solUsd.v) return solUsd.v
  const cb = await get('https://api.coinbase.com/v2/prices/SOL-USD/spot')
  let v = Number(cb?.data?.amount)
  if (!(v > 0)) {
    const cg = await get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd')
    v = Number(cg?.solana?.usd)
  }
  if (v > 0) solUsd = { at: Date.now(), v }
  return solUsd.v
}
export const solPriceCached = () => solUsd.v

/**
 * The biggest pair anywhere whose ticker folds to the same thing and that holds real money
 * (liquidity or market cap over the configured floors), or null. Our own coins are skipped.
 * `null` also when DexScreener does not answer: the check is about quality, not money, and a
 * launcher is never blocked by someone else's outage.
 */
export async function tradingElsewhere(ticker, ownMints = new Set()) {
  const want = foldTicker(ticker)
  if (!want) return null
  const j = await get(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(String(ticker).replace(/^\$+/, ''))}`)
  let best = null
  for (const p of j?.pairs || []) {
    if (foldTicker(p.baseToken?.symbol) !== want) continue
    if (ownMints.has(p.baseToken?.address)) continue
    const liq = Number(p.liquidity?.usd || 0)
    const mcap = Number(p.marketCap || p.fdv || 0)
    if (liq < config.vampLiquidityUsd && mcap < config.vampMcapUsd) continue
    if (!best || mcap > best.mcap) best = { symbol: p.baseToken.symbol, name: p.baseToken.name, chain: p.chainId, url: p.url, liq, mcap }
  }
  return best
}

const dexCache = new Map() // mint -> { at, mcapUsd, url }
/** Market caps of graduated coins (their curve no longer prices them). Map(mint → { mcapUsd, url }). */
export async function graduatedCaps(mints) {
  const out = new Map()
  const need = mints.filter(m => { const c = dexCache.get(m); if (c && Date.now() - c.at < 60_000) { out.set(m, c); return false } return true })
  for (let i = 0; i < need.length; i += 30) {
    const chunk = need.slice(i, i + 30)
    const j = await get(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(',')}`)
    for (const p of Array.isArray(j) ? j : []) {
      const m = p.baseToken?.address
      if (!chunk.includes(m)) continue
      const cur = out.get(m)
      const mcapUsd = Number(p.marketCap || p.fdv || 0)
      if (!cur || mcapUsd > cur.mcapUsd) { const v = { at: Date.now(), mcapUsd, url: p.url }; out.set(m, v); dexCache.set(m, v) }
    }
  }
  return out
}
