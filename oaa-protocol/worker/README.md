# OAA worker (Cloudflare)

The six OAA agents, Sia, the x402 services and the buy flow run in one Cloudflare Worker with Workers AI and one KV namespace.

## Deploy

1. `npm install`
2. `npm run build` bundles `src/worker.js` into `dist/worker.js`.
3. Copy `wrangler.example.toml` to `wrangler.toml`, add your KV namespace id, then `npx wrangler deploy`.

## Settings

Set these in Cloudflare → Workers → Settings → Variables. **Secrets must be added as encrypted secrets and never committed.**

| Name | Type | Purpose |
|---|---|---|
| `AI` | binding | Workers AI |
| `MEDIA` | KV binding | logos, sessions, proof batches, counters |
| `TREASURY` | variable | treasury multisig, receives x402 and app fees |
| `OAA_TOKEN` | variable | $OAA token address (set at launch) |
| `LAUNCHPAD` | variable | OAA launchpad address |
| `BASE_RPC` | variable | Base RPC URL |
| `ETH_USD` | variable | Chainlink ETH/USD feed |
| `SWAP_FEE_BPS`, `BUY_FEE_BPS` | variable | platform fees in basis points (default 30) |
| `HOLDER_MIN`, `HOLDER_MULT` | variable | holder perk threshold and multiplier |
| `ALLOWED_ORIGINS` | variable | extra allowed website origins |
| `FACILITATOR_URL` | variable | x402 facilitator (default PayAI) |
| `KEEPER_KEY` | **secret** | wallet that anchors the hourly proof root on Base (holds only gas) |
| `RELAY_API_KEY` | **secret** | Relay cross-chain routing |
| `FACILITATOR_KEY` | **secret** | optional facilitator key |

## Tests

`test/` holds the full test suite with mocks for every external API and a local Hardhat chain. The test keys come from Hardhat's public default mnemonic (`test/testkeys.mjs`) and only exist on a local chain.
