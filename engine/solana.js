// Solana plumbing: one Connection with timeouts, the master key, per-coin creator keys derived
// from it, a tx serializer, and a confirm-by-polling sender (public RPC or Jito bundle-only).
//
// The rules that matter: every RPC call times out, only one engine-built transaction is in flight
// at a time, and a send is never rebuilt on timeout: the same bytes are rebroadcast until they land
// or the blockhash provably expired.
import { Connection, Keypair, PublicKey, VersionedTransaction, TransactionMessage, ComputeBudgetProgram, LAMPORTS_PER_SOL, SystemProgram } from '@solana/web3.js'
import { createHmac } from 'crypto'
import { existsSync } from 'fs'
import { join } from 'path'
import bs58 from 'bs58'
import { config } from './config.js'

export const sol = l => Number(l) / LAMPORTS_PER_SOL
export const toLamports = s => BigInt(Math.round(Number(s) * LAMPORTS_PER_SOL))
export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
// A system account must hold at least this or nothing at all. Every coin key keeps exactly this
// much forever (paid by the master at launch), so a buyback can spend everything above it.
export const SYSTEM_RENT_FLOOR = 890_880n

const timedFetch = (url, opts = {}) => fetch(url, { ...opts, signal: opts.signal || AbortSignal.timeout(30_000) })

let _conn = null
export function getConnection() {
  if (!_conn) {
    if (!config.rpcUrl) throw new Error('SOLANA_RPC_URL not set')
    _conn = new Connection(config.rpcUrl, { commitment: 'confirmed', fetch: timedFetch })
  }
  return _conn
}

/** The kill switch: a file named KILL in the data dir. Checked right before every broadcast. */
export const isKilled = () => existsSync(join(config.dataDir, 'KILL'))

export function parseSecret(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  try {
    const bytes = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s)
    return Keypair.fromSecretKey(bytes)
  } catch { return null }
}

let _master = null
export function getMaster() {
  if (_master) return _master
  _master = parseSecret(config.masterPrivateKey)
  if (config.masterPrivateKey && !_master) console.error('[solana] MASTER_PRIVATE_KEY could not be parsed (base58 or JSON byte array)')
  return _master
}
export function masterAddress() { const k = getMaster(); return k ? k.publicKey.toBase58() : '' }

/**
 * A coin's creator key, derived from the master secret + the launch id (HMAC-SHA512). Never
 * stored, recoverable from the master key alone. pump.fun pays this coin's creator fees to this
 * key's vault and nowhere else, so every coin's fees are separate and exact.
 */
export function coinKeyFor(launchId, secret = getMaster()?.secretKey) {
  if (!secret) return null
  // FROZEN. This label is baked into every coin's creator address on-chain. Changing it means the
  // engine can no longer collect (or burn) the fees of any coin already launched. Deliberately
  // brand-independent so renaming the product can never touch it.
  const seed = createHmac('sha512', Buffer.from(secret.slice(0, 32))).update(`coinkey:v1:${String(launchId)}`).digest().subarray(0, 32)
  return Keypair.fromSeed(seed)
}

// ALL transactions the engine builds go through this one serializer: the master pays every fee,
// and two in-flight txs racing for one balance is how a "can't happen" failure happens.
let txChain = Promise.resolve()
export function serializeTx(fn) {
  const run = txChain.then(fn, fn)
  txChain = run.catch(() => {})
  return run
}

export function budgetIxs(units = 300_000) {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFeeMicroLamports }),
  ]
}

let _alt = null
export async function lookupTables() {
  if (!config.altAddress) return []
  if (_alt && Date.now() - _alt.at < 600_000) return [_alt.value]
  const res = await getConnection().getAddressLookupTable(new PublicKey(config.altAddress)).catch(() => null)
  if (!res?.value) return []
  _alt = { at: Date.now(), value: res.value }
  return [res.value]
}

export async function buildTx({ payer, instructions, signers = [], units = 300_000 }) {
  const conn = getConnection()
  const alts = await lookupTables()
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [...budgetIxs(units), ...instructions] }).compileToV0Message(alts)
  const tx = new VersionedTransaction(msg)
  if (signers.length) tx.sign(signers)
  return { tx, blockhash, lastValidBlockHeight, size: tx.serialize().length }
}

/** Simulate; throw with the program error + last logs if it would fail on-chain. */
export async function simulate(tx) {
  const sim = await getConnection().simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' })
  if (sim.value.err) {
    const logs = (sim.value.logs || []).slice(-4).join(' | ')
    throw new Error(`would fail on-chain: ${JSON.stringify(sim.value.err)}${logs ? ` — ${logs}` : ''}`)
  }
  return sim.value
}

/* ---------------- broadcasting ---------------- */

// The Jito tip accounts. One is picked per tx; a bundle-only tx must pay one of them.
export const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY', 'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL', '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
]
export const tipIx = (from, lamports) => SystemProgram.transfer({
  fromPubkey: pk(from), toPubkey: pk(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]), lamports: BigInt(lamports),
})

/** Send to the Jito block engine as a bundle-only transaction: it lands through a bundle or not at all. */
async function sendViaJito(raw) {
  const res = await fetch(`${config.jitoUrl.replace(/\/$/, '')}/api/v1/transactions?bundleOnly=true`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [raw.toString('base64'), { encoding: 'base64' }] }),
    signal: AbortSignal.timeout(15_000),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || j.error) throw new Error(`jito: ${j.error?.message || res.status}`)
}

