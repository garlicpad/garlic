import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { Keypair } from '@solana/web3.js'
import { ed25519 } from '@noble/curves/ed25519'
import bs58 from 'bs58'
import { gate, decodeImage, clashError } from '../launch.js'
import { fingerprint } from '../images.js'
import { foldName } from '../vamp.js'
import { launchMessage, requireSigned, detailsHash } from '../auth.js'
import { config } from '../config.js'
import { hamming } from '../vamp.js'

const W = 'CrGVR2G18rLyZ5truQXHQuFeywDLnKEQ3kKd3ic7L7uo'

test('the hourly cap holds', () => {
  const now = Date.now()
  const full = Array.from({ length: config.maxLaunchesPerHour }, (_, i) => ({ launcher: `w${i}`, status: 'live', createdAt: now - 1000, sig: `s${i}` }))
  assert.throws(() => gate(full, W, now), /full this hour/)
  assert.doesNotThrow(() => gate(full.map(c => ({ ...c, createdAt: now - 3_700_000 })), W, now))
})

test('launches that never got a signature cannot fill the hourly line', () => {
  const now = Date.now()
  const junk = Array.from({ length: config.maxLaunchesPerHour * 2 }, (_, i) => ({ launcher: `w${i}`, status: 'failed', createdAt: now - 1000 }))
  assert.doesNotThrow(() => gate(junk, W, now))
})

test('a wallet that keeps failing is slowed down', () => {
  const now = Date.now()
  const mine = Array.from({ length: 5 }, () => ({ launcher: W, status: 'failed', createdAt: now - 1000 }))
  assert.throws(() => gate(mine, W, now), /too many failed/)
  assert.doesNotThrow(() => gate(mine.slice(1), W, now))
})

test('one launch per wallet per cooldown, failed launches do not count', () => {
  const now = Date.now()
  assert.throws(() => gate([{ launcher: W, status: 'live', createdAt: now - 60_000 }], W, now), /one launch per wallet/)
  assert.doesNotThrow(() => gate([{ launcher: W, status: 'failed', createdAt: now - 60_000 }], W, now))
  assert.doesNotThrow(() => gate([{ launcher: W, status: 'live', createdAt: now - config.walletCooldownMin * 60_000 - 1 }], W, now))
})

test('pictures: data URLs decode, junk is refused', async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#335533' } }).png().toBuffer()
  assert.equal(decodeImage(`data:image/png;base64,${png.toString('base64')}`).length, png.length)
  assert.throws(() => decodeImage(''), /picture is required/)
  assert.throws(() => decodeImage(Buffer.from('not an image at all').toString('base64')), /PNG, JPEG/)
})

async function art(seed) {
  // a logo-like picture: gradient, a disc, a block, a word (what coin pictures look like)
  const a = seed === 5
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#${a ? '2a6' : 'a26'}"/><stop offset="1" stop-color="#113"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/><circle cx="${a ? 200 : 330}" cy="230" r="120" fill="#fd5"/><rect x="${a ? 260 : 60}" y="330" width="180" height="90" rx="20" fill="#eee"/><text x="80" y="480" font-size="70" fill="#fff">PEPE${seed}</text></svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

test('a resized, recompressed or recoloured copy is the same picture; a different one is not', async () => {
  const orig = await art(5)
  const a = await fingerprint(orig)
  const resized = await fingerprint(await sharp(orig).resize(120, 120).jpeg({ quality: 60 }).toBuffer())
  const recolor = await fingerprint(await sharp(orig).modulate({ hue: 120, saturation: 0.6 }).toBuffer())
  const darker = await fingerprint(await sharp(orig).linear(0.7, 0).toBuffer())
  const other = await fingerprint(await art(11))
  assert.ok(hamming(a.imgHash, resized.imgHash) <= config.imageDistance, `resized ${hamming(a.imgHash, resized.imgHash)}`)
  assert.ok(hamming(a.imgHash, darker.imgHash) <= config.imageDistance, `darker ${hamming(a.imgHash, darker.imgHash)}`)
  assert.ok(hamming(a.imgHash, recolor.imgHash) <= config.imageDistance, `recolor ${hamming(a.imgHash, recolor.imgHash)}`)
  assert.ok(hamming(a.imgHash, other.imgHash) > config.imageDistance, `other ${hamming(a.imgHash, other.imgHash)}`)
  const coins = [{ mint: 'm', symbol: 'ART', status: 'live', folds: { ticker: 'ART', name: foldName('Art'), x: null, ...a } }]
  assert.equal(clashError(coins, { ticker: 'NEW', name: 'New', x: null, ...resized })?.rule, 'picture')
  assert.equal(clashError(coins, { ticker: 'NEW', name: 'New', x: null, ...other }), null)
})

test('the launch signature binds the exact coin and picture', () => {
  const kp = Keypair.generate()
  const wallet = kp.publicKey.toBase58()
  const ts = Date.now()
  const details = detailsHash({ description: 'hi', x: 'https://x.com/garlic', telegram: '', website: '' })
  const msg = launchMessage({ brand: 'garlic', name: 'Garlic', symbol: 'GARLIC', imageSha: 'ab'.repeat(32), details, ts })
  const sig = bs58.encode(ed25519.sign(new TextEncoder().encode(msg), kp.secretKey.slice(0, 32)))
  assert.doesNotThrow(() => requireSigned(wallet, msg, sig, ts))
  const other = launchMessage({ brand: 'garlic', name: 'Garlic', symbol: 'GARL1C', imageSha: 'ab'.repeat(32), details, ts })
  assert.throws(() => requireSigned(wallet, other, sig, ts), /does not match/)
  const swappedLink = launchMessage({ brand: 'garlic', name: 'Garlic', symbol: 'GARLIC', imageSha: 'ab'.repeat(32), details: detailsHash({ description: 'hi', x: 'https://x.com/scam' }), ts })
  assert.throws(() => requireSigned(wallet, swappedLink, sig, ts), /does not match/)
  assert.throws(() => requireSigned(wallet, msg, sig, ts - 11 * 60_000), /expired/)
  assert.throws(() => requireSigned(W, msg, sig, ts), /does not match/)
})
