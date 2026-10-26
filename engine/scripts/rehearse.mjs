// The go-live rehearsal, run ON the engine host against the live engine (LIVE=true):
//   node scripts/rehearse.mjs fund <sol>        master → a fresh test wallet (data/rehearsal-wallet.json)
//   node scripts/rehearse.mjs launch            the test wallet signs + launches "garlic rehearsal" $REHEARSAL
//   node scripts/rehearse.mjs trade <sol>       the test wallet buys <sol> of it, then sells everything back
//   node scripts/rehearse.mjs status            vaults, pending, receipts, supply
//   node scripts/rehearse.mjs sweep             test wallet → master (everything)
// It goes through the public API exactly like a visitor would; trades are plain pump.fun trades.
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { createRequire } from 'module'
import BN from 'bn.js'
import sharp from 'sharp'
import bs58 from 'bs58'
import { ed25519 } from '@noble/curves/ed25519'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { config } from '../config.js'
import { getMaster, getConnection, submit, balanceOf, sol, toLamports } from '../solana.js'
import { online, ctx, tokenProgramOf, readVaults, readSupplies } from '../pump.js'
import { readCoins, readReceipts } from '../store.js'
import { sha256 } from '../images.js'

const require = createRequire(import.meta.url)
const { PUMP_SDK, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } = require('@pump-fun/pump-sdk')

const API = `http://127.0.0.1:${config.port}/api`
const WALLET = `${config.dataDir}/rehearsal-wallet.json`
const NAME = 'garlic rehearsal', SYMBOL = 'REHEARSAL'

function wallet() {
  if (!existsSync(WALLET)) {
    const k = Keypair.generate()
    writeFileSync(WALLET, JSON.stringify([...k.secretKey]), { mode: 0o600 })
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(WALLET, 'utf8'))))
}
const coin = () => readCoins().find(c => c.symbol === SYMBOL && c.status === 'live')
const post = async (path, body) => {
  const r = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

const [cmd, arg] = process.argv.slice(2)
const w = wallet()
const master = getMaster()

if (cmd === 'fund') {
  const r = await submit({ payer: master.publicKey, instructions: [SystemProgram.transfer({ fromPubkey: master.publicKey, toPubkey: w.publicKey, lamports: toLamports(Number(arg || 0.25)) })], signers: [master], units: 20_000, what: 'fund rehearsal wallet' })
  console.log('funded', w.publicKey.toBase58(), r.sig)
}

if (cmd === 'launch') {
  // a plain picture of its own, so it can never clash with $GARLIC's later
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#0f1a14"/><circle cx="256" cy="230" r="120" fill="none" stroke="#86efac" stroke-width="18"/><text x="256" y="430" font-family="Arial" font-size="58" font-weight="700" fill="#86efac" text-anchor="middle">REHEARSAL</text></svg>`
  const img = await sharp(Buffer.from(svg)).png().toBuffer()
  const ts = Date.now()
  const d = { name: NAME, symbol: SYMBOL, description: 'The first coin through garlic: the go-live rehearsal. No dev buy; every fee it earns buys it back and burns it, like every coin here.', x: '', telegram: '', website: '' }
  const { body: { message } } = await post('/launch-message', { ...d, imageSha: sha256(img), ts })
  const signature = bs58.encode(ed25519.sign(new TextEncoder().encode(message), w.secretKey.slice(0, 32)))
  const r = await post('/launch', { ...d, wallet: w.publicKey.toBase58(), signature, ts, image: `data:image/png;base64,${img.toString('base64')}` })
  console.log(r.status, JSON.stringify(r.body).slice(0, 400))
}

if (cmd === 'trade') {
  const c = coin()
  if (!c) throw new Error('no live rehearsal coin')
  const mint = new PublicKey(c.mint)
  const lamports = toLamports(Number(arg || 0.2))
  const { global, feeConfig } = await ctx()
  const tokenProgram = await tokenProgramOf(c.mint)
  // buy
  const bs = await online().fetchBuyState(mint, w.publicKey, tokenProgram, NATIVE_MINT)
  const tokens = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: bs.bondingCurve.tokenTotalSupply, bondingCurve: bs.bondingCurve, amount: new BN(lamports.toString()), quoteMint: NATIVE_MINT })
  const buyIxs = await PUMP_SDK.buyInstructions({ global, bondingCurveAccountInfo: bs.bondingCurveAccountInfo, bondingCurve: bs.bondingCurve, associatedUserAccountInfo: bs.associatedUserAccountInfo, mint, user: w.publicKey, amount: tokens, solAmount: new BN(lamports.toString()), slippage: 5, tokenProgram })
  const b = await submit({ payer: w.publicKey, instructions: buyIxs, signers: [w], units: 250_000, what: `rehearsal buy ${sol(lamports)} SOL` })
  console.log('bought', tokens.toString(), b.sig)
  await new Promise(r => setTimeout(r, 4000))
  // sell everything back
  const ata = getAssociatedTokenAddressSync(mint, w.publicKey, true, tokenProgram)
  const held = new BN((await getConnection().getTokenAccountBalance(ata, 'confirmed')).value.amount)
  const ss = await online().fetchSellState(mint, w.publicKey, tokenProgram, NATIVE_MINT)
  const solOut = getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: ss.bondingCurve.tokenTotalSupply, bondingCurve: ss.bondingCurve, amount: held, quoteMint: NATIVE_MINT })
  const sellIxs = await PUMP_SDK.sellInstructions({ global, bondingCurveAccountInfo: ss.bondingCurveAccountInfo, bondingCurve: ss.bondingCurve, mint, user: w.publicKey, amount: held, solAmount: solOut, slippage: 5, tokenProgram })
  const s = await submit({ payer: w.publicKey, instructions: sellIxs, signers: [w], units: 250_000, what: 'rehearsal sell all' })
  console.log('sold', held.toString(), 'for ~', sol(BigInt(solOut.toString())), 'SOL', s.sig)
}

if (cmd === 'status' || !cmd) {
  const c = coin()
  console.log('master', sol(await balanceOf(master.publicKey)), 'SOL | test wallet', w.publicKey.toBase58(), sol(await balanceOf(w.publicKey)), 'SOL')
  if (c) {
    const v = (await readVaults([c.coinKey])).get(c.coinKey)
    const sup = (await readSupplies([c.mint])).get(c.mint)
    console.log(`$${c.symbol} ${c.mint} | key ${c.coinKey} ${sol(v.key)} SOL | waiting curve ${sol(v.curve)} amm ${sol(v.amm)} | supply ${sup} | pending ${c.pending ? c.pending.sig : '-'} | lastError ${c.lastError || '-'}`)
    for (const r of readReceipts().filter(x => x.mint === c.mint)) console.log('  receipt', r.sig, r.tokens, 'tokens', r.sol, 'SOL', r.route)
  }
}

if (cmd === 'sweep') {
  const bal = await balanceOf(w.publicKey)
  // leave exactly 0 behind (anything between 0 and the rent floor is refused): base fee + priority fee
  const units = 2_000
  const fee = 5_000n + BigInt(Math.ceil(units * config.priorityFeeMicroLamports / 1e6))
  if (bal > fee) {
    const r = await submit({ payer: w.publicKey, instructions: [SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: master.publicKey, lamports: bal - fee })], signers: [w], units, what: 'sweep rehearsal wallet' })
    console.log('swept', sol(bal), r.sig)
  }
}
process.exit(0)
