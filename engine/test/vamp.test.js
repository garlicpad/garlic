import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldTicker, foldName, xKey, hamming, findClash, validateCoin, squeeze, reservedClash } from '../vamp.js'

test('tickers fold case, spaces, $ and punctuation', () => {
  for (const t of ['PEPE', 'pepe', '$PEPE', 'P E P E', 'p.e.p.e', 'Pe-Pe', 'PEPE ']) assert.equal(foldTicker(t), 'PEPE', t)
})

test('tickers fold leetspeak', () => {
  for (const t of ['P3PE', 'PEP3', 'P3P3', '93P3']) assert.notEqual(foldTicker(t), '', t)
  assert.equal(foldTicker('P3PE'), 'PEPE')
  assert.equal(foldTicker('B00K'), 'BOOK')
  assert.equal(foldTicker('5H1B'), 'SHIB')
  assert.equal(foldTicker('$4LON'), 'ALON')
  assert.equal(foldTicker('L4UNCH'), 'LAUNCH')
})

test('tickers fold lookalike letters (Cyrillic, Greek, fullwidth, accents)', () => {
  assert.equal(foldTicker('PЕPE'), 'PEPE')        // Cyrillic Е
  assert.equal(foldTicker('РЕРЕ'), 'PEPE')        // all Cyrillic
  assert.equal(foldTicker('ΡΕΡΕ'), 'PEPE')        // Greek
  assert.equal(foldTicker('ＰＥＰＥ'), 'PEPE')      // fullwidth
  assert.equal(foldTicker('PÉPÉ'), 'PEPE')        // accents
  assert.equal(foldTicker('pepe​'), 'PEPE')  // zero-width space
})

test('different tickers stay different', () => {
  assert.notEqual(foldTicker('PEPE'), foldTicker('PEPU'))
  assert.notEqual(foldTicker('BONK'), foldTicker('BONKS'))
  assert.notEqual(foldTicker('AI'), foldTicker('A'))
})

test('a ticker of only symbols folds to nothing', () => {
  assert.equal(foldTicker('$$$'), '')
  assert.equal(foldTicker('🚀🚀'), '')
})

test('names fold "official", "real", "the", a 2 or a coin/token suffix away', () => {
  const base = foldName('Pepe')
  for (const n of ['Pepe Official', 'Official Pepe', 'The Real Pepe', 'PEPE 2', 'Pepe 2.0', 'Pepe II', 'Pepe v2', 'Pepe Coin', 'Pepe Token', 'pepe (official)', 'P3PE', 'Pepe OG']) {
    assert.equal(foldName(n), base, n)
  }
  assert.notEqual(foldName('Pepe Frog'), base)
  assert.notEqual(foldName('Blink 182'), foldName('Blink'))
})

test('a name made only of filler words keeps its letters', () => {
  assert.notEqual(foldName('The Official Coin'), '')
})

test('X links fold to one key per post or per account', () => {
  assert.equal(xKey('https://x.com/elonmusk/status/1234567890123?s=20'), 'x:post:1234567890123')
  assert.equal(xKey('https://twitter.com/ElonMusk/status/1234567890123'), 'x:post:1234567890123')
  assert.equal(xKey('https://mobile.twitter.com/i/web/status/1234567890123'), 'x:post:1234567890123')
  assert.equal(xKey('https://x.com/ElonMusk'), 'x:user:elonmusk')
  assert.equal(xKey('x.com/elonmusk/'), 'x:user:elonmusk')
  assert.equal(xKey('@ElonMusk'), 'x:user:elonmusk')
  assert.equal(xKey('https://x.com/i/communities/1890000000000000000'), 'x:community:1890000000000000000')
  assert.equal(xKey(''), null)
  assert.equal(xKey('https://example.com/elonmusk'), null)
})

test('hamming distance of 64-bit hashes', () => {
  assert.equal(hamming('0000000000000000', '0000000000000000'), 0)
  assert.equal(hamming('ffffffffffffffff', '0000000000000000'), 64)
  assert.equal(hamming('000000000000000f', '0000000000000000'), 4)
})

const taken = [
  { mint: 'm1', symbol: 'PEPE', name: 'Pepe', status: 'live', folds: { ticker: 'PEPE', name: foldName('Pepe'), x: 'x:user:pepe', imgSha: 'aa', imgHash: '00000000000000ff' } },
  { mint: 'm2', symbol: 'OLD', name: 'Old', status: 'failed', folds: { ticker: 'OLD', name: foldName('Old'), x: null, imgSha: 'bb', imgHash: 'ffffffffffffffff' } },
]

test('a clash names the rule and the coin that owns it', () => {
  assert.deepEqual(findClash(taken, { ticker: 'P3PE', name: 'Frog', x: null, imgSha: 'zz', imgHash: 'f0f0f0f0f0f0f0f0' }, 6), { rule: 'ticker', mint: 'm1', symbol: 'PEPE' })
  assert.deepEqual(findClash(taken, { ticker: 'FROG', name: 'The Real Pepe', x: null, imgSha: 'zz', imgHash: 'f0f0f0f0f0f0f0f0' }, 6), { rule: 'name', mint: 'm1', symbol: 'PEPE' })
  assert.deepEqual(findClash(taken, { ticker: 'FROG', name: 'Frog', x: 'x:user:pepe', imgSha: 'zz', imgHash: 'f0f0f0f0f0f0f0f0' }, 6), { rule: 'x', mint: 'm1', symbol: 'PEPE' })
  assert.deepEqual(findClash(taken, { ticker: 'FROG', name: 'Frog', x: null, imgSha: 'aa', imgHash: 'f0f0f0f0f0f0f0f0' }, 6), { rule: 'picture', mint: 'm1', symbol: 'PEPE' })
  assert.deepEqual(findClash(taken, { ticker: 'FROG', name: 'Frog', x: null, imgSha: 'zz', imgHash: '00000000000000f0' }, 6), { rule: 'picture', mint: 'm1', symbol: 'PEPE' })
})

