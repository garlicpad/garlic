import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planBuyback, measureSpent } from '../burn.js'
import { sizeForBudget } from '../pump.js'
import { coinKeyFor, getMaster, SYSTEM_RENT_FLOOR } from '../solana.js'

const F = SYSTEM_RENT_FLOOR
const MIN = 3_000_000n

test('nothing to do below the minimum', () => {
  assert.equal(planBuyback({ key: F, curve: 0n, amm: 0n, min: MIN }), null)
  assert.equal(planBuyback({ key: F, curve: MIN - 1n, amm: 0n, min: MIN }), null)
})

test('the budget is everything above the floor plus both vaults', () => {
  assert.deepEqual(planBuyback({ key: F + 1_000n, curve: 5_000_000n, amm: 0n, min: MIN }), { budget: 5_001_000n, topUp: 0n, curve: true, amm: false })
  assert.deepEqual(planBuyback({ key: F, curve: 0n, amm: 4_000_000n, min: MIN }), { budget: 4_000_000n, topUp: 0n, curve: false, amm: true })
  assert.deepEqual(planBuyback({ key: F + 2_000_000n, curve: 1_000_000n, amm: 1_000_000n, min: MIN }), { budget: 4_000_000n, topUp: 0n, curve: true, amm: true })
})

test('unspent fees left in the key from a past cycle are spent next time', () => {
  assert.deepEqual(planBuyback({ key: F + 3_500_000n, curve: 0n, amm: 0n, min: MIN }), { budget: 3_500_000n, topUp: 0n, curve: false, amm: false })
})

test('a key below its floor is topped up by the master, never paid from the fees', () => {
  const p = planBuyback({ key: 0n, curve: 5_000_000n, amm: 0n, min: MIN })
  assert.equal(p.topUp, F)
  assert.equal(p.budget, 5_000_000n)
})

test('a negative vault reading never counts', () => {
  assert.equal(planBuyback({ key: F, curve: -5n, amm: 0n, min: 1n }), null)
})

test('the buy size leaves room for slippage inside the budget', () => {
  for (const budget of [3_000_000n, 12_345_678n, 1_000_000_000n, 7n]) {
    for (const slip of [1, 5, 10, 25]) {
      const size = sizeForBudget(budget, slip)
      const max = size + (size * BigInt(Math.floor(slip * 10))) / 1000n // the SDK's formula
      assert.ok(max <= budget, `budget ${budget} slip ${slip}: max ${max}`)
      assert.ok(size > 0n || budget < 2n)
    }
  }
  assert.equal(sizeForBudget(0n, 5), 0n)
  assert.equal(sizeForBudget(-1n, 5), 0n)
})

test('spent is measured over the coin own accounts only', () => {
  const tx = {
    keys: ['master', 'key', 'vault', 'pool', 'wsol'],
    pre: [10_000_000, 890_880 + 1_000, 6_000_000, 50_000_000, 0],
    post: [9_990_000, 890_880 + 300, 890_880 - 890_880 + 890_880 * 0 + 1_000_000, 54_000_000, 0],
  }
  const own = new Set(['key', 'vault', 'wsol'])
  // key: 700 out, vault: 5_000_000 out
  assert.equal(measureSpent(tx, own), 5_000_700n)
})

test('the master loan nets to zero', () => {
  const tx = { keys: ['key', 'wsol'], pre: [1_000_000, 0], post: [1_000_000, 0] }
  assert.equal(measureSpent(tx, new Set(['key', 'wsol'])), 0n)
})

test('coin keys are stable, distinct, and come from the master', () => {
  const a = coinKeyFor('abc').publicKey.toBase58()
  assert.equal(coinKeyFor('abc').publicKey.toBase58(), a)
  assert.notEqual(coinKeyFor('abd').publicKey.toBase58(), a)
  assert.notEqual(a, getMaster().publicKey.toBase58())
  // the label is frozen: a different master gives a different key for the same id
  assert.notEqual(coinKeyFor('abc', new Uint8Array(64).fill(7)).publicKey.toBase58(), a)
})

test('a cap per cycle limits the buy, never the collect', () => {
  const p = planBuyback({ key: F, curve: 9_000_000_000n, amm: 0n, min: MIN, max: 5_000_000_000n })
  assert.equal(p.budget, 5_000_000_000n)
  assert.equal(p.curve, true)
})

test('leaving the curve leg out leaves its fees where they are', () => {
  assert.deepEqual(planBuyback({ key: F, curve: 2_000_000n, amm: 4_000_000n, min: MIN, withCurve: false }), { budget: 4_000_000n, topUp: 0n, curve: false, amm: true })
  assert.equal(planBuyback({ key: F, curve: 9_000_000n, amm: 0n, min: MIN, withCurve: false }), null)
})
