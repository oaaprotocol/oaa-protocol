# Architecture

OAA has three parts: the **website** (static, Netlify), the **OAA worker** (Cloudflare Worker with Workers AI and KV) and the **contracts** on Base.

## The OAA worker

| File | Purpose |
|---|---|
| `worker.js` | Entry point, security wrapper (body limit, method allowlist, security headers, CORS allowlist), Sia chat, routing |
| `agents.js` | The six agents, the CORE orchestrator, swaps, holder perks and the OAA Guardian |
| `market.js` | Market data and the ZEN signal engine (trend, RSI, MACD, levels) |
| `rug.js` | SENTINEL rug check (grade A–F) |
| `trade.js` | Swap quotes and unsigned transactions (the user signs them) |
| `proof.js` | PROOF: hourly Merkle batches of signals and Guardian briefs, anchored on Base |
| `x402.js` | x402 marketplace (discover and call paid APIs) and the 23 OAA services sold over x402 |
| `buy.js` | Buy $OAA with ETH, USDC, BNB, BTC or SOL (Relay cross-chain routing) |

## Request flow

1. The user (or another agent over x402) sends a question.
2. CORE detects the intent and runs the needed agents in parallel: AQL for token data, ZEN for signals, SENTINEL for risk, SCOUT for discovery, PROOF for the track record.
3. The combined data goes to the language model with strict rules: use only the numbers in the data, no advice to buy or sell.
4. Swaps come back as **unsigned transactions**. Only the user's wallet can sign them.

## Proof of Signal

- Every ZEN signal is hashed (`keccak256`) the moment it is published.
- Once an hour all signal hashes (and all Guardian brief hashes) are combined into one Merkle root: `root = keccak(signalsRoot ‖ briefsRoot)`.
- The root is anchored in a transaction on Base. Anyone can recompute it from the published batch data (`/x402/batch` or the Agentverse "Track record" view).

## Data sources

Coinbase Exchange (major coin candles), GeckoTerminal and DexScreener (Base pools), Blockscout (wallet tokens), Base RPC (on-chain reads), Coinbase x402 Bazaar (marketplace directory), Relay (cross-chain buy).
