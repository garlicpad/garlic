// Durable JSON stores.
//
//   coins.json      every launch, from reservation to live (the money journal of launches: a
//                   create's signature is written here BEFORE it is broadcast)
//   receipts.jsonl  every buyback-and-burn, append-only, one line per transaction
//
// Three rules keep them whole:
//   1. Every read-modify-write of coins.json runs under ONE cross-process lock.
//   2. Writes go to a unique temp file and are renamed into place; the target is never deleted first.
//   3. A coins.json that exists but cannot be parsed stops the engine instead of being read as
//      empty (an empty file would release every ticker and forget every pending signature).
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, openSync, closeSync, appendFileSync, statSync } from 'fs'
import { randomBytes } from 'crypto'
import { config } from './config.js'

function ensureDir(dir = config.dataDir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) }
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export function writeJsonAtomic(file, data) {
  ensureDir()
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 1))
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); return } catch (e) {
      if (i >= 50) { try { unlinkSync(tmp) } catch {} throw e }
      sleepSync(20)
    }
  }
}

export function readJson(file, fallback, { money = false } = {}) {
  ensureDir()
  if (!existsSync(file)) return fallback
  const text = readFileSync(file, 'utf-8')
  try { return JSON.parse(text) } catch (e) {
    if (money) throw new Error(`journal ${file} is unreadable, refusing to treat it as empty (${e.message})`)
    return fallback
  }
}

let held = 0
export function locked(fn) {
  if (held) { held++; try { return fn() } finally { held-- } }
  ensureDir()
  const p = `${config.dataDir}/journal.lock`
  let fd
  for (let tries = 0; ; tries++) {
    try { fd = openSync(p, 'wx'); break } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try { if (Date.now() - statSync(p).mtimeMs > 30_000) { unlinkSync(p); continue } } catch {}
      if (tries > 5000) throw new Error('journal lock timeout')
      sleepSync(2)
    }
  }
  held = 1
  try { return fn() } finally {
    held = 0
    try { closeSync(fd) } catch {}
    try { unlinkSync(p) } catch {}
  }
}

const COINS = () => `${config.dataDir}/coins.json`
const RECEIPTS = () => `${config.dataDir}/receipts.jsonl`

/* ---------------- coins ---------------- */

export const readCoins = () => readJson(COINS(), [], { money: true })
export const findCoin = pred => readCoins().find(pred) || null
export const coinById = id => findCoin(c => c.id === id)
export const coinByMint = mint => findCoin(c => c.mint === mint)

/** Insert a coin record. Use inside locked() when uniqueness matters. */
export function insertCoin(coin) {
  return locked(() => {
    const all = readCoins()
    if (all.some(c => c.id === coin.id)) throw new Error(`coin ${coin.id} exists`)
    all.push(coin)
    writeJsonAtomic(COINS(), all)
    return coin
  })
}

/** Patch one coin; `fn` may be an object or (coin) => object. Returns the new record. */
export function patchCoin(id, patch) {
  return locked(() => {
    const all = readCoins()
    const i = all.findIndex(c => c.id === id)
    if (i < 0) throw new Error(`no coin ${id}`)
    const p = typeof patch === 'function' ? patch(all[i]) : patch
    all[i] = { ...all[i], ...p, updatedAt: Date.now() }
    writeJsonAtomic(COINS(), all)
    return all[i]
  })
}

/* ---------------- receipts ---------------- */

let receiptCache = null
export function readReceipts() {
  if (receiptCache) return receiptCache
  ensureDir()
  if (!existsSync(RECEIPTS())) return (receiptCache = [])
  const out = []
  for (const line of readFileSync(RECEIPTS(), 'utf-8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch {}
  }
  return (receiptCache = out)
}

let totalsCache = { n: -1, map: new Map() }
/**
 * Burn totals per mint, always summed from the receipts themselves (the one source of truth), so
 * a crash between writing a receipt and updating a coin can never leave the two disagreeing.
 * Map(mint → { count, tokens, sol, lastAt })
 */
export function burnTotals() {
  const all = readReceipts()
  if (totalsCache.n === all.length) return totalsCache.map
  const map = new Map()
  for (const r of all) {
    const t = map.get(r.mint) || { count: 0, tokens: 0, sol: 0, lastAt: 0 }
    t.count++; t.tokens += r.tokens || 0; t.sol += r.sol || 0; t.lastAt = Math.max(t.lastAt, r.at || 0)
    map.set(r.mint, t)
  }
  totalsCache = { n: all.length, map }
  return map
}

/** Append-only. A receipt is never rewritten, and the same signature is never written twice. */
export function appendReceipt(r) {
  return locked(() => {
    const all = readReceipts()
    if (r.sig && all.some(x => x.sig === r.sig)) return null
    ensureDir()
    appendFileSync(RECEIPTS(), JSON.stringify(r) + '\n')
    all.push(r)
    return r
  })
}
