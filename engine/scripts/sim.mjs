// Simulates (never sends, nothing is signed by anyone real) the engine's real transactions on mainnet:
//   1. a launch: Jito tip + the coin key's floor + create_v2 (creator = a fresh coin key, no buy) + pump's volume account
//   2. a buyback + burn on a coin still on its curve, using that coin's real creator as the "coin key"
//   3. the same on a graduated coin (the PumpSwap route)
// For 2 and 3 the creator's own wallet balance is ignored (key = floor), so the budget is exactly the
// fees waiting in pump's vaults. The check: the mint's supply drops by EXACTLY the tokens bought, and
// the coin key ends at or above its floor.
//
// Usage: SOLANA_RPC_URL=… node scripts/sim.mjs <curveMint> <graduatedMint>
process.env.GARLIC_NO_DOTENV = '1'
if (process.env.SIM_RPC_URL) process.env.GARLIC_RPC_URL = process.env.SIM_RPC_URL
process.env.LIVE = 'false'
process.env.MIN_BUYBACK_SOL = process.env.MIN_BUYBACK_SOL || '0.001'
const { Keypair, PublicKey, TransactionMessage, VersionedTransaction } = await import('@solana/web3.js')
const { getConnection, budgetIxs, lookupTables, SYSTEM_RENT_FLOOR, sol } = await import('../solana.js')
const { createTxIxs } = await import('../launch.js')
const { buybackIxs, VARIANTS } = await import('../burn.js')
const { readVaults, readCurves, online, DECIMALS } = await import('../pump.js')

// A wallet with plenty of SOL to stand in for the master (simulation only; sigVerify is off).
const PAYER = process.env.SIM_PAYER || '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'
const conn = getConnection()

async function simulate(label, ixs, units, partialSigners = [], watch = []) {
  const { blockhash } = await conn.getLatestBlockhash('confirmed')
  const alts = await lookupTables()
  const msg = new TransactionMessage({ payerKey: new PublicKey(PAYER), recentBlockhash: blockhash, instructions: [...budgetIxs(units), ...ixs] }).compileToV0Message(alts)
  const tx = new VersionedTransaction(msg)
  if (partialSigners.length) tx.sign(partialSigners)
  const size = tx.serialize().length
  if (size > 1232) { console.log(`
== ${label}: ${size} bytes, over 1232: next variant`); return { ok: false, size } }
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watch } })
  const ok = !sim.value.err
  console.log(`\n== ${label}: ${ok ? 'OK' : 'FAILED'}  ${size} bytes (limit 1232)  ${sim.value.unitsConsumed} CU of ${units}`)
  if (!ok) console.log(JSON.stringify(sim.value.err), '\n  ' + (sim.value.logs || []).slice(-8).join('\n  '))
  return { ok, size, sim: sim.value }
}

// 1. launch
{
  const mint = Keypair.generate()
  const coinKey = Keypair.generate().publicKey.toBase58()
  const ixs = await createTxIxs({ m: PAYER, coinKey, mint: mint.publicKey.toBase58(), name: 'Garlic Sim', symbol: 'GSIM', uri: 'https://garlic-pad.vercel.app/api/m/0123456789abcdef0123.json' })
  const before = await conn.getBalance(new PublicKey(PAYER), 'confirmed')
  const r = await simulate('launch (create_v2, no buy, private tip)', ixs, 260_000, [mint], [coinKey, PAYER])
  if (r.ok) {
    console.log(`   coin key after: ${r.sim.accounts[0]?.lamports} lamports (floor ${SYSTEM_RENT_FLOOR})`)
    console.log(`   master spends ${sol(BigInt(before) - BigInt(r.sim.accounts[1].lamports))} SOL per launch (rent + floor + tip + fee)`)
  }
}

// 2 and 3. buyback + burn
for (const mint of process.argv.slice(2)) {
  const bc = await online().fetchBondingCurve(new PublicKey(mint)).catch(() => null)
  if (!bc) { console.log(`\n== ${mint}: no bonding curve`); continue }
  const creator = bc.creator.toBase58()
  const v = (await readVaults([creator])).get(creator)
  const f = (await readCurves([mint])).get(mint)
  const graduated = !f || f.graduated
  console.log(`\n-- ${mint.slice(0, 6)}… ${graduated ? 'GRADUATED' : `curve ${(f.progress * 100).toFixed(1)}%`}, creator ${creator.slice(0, 6)}…, waiting: curve ${sol(v.curve)} SOL, amm ${sol(v.amm)} SOL`)
  // like production: a key below its floor is topped up by the master; above it, ignore the creator's own SOL
  const vaults = { key: v.key < SYSTEM_RENT_FLOOR ? v.key : SYSTEM_RENT_FLOOR, curve: v.curve, amm: v.amm }
  const supplyBefore = BigInt((await conn.getTokenSupply(new PublicKey(mint))).value.amount)
  let b = null, r = null
  for (const opts of VARIANTS) {
    b = await buybackIxs({ m: PAYER, k: creator, mint, vaults, graduated, assumeAccumulator: !!process.env.SIM_ASSUME_ACC, ...opts })
    if (!b) break
    if (b.initOnly) { r = await simulate('volume account init (master pays)', b.ixs, b.units); b = null; break }
    r = await simulate(`buyback + burn via ${b.buy.route}${b.private ? ' + jito tip' : ''}${opts.withCurve === false ? ', curve leg left' : ''}`, b.ixs, b.units, [], [mint])
    if (r.size <= 1232) break
  }
  if (!b) { if (!r) console.log('   nothing to spend (below MIN_BUYBACK_SOL)'); continue }
  if (!r.ok) continue
  const d = Buffer.from(r.sim.accounts[0].data[0], 'base64')
  const supplyAfter = d.readBigUInt64LE(36)
  const burned = supplyBefore - supplyAfter
  console.log(`   budget ${sol(b.plan.budget)} SOL, max cost ${sol(b.buy.maxSol)} SOL, bought ${Number(b.buy.tokens) / 10 ** DECIMALS} tokens`)
  console.log(`   supply ${supplyBefore} → ${supplyAfter}: burned ${burned} raw, ${burned === b.buy.tokens ? 'EXACTLY what was bought ✓' : 'MISMATCH ✗'}`)
}
