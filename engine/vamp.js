// The anti-vamp rules. Pure functions, no I/O: what counts as "the same coin".
//
// A ticker, a name, an X post/account and a picture each belong to one coin. Before anything is
// signed, a new coin is folded the same way every live coin was, and any clash is refused with the
// rule and the coin that owns it. Folding is deliberately aggressive: case, spaces, punctuation,
// lookalike letters (Cyrillic, Greek, fullwidth, accents) and leetspeak all collapse to one form.

// Lookalikes that NFKC does not fold: Cyrillic and Greek letters drawn like Latin ones.
const HOMOGLYPHS = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', І: 'I', Ј: 'J', Ѕ: 'S', Ү: 'Y',
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', һ: 'h', ԁ: 'd', ԛ: 'q', ԝ: 'w', к: 'k', м: 'm', н: 'h', т: 't', в: 'b',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
}
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', $: 's', '@': 'a', '!': 'i', '|': 'i' }

/** Unicode down to plain lowercase latin + digits + the leet symbols. */
function plain(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[​-‏⁠﻿]/g, '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/./gu, ch => HOMOGLYPHS[ch] ?? ch)
    .toLowerCase()
}
const leet = s => s.replace(/[0-9$@!|]/g, ch => LEET[ch] ?? ch)

// What vamps bolt onto a running ticker. Removed from the end (and THE from the front) until
// nothing changes, unless that would leave fewer than two characters ($AI stays $AI).
// "2O" is "2.0" after the leet map and the strip.
const TICKER_SUFFIXES = ['TOKEN', 'COIN', 'INU', 'SOL', 'AI', 'V2', 'II', '2O', '2']

/**
 * A ticker's one true form: uppercase A–Z and the digits leetspeak leaves alone, with the suffixes
 * vamps add removed. Used everywhere, including the check against coins trading elsewhere.
 */
export function foldTicker(t) {
  let f = leet(plain(t).trim().replace(/^\$+/, '')).replace(/[^a-z0-9]/g, '').toUpperCase()
  for (let changed = true; changed;) {
    changed = false
    if (f.startsWith('THE') && f.length - 3 >= 2) { f = f.slice(3); changed = true }
    for (const x of TICKER_SUFFIXES) {
      if (f.endsWith(x) && f.length - x.length >= 2) { f = f.slice(0, -x.length); changed = true; break }
    }
  }
  return f
}

/**
 * Runs of one letter count as one ($DOGGE is $DOGE). Only between coins on this board: against
 * coins elsewhere it would turn $MOON into $MON and refuse it for a chain's ticker.
 */
export const squeeze = s => String(s || '').replace(/(.)\1+/g, '$1')

// Words a vamp adds to an existing name. Removed before comparing (unless nothing else is left).
const FILLER = new Set(['official', 'real', 'the', 'og', 'original', 'new', 'classic', 'coin', 'token', 'sol', 'ai', 'inu', 'v2', 'v3', '2', '3', '2.0', '3.0', 'ii', 'iii'])

/** A name's one true form: its words minus the filler, lowercased and folded, run together. */
export function foldName(n) {
  const words = plain(n).replace(/[^a-z0-9$@!|.]+/g, ' ').split(' ').map(w => w.replace(/^\.+|\.+$/g, '')).filter(Boolean)
  const kept = words.filter(w => !FILLER.has(w))
  return leet((kept.length ? kept : words).join('')).replace(/[^a-z0-9]/g, '')
}

const RESERVED_PATHS = new Set(['home', 'i', 'search', 'intent', 'share', 'explore', 'notifications', 'messages', 'settings', 'hashtag'])

