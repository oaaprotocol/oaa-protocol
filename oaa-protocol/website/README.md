# OAA website

The deploy-ready website of [oaap.si](https://oaap.si), hosted on Netlify.

- `index.html` is the whole site: launch hall with countdown, Launchpad, Agentverse, Portal, Docs, Blog, Updates, Contact and Sia.
- `netlify.toml` sets the security headers and the Content Security Policy (script hashes).
- `locks.json` lists the lock links shown in the tokenomics. Every address is checked on the worker before it is shown.

Deploy: drag this folder into Netlify (Sites → Deploys).
