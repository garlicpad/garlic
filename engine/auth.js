// Wallet signatures. A launcher proves a wallet is theirs by signing a plain-text message in their
// wallet; nothing is sent on-chain and no SOL moves. The server rebuilds the exact message from the
// request and checks the ed25519 signature against the wallet's address.
import { createHash } from 'crypto'
import { ed25519 } from '@noble/curves/ed25519'
import bs58 from 'bs58'
import { isPubkey } from './solana.js'

const FRESH_MS = 10 * 60_000

function decodeSig(sig) {
  const s = String(sig || '')
  try { const b = bs58.decode(s); if (b.length === 64) return b } catch {}
  try { const b = Buffer.from(s, 'base64'); if (b.length === 64) return new Uint8Array(b) } catch {}
  return null
}

/** True when `signature` is `wallet`'s ed25519 signature over `message` (UTF-8). */
export function verifySigned(wallet, message, signature) {
  if (!isPubkey(wallet)) return false
  const sig = decodeSig(signature)
  if (!sig) return false
  try { return ed25519.verify(sig, new TextEncoder().encode(message), bs58.decode(wallet)) } catch { return false }
}

/** Throws a 401-coded error unless the signature is valid and the timestamp is recent. */
export function requireSigned(wallet, message, signature, ts) {
  const t = Number(ts)
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > FRESH_MS) throw Object.assign(new Error('signature expired, sign again'), { code: 401 })
  if (!verifySigned(wallet, message, signature)) throw Object.assign(new Error('signature does not match this wallet'), { code: 401 })
}

/** A short hash of the fields a launcher sets besides name, ticker and picture. */
export function detailsHash({ description = '', x = '', telegram = '', website = '' } = {}) {
  return createHash('sha256').update(JSON.stringify([description, x, telegram, website].map(v => String(v || '').trim()))).digest('hex').slice(0, 16)
}

/**
 * The message a launcher signs. It names the exact coin: name, ticker, the picture by hash and
 * every other field by hash, so a signature authorizes this launch exactly and nothing else.
 */
export function launchMessage({ brand, name, symbol, imageSha, details, ts }) {
  return `Launch a coin on ${brand}\n\nname: ${name}\nticker: $${symbol}\npicture: ${imageSha}\ndetails: ${details}\n\nNo dev buy. Every creator fee buys this coin back and burns it.\n\nts ${ts}`
}
