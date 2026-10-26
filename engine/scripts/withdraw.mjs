// Withdraw SOL from the master wallet. Run by the operator, on the engine host:
//   node scripts/withdraw.mjs <to-address> <sol>
// Refuses a bad address, the master itself, or an amount that would leave the master unable to pay
// its own fee. Prints the balance before and after, and the signature.
import { PublicKey, SystemProgram } from '@solana/web3.js'
import { getMaster, submit, balanceOf, sol, toLamports, isPubkey } from '../solana.js'
import { config } from '../config.js'

const [to, amount] = process.argv.slice(2)
const master = getMaster()
if (!master) throw new Error('MASTER_PRIVATE_KEY not set')
if (!isPubkey(to)) throw new Error(`not a Solana address: ${to}`)
if (to === master.publicKey.toBase58()) throw new Error('that is the master itself')
const lamports = toLamports(Number(amount))
if (!(lamports > 0n)) throw new Error('amount must be a positive number of SOL')

const before = await balanceOf(master.publicKey)
if (lamports + 20_000n > before) throw new Error(`master holds ${sol(before)} SOL, cannot send ${amount}`)
const left = sol(before - lamports)
if (left < config.masterFloorSol) console.warn(`[withdraw] note: ${left} SOL left is below MASTER_FLOOR_SOL (${config.masterFloorSol}); launches will pause until it is topped up`)

console.log(`[withdraw] ${amount} SOL  ${master.publicKey.toBase58()} → ${to}  (master has ${sol(before)} SOL)`)
const r = await submit({
  payer: master.publicKey,
  instructions: [SystemProgram.transfer({ fromPubkey: master.publicKey, toPubkey: new PublicKey(to), lamports })],
  signers: [master], units: 2_000, what: `withdraw ${amount} SOL`,
})
if (r.dryRun) { console.log('[withdraw] LIVE=false: simulated only, nothing sent'); process.exit(0) }
console.log(`[withdraw] sent: https://solscan.io/tx/${r.sig}`)
console.log(`[withdraw] master now ${sol(await balanceOf(master.publicKey))} SOL`)
process.exit(0)
