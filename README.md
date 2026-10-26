# garlic

Fair launches on pump.fun. **Launched fair. Built to last.**

Every coin launched through garlic is a real pump.fun coin from its first block: same curve, same graduation, same apps. What changes is who launches it, what is allowed, and where its fees go.

Live at [usegarlic.xyz](https://www.usegarlic.xyz).

## How it works

**1. No dev in block 0.** Every coin is created by one master wallet, which pays the rent. There is no dev wallet and no dev buy. The create goes only to the Jito block engine as a bundle-only transaction, so nobody can ride inside it or see the mint before it exists. Bots can still buy in the next block; garlic does not claim otherwise.

**2. One coin per ticker, forever.** Before anything is signed, a new coin is checked against every coin on the board ([`engine/vamp.js`](engine/vamp.js)):

- Tickers are folded: case, spaces, punctuation, lookalike letters (Cyrillic, Greek, fullwidth, accents), leetspeak, doubled letters, and the suffixes vamps add (AI, INU, SOL, COIN, TOKEN, 2, V2, II, a leading THE). `$P3PE`, `$PEPE AI`, `$PEPPE` and `$THE PEPE 2` are all `$PEPE`.
- Names are folded the same way, minus "official", "real", "og", "coin" and friends.
- Pictures are fingerprinted (SHA-256 plus a 64-bit difference hash), so resized, recompressed or recoloured copies are refused.
- An X post, account or community backs one coin.
- A ticker already trading somewhere with real money (DexScreener) is refused.

**3. 100% of creator fees buy the coin back and burn it.** Each coin's creator on pump.fun is its own key, derived from the master secret ([`engine/solana.js`](engine/solana.js) `coinKeyFor`), so pump.fun pays that coin's fees to that key and nowhere else. Every 3 minutes ([`engine/burn.js`](engine/burn.js)), **one transaction** per coin:

1. collects the fees (bonding curve vault, and the PumpSwap vault after graduation),
2. buys the coin for an **exact** token amount, with the maximum cost capped at what was collected,
3. burns exactly that amount.

It lands whole or not at all; there is never a bought-but-unburned state. The master wallet pays the network fees, the token account and pump's volume account, so the coin's fees go 100% to the buyback. Every burn is a receipt measured from the confirmed transaction.

## What to trust, plainly

The coin keys are derived from the master wallet's key, which the operator holds: the buyback runs on this engine, not in an on-chain program. Everything it does is public, and each coin's creator address is shown on its page so anyone can check where its fees went. No buyback can promise that a price goes up.

## Layout

| Path | What |
|---|---|
| `engine/` | Node service: launch API, anti-vamp rules, the burn crank, receipts. Dry-run by default. |
| `engine/test/` | Unit tests: folding rules, picture copies, buyback planning, spend measurement, gates, signatures. |
| `engine/scripts/sim.mjs` | Simulates (never sends) the launch and buyback transactions against real mainnet coins. |
| `site/` | The website (Vite + React). The browser only signs a message; it never sends a transaction. |

## Run it

```bash
cd engine
cp .env.example .env      # fill in MASTER_PRIVATE_KEY, ADMIN_SECRET, GARLIC_RPC_URL
npm install
npm test
npm start                 # LIVE=false: every launch and burn is built and simulated, nothing is broadcast
```

```bash
cd site
npm install
ENGINE_URL=http://127.0.0.1:3214 npm run dev
```

Simulate the real transactions against mainnet without sending anything:

```bash
cd engine
SIM_RPC_URL=https://api.mainnet-beta.solana.com node scripts/sim.mjs <curveMint> <graduatedMint>
```

## Safety switches

- `LIVE=false` is the default. Nothing is broadcast until it is set to `true`.
- A file named `KILL` in the data directory stops every broadcast at once, without a restart.
- Hourly launch cap, one launch per wallet per hour, a minimum wallet balance for launchers, and launches pause when the master wallet runs low.
- Every transaction's signature is journaled before it is broadcast, and an unconfirmed transaction is never rebuilt.

## License

MIT. Not affiliated with pump.fun. Nothing here is financial advice.
