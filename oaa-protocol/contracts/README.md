# OAA contracts

| Contract | Purpose |
|---|---|
| `OAALaunchpad.sol` | Launches a token on Base with an Aerodrome Slipstream pool. The LP position is locked **forever** inside the launchpad, the creator's first buy is locked for 30 months and then unlocks linearly over 12 months. Trading fees (1%) are split on-chain: 0.4% creator, 0.3% $OAA buyback & burn, 0.3% treasury. |
| `OAAToken.sol` | The standard token every launch deploys: fixed supply, no mint, no owner powers, no taxes, no blacklist. `poweredBy()` returns "OAA Protocol". |
| `test/Mocks.sol` | Test-only mocks (price feed, voter, legacy factory). Never deployed on mainnet. |

## Tests

The test suite (`test/launchpad.test.js`) runs every scenario on a local Hardhat chain against the real Aerodrome Slipstream contracts (pool, factory, position manager, router).

1. Get the Aerodrome Slipstream sources (https://github.com/aerodrome-finance/slipstream) into `contracts/slipstream` or set `SLIPSTREAM=/path/to/slipstream`.
2. Install solc 0.7.6 and set `SOLC=/path/to/solc-0.7.6`.
3. `python3 scripts/compile.py` writes `artifacts.json`.
4. `npm install hardhat ethers` and run `npx hardhat run test/launchpad.test.js`.

The OAA launchpad goes live as a beta after the $OAA launch. Deployed addresses will be listed here and on oaap.si, verified on BaseScan.