test('a failed launch releases everything it held', () => {
  assert.equal(findClash(taken, { ticker: 'OLD', name: 'Old', x: null, imgSha: 'bb', imgHash: 'ffffffffffffffff' }, 6), null)
})

test('a new coin passes', () => {
  assert.equal(findClash(taken, { ticker: 'FROG', name: 'Frog', x: null, imgSha: 'zz', imgHash: 'f0f0f0f0f0f0f0f0' }, 6), null)
})

test('coin fields are validated', () => {
  assert.doesNotThrow(() => validateCoin({ name: 'Garlic', symbol: 'GARLIC', description: '', x: '', telegram: '', website: '' }))
  assert.throws(() => validateCoin({ name: '', symbol: 'A' }), /name/)
  assert.throws(() => validateCoin({ name: 'x'.repeat(33), symbol: 'A' }), /name/)
  assert.throws(() => validateCoin({ name: 'é'.repeat(17), symbol: 'A' }), /name/) // 17 chars, 34 bytes
  assert.doesNotThrow(() => validateCoin({ name: 'é'.repeat(16), symbol: 'A' }))
  assert.throws(() => validateCoin({ name: 'Ok', symbol: 'ÉÉÉÉÉÉ' }), /ticker/) // 6 chars, 12 bytes
  assert.throws(() => validateCoin({ name: 'Ok', symbol: '' }), /ticker/)
  assert.throws(() => validateCoin({ name: 'Ok', symbol: 'TOOLONGTICKER' }), /ticker/)
  assert.throws(() => validateCoin({ name: 'Ok', symbol: '$$$' }), /ticker/)
  assert.throws(() => validateCoin({ name: 'Ok', symbol: 'OK', website: 'javascript:alert(1)' }), /website/)
  assert.throws(() => validateCoin({ name: 'Ok', symbol: 'OK', x: 'https://example.com/a' }), /X/)
  assert.throws(() => validateCoin({ name: 'Ok', symbol: 'OK', description: 'd'.repeat(501) }), /description/)
})

test('tickers drop the suffixes vamps add, and a leading THE', () => {
  for (const t of ['DOGE2', 'DOGEV2', 'DOGEII', 'DOGE2.0', 'DOGEAI', 'DOGE AI', 'DOGEINU', 'DOGESOL', 'DOGECOIN', 'DOGETOKEN', 'THEDOGE', 'THE DOGE AI 2', 'D0GE2']) {
    assert.equal(foldTicker(t), 'DOGE', t)
  }
})

test('a ticker that is only a suffix keeps itself', () => {
  assert.equal(foldTicker('AI'), 'AI')
  assert.equal(foldTicker('INU'), 'INU')
  assert.equal(foldTicker('SOL'), 'SOL')
  assert.equal(foldTicker('THE'), 'THE')
  assert.equal(foldTicker('COIN'), 'COIN')
})

test('repeated letters count as one on the board', () => {
  const board = [{ mint: 'd', symbol: 'DOGE', name: 'Doge', status: 'live', folds: { ticker: 'DOGE', name: 'doge' } }]
  for (const t of ['DOGGE', 'DOOGE', 'DDOGE', 'DOGEE']) assert.equal(findClash(board, { ticker: t, name: 'x' + t, x: null }, 6)?.rule, 'ticker', t)
  assert.equal(findClash(board, { ticker: 'DOG', name: 'Dog', x: null }, 6), null)
  assert.equal(findClash(board, { ticker: 'CAT', name: 'Dogge', x: null }, 6)?.rule, 'name')
})

test('repeated letters stay in the fold used against coins elsewhere ($MOON is not $MON)', () => {
  assert.equal(foldTicker('MOON'), 'MOON')
  assert.notEqual(foldTicker('MOON'), foldTicker('MON'))
  assert.equal(squeeze('MOON'), 'MON')
})

test('names drop AI and INU like the other filler', () => {
  assert.equal(foldName('Doge AI'), foldName('Doge'))
  assert.equal(foldName('Doge Inu'), foldName('Doge'))
})

test('the platform coin\'s ticker and name are reserved on the board', () => {
  const reserved = { tickers: ['GARLIC', 'GARLICPAD'], names: ['garlic', 'garlicpad'] }
  for (const t of ['GARLIC', 'garlic', 'G4RLIC', 'GARLIC AI', 'THE GARLIC', 'GARLLIC', 'GARLICPAD']) assert.equal(reservedClash(reserved, { ticker: t, name: 'x' })?.rule, 'ticker', t)
  assert.equal(reservedClash(reserved, { ticker: 'CLOVE', name: 'Garlic Official' })?.rule, 'name')
  assert.equal(reservedClash(reserved, { ticker: 'CLOVE', name: 'Clove' }), null)
})