// How far past its last valid block height a transaction must be before "not found" is
// trusted to mean "never landed". RPC nodes lag.
const EXPIRY_MARGIN = 150

/**
 * Broadcast a signed tx and confirm by polling (no websocket). Resolves { sig } or throws:
 *   TX_FAILED       it landed with an error: nothing moved but the fee, safe to rebuild
 *   TX_NOT_LANDED   its blockhash provably expired without it: safe to rebuild
 *   CONFIRM_UNKNOWN anything else: never rebuild, settle it against the chain later
 * `private: true` only ever hands the bytes to the Jito block engine, never the public RPC.
 */
export async function sendAndConfirm(tx, { lastValidBlockHeight, private: priv = false }) {
  const conn = getConnection()
  const raw = Buffer.from(tx.serialize())
  const sig = bs58.encode(tx.signatures[0])
  const send = () => (priv ? sendViaJito(raw) : conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }))
  try { await send() } catch (e) {
    console.warn(`[send] first broadcast of ${sig.slice(0, 8)}… errored (${String(e.message).slice(0, 80)}); polling anyway`)
  }
  const started = Date.now()
  let lastResend = Date.now()
  while (Date.now() - started < 240_000) {
    try {
      const st = (await conn.getSignatureStatuses([sig]))?.value?.[0]
      if (st?.err) throw new Error(`TX_FAILED: ${JSON.stringify(st.err)}`)
      if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return { sig }
      if (st == null) {
        // Jito allows ~1 request/s per IP: resend more slowly there.
        if (Date.now() - lastResend > (priv ? 2500 : 4000)) { lastResend = Date.now(); send().catch(() => {}) }
        const height = await conn.getBlockHeight('confirmed')
        if (height > lastValidBlockHeight + EXPIRY_MARGIN) {
          const deep = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true }))?.value?.[0]
          if (deep?.err) throw new Error(`TX_FAILED: ${JSON.stringify(deep.err)}`)
          if (deep) return { sig }
          throw new Error('TX_NOT_LANDED: expired without landing')
        }
      }
    } catch (e) {
      if (/TX_FAILED|TX_NOT_LANDED/.test(String(e.message))) throw e
      // An RPC error while polling says nothing about the transaction: keep polling.
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error(`CONFIRM_UNKNOWN: ${sig}`)
}

/**
 * Build, simulate and (only when LIVE and not killed) send. Every money path goes through this
 * one door, so a dry run can never broadcast by accident. `onSig` fires the moment a signature
 * exists, BEFORE a byte is broadcast, so the caller can journal it.
 */
export async function submit({ payer, instructions, signers = [], units = 300_000, what = 'tx', private: priv = false, onSig, check }) {
  return serializeTx(async () => {
    const built = await buildTx({ payer, instructions, signers, units })
    if (built.size > 1232) throw new Error(`${what}: ${built.size} bytes, over the 1232 limit`)
    const sim = await simulate(built.tx)
    if (check) check(sim)
    if (!config.live) {
      console.log(`[dry-run] ${what}: simulated OK (${built.size} bytes, ${sim.unitsConsumed} CU), NOT sent (LIVE=false)`)
      return { sig: null, dryRun: true, sim }
    }
    if (isKilled()) throw new Error('KILLED: not broadcasting')
    const sig = bs58.encode(built.tx.signatures[0])
    if (onSig) await onSig(sig, built.lastValidBlockHeight)
    try {
      await sendAndConfirm(built.tx, { lastValidBlockHeight: built.lastValidBlockHeight, private: priv })
    } catch (e) {
      if (/TX_FAILED|TX_NOT_LANDED|CONFIRM_UNKNOWN/.test(String(e.message))) throw Object.assign(e, { sig })
      throw Object.assign(new Error(`CONFIRM_UNKNOWN: ${sig} (${String(e.message).slice(0, 120)})`), { sig })
    }
    console.log(`[sent] ${what}: ${sig}`)
    return { sig, dryRun: false, sim }
  })
}

/**
 * For a transaction that was signed and journaled but whose fate is unknown: did it land?
 * true / false / null. `false` only once the blockhash provably expired.
 */
export async function settled(sig, lastValidBlockHeight) {
  try {
    const st = (await getConnection().getSignatureStatuses([sig], { searchTransactionHistory: true }))?.value?.[0]
    if (st) return st.err ? false : true
    const height = await getConnection().getBlockHeight('confirmed')
    return height > Number(lastValidBlockHeight) + EXPIRY_MARGIN ? false : null
  } catch { return null }
}

export async function balanceOf(pubkey) {
  return BigInt(await getConnection().getBalance(new PublicKey(pubkey), 'confirmed'))
}

/** A confirmed transaction's meta, retried while the RPC catches up. null if it never shows. */
export async function txMeta(sig) {
  for (let i = 0; i < 10; i++) {
    const info = await getConnection().getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null)
    if (info?.meta) return info
    await new Promise(r => setTimeout(r, 1500))
  }
  return null
}

export const pk = s => new PublicKey(s)
export const short = a => (a ? `${String(a).slice(0, 4)}…${String(a).slice(-4)}` : '')
export const isPubkey = s => { try { return BASE58_RE.test(String(s)) && !!new PublicKey(s) } catch { return false } }
export const transferSol = (from, to, lamports) => SystemProgram.transfer({ fromPubkey: pk(from), toPubkey: pk(to), lamports: BigInt(lamports) })