/** One key per X post, account or community. null when the link is not X. */
export function xKey(link) {
  let s = String(link || '').trim()
  if (!s) return null
  if (/^@[A-Za-z0-9_]{1,15}$/.test(s)) return `x:user:${s.slice(1).toLowerCase()}`
  s = s.replace(/^https?:\/\//i, '')
  const m = /^(?:www\.|mobile\.)?(x\.com|twitter\.com)(\/[^?#]*)?/i.exec(s)
  if (!m) return null
  const parts = (m[2] || '').split('/').filter(Boolean)
  const status = parts.indexOf('status')
  if (status >= 0 && /^\d{5,25}$/.test(parts[status + 1] || '')) return `x:post:${parts[status + 1]}`
  if (parts[0] === 'i' && parts[1] === 'communities' && /^\d{5,25}$/.test(parts[2] || '')) return `x:community:${parts[2]}`
  if (parts.length >= 1 && /^[A-Za-z0-9_]{1,15}$/.test(parts[0]) && !RESERVED_PATHS.has(parts[0].toLowerCase())) return `x:user:${parts[0].toLowerCase()}`
  return null
}

/** Differing bits between two 64-bit hashes written as 16 hex digits. */
export function hamming(a, b) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`)
  let n = 0
  while (x) { n += Number(x & 1n); x >>= 1n }
  return n
}

// A coin in any of these states still owns its ticker, name, X link and picture.
export const HOLDING = new Set(['reserved', 'sending', 'unknown', 'live'])

/**
 * The first rule a candidate breaks, with the coin that owns it: { rule, mint, symbol } or null.
 * cand = { ticker, name, x, imgSha, imgHash } with ticker/name RAW (folded here).
 */
export function findClash(coins, cand, maxDistance) {
  // folded fresh from each coin's own ticker and name, so a rule added later covers old coins too
  const t = squeeze(foldTicker(cand.ticker))
  const n = squeeze(foldName(cand.name))
  const held = coins.filter(c => HOLDING.has(c.status))
  const hit = (rule, c) => ({ rule, mint: c.mint || null, symbol: c.symbol })
  const tickerOf = c => squeeze(c.symbol != null ? foldTicker(c.symbol) : c.folds?.ticker)
  const nameOf = c => squeeze(c.name != null ? foldName(c.name) : c.folds?.name)
  for (const c of held) if (t && tickerOf(c) === t) return hit('ticker', c)
  for (const c of held) if (n && nameOf(c) === n) return hit('name', c)
  if (cand.x) for (const c of held) if (c.folds?.x === cand.x) return hit('x', c)
  if (cand.imgSha || cand.imgHash) {
    for (const c of held) {
      if (cand.imgSha && c.folds?.imgSha === cand.imgSha) return hit('picture', c)
      if (cand.imgHash && c.folds?.imgHash && hamming(cand.imgHash, c.folds.imgHash) <= maxDistance) return hit('picture', c)
    }
  }
  return null
}

export const CLASH_TEXT = {
  ticker: s => `$${s} already has this ticker. One coin per ticker, forever.`,
  name: s => `$${s} already has this name.`,
  x: s => `this X link already backs $${s}. One coin per post or account.`,
  picture: s => `this picture (or a resized or recoloured copy) already belongs to $${s}.`,
}

const bad = msg => Object.assign(new Error(msg), { code: 400 })
const isHttpUrl = s => { try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:' } catch { return false } }

/** Trim and check a coin's fields. Throws a 400 naming the field. */
export function validateCoin(d) {
  const name = String(d.name ?? '').trim()
  const symbol = String(d.symbol ?? '').trim().replace(/^\$+/, '')
  const description = String(d.description ?? '').trim()
  const x = String(d.x ?? '').trim()
  const telegram = String(d.telegram ?? '').trim()
  const website = String(d.website ?? '').trim()
  // pump.fun stores these as bytes: an accented or emoji name is longer than it looks
  if (!name || Buffer.byteLength(name, 'utf8') > 32) throw bad('name must be 1 to 32 characters (accents and emoji count double)')
  if (!symbol || Buffer.byteLength(symbol, 'utf8') > 10) throw bad('ticker must be 1 to 10 characters (accents and emoji count double)')
  if (!foldTicker(symbol)) throw bad('ticker needs at least one letter or number')
  if (/[\u0000-\u001f]/.test(name + symbol)) throw bad('name and ticker cannot contain control characters')
  if (description.length > 500) throw bad('description must be at most 500 characters')
  if (website && !isHttpUrl(website)) throw bad('website must be an http(s) link')
  if (x && !xKey(x)) throw bad('X link must be an x.com post, account or community')
  if (telegram && !/^(https?:\/\/)?(t\.me|telegram\.me)\/[A-Za-z0-9_+/-]{2,}$/i.test(telegram)) throw bad('telegram must be a t.me link')
  return { name, symbol, description, x, telegram: telegram && !/^https?:/i.test(telegram) ? `https://${telegram}` : telegram, website }
}
