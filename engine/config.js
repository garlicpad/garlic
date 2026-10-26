// Engine config. Everything from env; no secrets in the repo.
// LIVE=false is the default. Treat any other default as a bug.
import { readFileSync, existsSync } from 'fs'

// Tiny .env loader (no dependency): KEY=value lines, # comments, no expansion. Real env wins.
if (existsSync('.env') && !process.env.GARLIC_NO_DOTENV) {
  for (const line of readFileSync('.env', 'utf-8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || line.trim().startsWith('#')) continue
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

const env = (k, d = '') => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k])
const num = (k, d) => { const v = Number(env(k, d)); return Number.isFinite(v) ? v : d }
const bool = (k, d) => /^(1|true|yes|on)$/i.test(String(env(k, d ? 'true' : 'false')))

export const config = {
  // --- brand (one place; rename the product here) ---
  brand: env('BRAND', 'garlic'),
  siteUrl: env('SITE_URL', 'https://www.usegarlic.xyz'),
  // Where each coin's metadata JSON + picture live. Written into the mint FOREVER, so it is the
  // permanent vercel.app address, not the custom domain (a lapsed domain would blank every coin).
  metaBaseUrl: env('META_BASE_URL', 'https://garlic-pad.vercel.app'),
  xUrl: env('X_URL', ''),
  // The platform's own coin (launched through the pad like every other coin)
  coinMint: env('COIN_MINT', ''),
  coinSymbol: env('COIN_SYMBOL', 'GARLIC'),
  // the platform coin's ticker and name, refused on the board in any folding
  reservedTickers: env('RESERVED_TICKERS', 'GARLIC,GARLICPAD').split(',').map(s => s.trim()).filter(Boolean),
  reservedNames: env('RESERVED_NAMES', 'garlic,garlicpad').split(',').map(s => s.trim()).filter(Boolean),

  // --- Solana ---
  // GARLIC_RPC_URL wins over SOLANA_RPC_URL, which some machines set globally for other projects
  rpcUrl: env('GARLIC_RPC_URL', env('SOLANA_RPC_URL', '')),
  priorityFeeMicroLamports: num('PRIORITY_FEE_MICROLAMPORTS', 100_000),

  // The master wallet. It pays for every launch and every network fee, and its secret derives
  // each coin's creator key. It never holds a coin's fees: those sit in the coin's own key.
  masterPrivateKey: env('MASTER_PRIVATE_KEY', ''),
  // pump.fun's own lookup table (the one its frontend uses). Keeps buy+burn under 1232 bytes.
  altAddress: env('ALT_ADDRESS', '7mFD2mUtRS65XstiSAvCJuYmdesZoQwCwRJhq1p3eRMe'),

  // --- launching ---
  launchesOpen: bool('LAUNCHES_OPEN', true),
  maxLaunchesPerHour: num('MAX_LAUNCHES_PER_HOUR', 60),     // the real bound on what spam can cost
  walletCooldownMin: num('WALLET_COOLDOWN_MIN', 60),         // one launch per wallet per this many minutes
  launcherMinSol: num('LAUNCHER_MIN_SOL', 0.01),             // the launching wallet must hold this much (spam filter, nothing is charged)
  masterFloorSol: num('MASTER_FLOOR_SOL', 0.05),             // launches pause below this; the burn crank never needs the master's SOL
  // Private send: the create goes to the Jito block engine only (bundle-only), never the public RPC path.
  jitoUrl: env('JITO_URL', 'https://mainnet.block-engine.jito.wtf'),
  jitoTipLamports: num('JITO_TIP_LAMPORTS', 200_000),
  privateSend: bool('PRIVATE_SEND', true),

  // --- anti-vamp ---
  // A ticker already trading elsewhere with this much real liquidity (USD) is refused.
  vampLiquidityUsd: num('VAMP_LIQUIDITY_USD', 20_000),
  vampMcapUsd: num('VAMP_MCAP_USD', 250_000),
  imageDistance: num('IMAGE_DISTANCE', 6),                   // dHash bits; ≤ this = the same picture

  // --- the burn crank ---
  crankMs: num('CRANK_MS', 180_000),                         // every 3 minutes
  minBuybackSol: num('MIN_BUYBACK_SOL', 0.003),              // below this a coin's fees wait for the next cycle
  maxBuybackSol: num('MAX_BUYBACK_SOL', 5),                  // per coin per cycle; the rest waits in the coin key for the next one
  privateBuybackMinSol: num('PRIVATE_BUYBACK_MIN_SOL', 0.05), // buys this big go to Jito only (no sandwich), never public
  publicSlippagePct: num('PUBLIC_SLIPPAGE_PCT', 1.5),        // smaller buys go public with less headroom to sandwich
  slippagePct: num('SLIPPAGE_PCT', 5),
  curvesRefreshMs: num('CURVES_REFRESH_MS', 30_000),

  /* --- LIVE MONEY SWITCH ---
     false (default): launches and burns build and simulate but broadcast NOTHING.
     A file named KILL in DATA_DIR stops every broadcast instantly, no restart needed. */
  live: bool('LIVE', false),

  // --- server ---
  port: num('PORT', 3214),
  host: env('HOST', '127.0.0.1'),
  dataDir: env('DATA_DIR', './data'),
  adminSecret: env('ADMIN_SECRET', ''),
  pinataJwt: env('PINATA_JWT', ''),
  corsOrigin: env('CORS_ORIGIN', '*'),
  rateWindowMs: num('RATE_WINDOW_MS', 60_000),
  rateMaxPerIp: num('RATE_MAX_PER_IP', 60),
}

export function assertConfig() {
  for (const [k, v] of [['SLIPPAGE_PCT', config.slippagePct], ['PUBLIC_SLIPPAGE_PCT', config.publicSlippagePct]]) {
    if (v <= 0 || v > 25) throw new Error(`${k} must be in (0, 25]`)
    // the SDKs scale slippage by 10 and floor it: a second decimal would push max cost over the budget
    if (Math.abs(v * 10 - Math.round(v * 10)) > 1e-9) throw new Error(`${k} takes at most one decimal (e.g. 1.5)`)
  }
  if (config.minBuybackSol < 0.001) throw new Error('MIN_BUYBACK_SOL below 0.001 SOL just burns network fees')
  if (config.crankMs < 30_000) throw new Error('CRANK_MS below 30 s hammers the RPC for nothing')
  const warn = []
  if (!config.rpcUrl) warn.push('SOLANA_RPC_URL not set — nothing on-chain will work')
  if (!config.masterPrivateKey) warn.push('MASTER_PRIVATE_KEY not set — nothing can launch and no coin key can be derived')
  if (!config.live) warn.push('LIVE=false — launches and burns simulate and broadcast NOTHING (the safe default)')
  for (const w of warn) console.warn(`[config] ${w}`)
}
