# Security

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Send a private message to [@oaaprotocol on X](https://x.com/oaaprotocol) or open a private GitHub security advisory in this repository (Security → Advisories → Report a vulnerability). Include steps to reproduce. We answer as fast as we can.

## Principles

- No custody: the agents never hold or move user funds. Every swap and payment is signed in the user's own wallet.
- No secrets in code: all keys (keeper key, API keys, treasury settings) are encrypted Cloudflare variables and are never committed.
- Wallet-only access: no names, emails or other personal data are collected.
- Strict CORS allowlist, request size limit, method allowlist, security headers and a Content Security Policy with script hashes on the website.
- x402 payments are verified and settled by a facilitator; a call with invalid input is rejected before the payment is settled.

## Official links

Only links published on [oaap.si](https://oaap.si) are official. OAA will never DM you first, never ask for your seed phrase and never ask you to "validate" or "sync" a wallet.
