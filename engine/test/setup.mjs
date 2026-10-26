// Preloaded with `node --import` BEFORE any module runs, so config.js never sees a real .env's
// DATA_DIR: tests must never write into a live data directory.
import { rmSync } from 'fs'
import { Keypair } from '@solana/web3.js'
const dir = `./data-test-${process.pid}`
process.env.GARLIC_NO_DOTENV = '1'
process.env.GARLIC_NO_CRANKS = '1'
process.env.DATA_DIR = dir
process.env.LIVE = 'false'
process.env.GARLIC_RPC_URL = 'https://api.mainnet-beta.solana.com'
process.env.MASTER_PRIVATE_KEY = JSON.stringify([...Keypair.generate().secretKey])
process.on('exit', () => { if (/data-test/.test(dir)) try { rmSync(dir, { recursive: true, force: true }) } catch {} })
