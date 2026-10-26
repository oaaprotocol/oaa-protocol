import http from 'http';
import fs from 'fs';
import crypto from 'crypto';
import { ethers } from 'ethers';
import * as M from './mock.mjs';
import { TEST_KEY } from './testkeys.mjs';
M.install({ local: 'http://127.0.0.1:8105' });
const w = (await import('../dist/worker.js')).default;
const LP = fs.readFileSync(new URL('./local/lp.txt', import.meta.url), 'utf8').trim(), FEED = fs.readFileSync(new URL('./local/feed.txt', import.meta.url), 'utf8').trim();
const kv = new Map(); const MEDIA = { get: async (k) => kv.has(k) ? kv.get(k) : null, put: async (k, v) => kv.set(k, v) };
const AI = { run: async (m, i) => ({ response: 'REPLY ' + (JSON.stringify(i).match(/TOOL DATA: (.{0,60})/) || ['', ''])[1] }) };
const TRE = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc';
const env = { AI, MEDIA, TREASURY: TRE, LAUNCHPAD: LP, BASE_RPC: 'http://127.0.0.1:8545', ETH_USD: FEED, X402_ALLOW_LOCAL: '1', AGENTS_PAID: '1' };
const O = 'https://oaap-x.netlify.app', BASE = 'https://api.oaap.si';
const post = (p, b) => w.fetch(new Request(BASE + p, { method: 'POST', headers: { Origin: O, 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' }, body: JSON.stringify(b) }), env).then(async (r) => [r.status, await r.json()]);
const ok = (c, m, x) => { console.log((c ? 'PASS ' : 'FAIL ') + m + (x !== undefined ? '  ' + JSON.stringify(x).slice(0, 260) : '')); if (!c) process.exitCode = 1; };
const pr = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
const fd = new ethers.Contract(FEED, ['function set(int256,uint256)'], await pr.getSigner(0)); const blk = await pr.getBlock('latest'); await (await fd.set(3500n * 10n ** 8n, blk.timestamp)).wait();
const lp = new ethers.Contract(LP, ['function allTokens(uint256) view returns (address)'], pr);
const t0 = await lp.allTokens(0), t1 = await lp.allTokens(1);
const sym = async (a) => new ethers.Contract(a, ['function symbol() view returns (string)'], pr).symbol();
const S0 = await sym(t0), S1 = await sym(t1);
M.TOKENS[t0.toLowerCase()] = M.pair(t0, S0, 'Token ' + S0, 0.0000351, 42000);
M.TOKENS[t1.toLowerCase()] = M.pair(t1, S1, 'Token ' + S1, 0.00002, 18000);
const DEG = '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed'; M.TOKENS[DEG.toLowerCase()] = M.pair(DEG, 'DEGEN', 'Degen', 0.0031, 2500000);
const seller = M.sellerServer(http, 8105);
const user = new ethers.Wallet(TEST_KEY(1), pr);

// config
let [st, j] = await post('/agent/config', {}); ok(st === 200 && j.swapFeeBps === 30 && j.x402.services.length === 23 && j.agents.aql.role === 'Trading Agent' && j.agents.core && !j.agents.fxa, 'config', { fee: j.swapFeeBps, svc: j.x402.services.map((s) => s.id) });

// signals
[st, j] = await post('/agent/signals', { tf: '1h' }); ok(st === 200 && j.board.length === 8 && j.board.every((b) => ['bullish', 'bearish', 'neutral'].includes(b.bias)), 'signal board majors', j.board.map((b) => b.asset + ':' + b.bias + ':' + b.confidence));
[st, j] = await post('/agent/signals', { kind: 'fx' }); ok(st === 200 && j.board.length === 8 && j.board.every((b) => b.kind !== 'forex'), 'no forex board anymore', j.board.slice(0, 2).map((b) => b.asset));
[st, j] = await post('/agent/signals', { asset: '$DEGEN' }); ok(st === 200 && j.signal.kind === 'base-token' && j.signal.token.liquidityUsd === 2500000 && j.signal.reasons.length >= 4, 'signal for base token', { bias: j.signal.bias, ind: j.signal.indicators, inv: j.signal.invalidation });
[st, j] = await post('/agent/signals', { asset: S1 }); ok(st === 200 && j.signal.reasons.some((r) => r.includes('Low liquidity')), 'low liquidity warning', j.signal.confidence);

// chats
const chat = (agent, content) => post('/agent/chat', { agent, messages: [{ role: 'user', content }] });
let ipn = 0; const chatX = (agent, content) => w.fetch(new Request(BASE + '/agent/chat', { method: 'POST', headers: { Origin: O, 'Content-Type': 'application/json', 'CF-Connecting-IP': '7.7.7.' + (++ipn) }, body: JSON.stringify({ agent, messages: [{ role: 'user', content }] }) }), env).then(async (r) => [r.status, await r.json()]);
[st, j] = await chat('zen', 'Signal für ETH auf 4h?'); ok(st === 200 && j.data.signal.asset === 'ETH' && j.data.signal.timeframe === '4h', 'zen ETH 4h', j.data.signal.bias);
[st, j] = await chatX('fxa', 'Wie steht GBP/JPY?'); ok(st === 400, 'fxa removed', st);
[st, j] = await chat('zen', 'signal for BTC'); ok(st === 200, 'zen BTC', st);
[st, j] = await chatX('core', 'Is $DEGEN safe and what does the 4h signal say?'); ok(st === 200 && j.data.agentsUsed.includes('ZEN') && j.data.agentsUsed.includes('SENTINEL') && j.data.agentsUsed.includes('AQL') && j.data.rugCheck && j.data.signal, 'core orchestrates ZEN + AQL + SENTINEL', j.data.agentsUsed);
[st, j] = await chatX('core', 'buy $20 of $DEGEN'); ok(st === 200 && j.action && j.action.token === DEG && j.data.agentsUsed.includes('AQL'), 'core prepares swap via AQL', j.data.agentsUsed);
[st, j] = await chatX('core', 'what is new and trending?'); ok(st === 200 && j.data.agentsUsed.includes('SCOUT') && j.data.trendingOnBase.length === 3, 'core uses SCOUT', j.data.agentsUsed);
[st, j] = await chatX('sentinel', 'is ' + t0 + ' safe?'); ok(st === 200 && j.data.rugCheck && j.data.rugCheck.grade, 'sentinel rug check', j.data.rugCheck && (j.data.rugCheck.grade || j.data.rugCheck.error));
[st, j] = await chatX('sentinel', 'hello'); ok(st === 200 && j.data.note, 'sentinel asks for a token', j.data.note);
[st, j] = await chatX('scout', 'what is moving?'); ok(st === 200 && j.data.trendingOnBase.length === 3 && j.data.oaaLaunches.length === 2, 'scout trending + launches', j.data.oaaLaunches.length);
[st, j] = await chatX('proof', 'how accurate is ZEN?'); ok(st === 200 && j.data.record, 'proof record', !!j.data.record);
[st, j] = await chat('aql', 'buy $20 of $DEGEN'); ok(st === 200 && j.action && j.action.token === DEG && j.action.amountUsd === 20 && j.data.token.market.symbol === 'DEGEN', 'aql buy usd any base token', j.action);
[st, j] = await chat('aql', 'was trendet gerade auf base?'); ok(st === 200 && j.data.trendingOnBase.length === 3 && j.data.oaaLaunches.length === 2, 'aql trending + launches', j.data.trendingOnBase.map((x) => x.name));
[st, j] = await chat('aql', 'sell 50% ' + S0); ok(st === 200 && j.action && j.action.side === 'sell' && j.action.percent === 50 && j.data.token.launchedOnOAA, 'aql sell launchpad token by plain symbol', j.action);
[st, j] = await chat('aql', 'check ' + t0); ok(st === 402, 'free quota exhausted after 5', st);

// swaps (real transactions on the local chain, router is an EOA in the mock)
[st, j] = await post('/agent/swap', { sender: user.address, side: 'buy', token: DEG, amountEth: 0.01 }); ok(st === 400 && j.error === 'not_a_token', 'swap rejects non-erc20', j);
[st, j] = await post('/agent/swap', { sender: user.address, side: 'buy', token: t0, amountUsd: 35 }); ok(st === 200 && j.tx.value === '0x' + (10n ** 16n).toString(16) && j.feeBps === 30 && !j.approve, 'swap buy $35 = 0.01 ETH', { value: j.tx.value, out: j.amountOut, to: j.tx.to });
const kyberRoute = M.calls.filter((c) => c.includes('/routes')).length; ok(kyberRoute >= 1, 'kyber called');
const rc = await (await user.sendTransaction({ to: j.tx.to, data: j.tx.data, value: j.tx.value })).wait(); ok(rc.status === 1, 'buy tx signed by user mined');
// give user some token0 to sell: buy on launchpad is complex, so transfer from creator via impersonation-free path: seed holder is signer 2/3
let bal = 0n, holder = null;
for (let i = 0; i < 6 && !bal; i++) { const s = await pr.getSigner(i); const b = await new ethers.Contract(t0, ['function balanceOf(address) view returns (uint256)'], pr).balanceOf(s.address); if (b > 0n) { holder = s; bal = b; } }
if (holder) await (await new ethers.Contract(t0, ['function transfer(address,uint256)'], holder).transfer(user.address, bal / 10n)).wait();
if (!holder) { await pr.send('hardhat_impersonateAccount', [LP]); await pr.send('hardhat_setBalance', [LP, '0x56BC75E2D63100000']); const lps = new ethers.JsonRpcSigner(pr, LP); const lb = await new ethers.Contract(t0, ['function balanceOf(address) view returns (uint256)'], pr).balanceOf(LP); await (await new ethers.Contract(t0, ['function transfer(address,uint256)'], lps).transfer(user.address, lb / 10n)).wait(); }
await (await new ethers.Contract(t0, ['function approve(address,uint256)'], user).approve(M.ROUTER, 0)).wait();
[st, j] = await post('/agent/swap', { sender: user.address, side: 'sell', token: t0, percent: 50 }); ok(st === 200 && j.approve && j.approve.spender.toLowerCase() === M.ROUTER.toLowerCase(), 'swap sell 50% needs approve', { amountIn: j.amountIn, approve: !!j.approve });
if (j.approve) { const r2 = await (await user.sendTransaction({ to: j.approve.token, data: j.approve.data })).wait(); ok(r2.status === 1, 'approve mined'); }
[st, j] = await post('/agent/swap', { sender: user.address, side: 'sell', token: t0, percent: 50 }); ok(st === 200 && !j.approve, 'after approve no approve needed');
[st, j] = await post('/agent/swap', { sender: '0x1111111111111111111111111111111111111111', side: 'sell', token: t1, percent: 100 }); ok(j.error === 'no_balance', 'sell without balance', j);

// marketplace discovery
[st, j] = await post('/agent/market', {}); ok(st === 200 && j.items.length === 2 && j.own.length === 23 && j.items[0].name === 'Mock Weather' && j.items[0].priceUsd === 0.001, 'market list (solana filtered, own services)', j.items.map((i) => i.name + ' $' + i.priceUsd + ' v' + i.x402Version + ' ' + JSON.stringify(i.input.queryParams)));
[st, j] = await post('/agent/market', { q: 'news' }); ok(j.items.length === 1 && j.items[0].name === 'Mock News', 'market search');

// marketplace paid call: 402 -> sign -> paid
async function payAndCall(item, query) {
  let [s1, r1] = await post('/agent/x402call', { url: item.url, method: item.method, query });
  if (s1 !== 200 || r1.status !== 402 || !r1.requirements.accepts.length) return ['no402', r1];
  const a = r1.requirements.accepts[0], v = r1.requirements.x402Version;
  const auth = { from: user.address, to: a.payTo, value: a.amount || a.maxAmountRequired, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: '0x' + crypto.randomBytes(32).toString('hex') };
  const sigx = await user.signTypedData({ name: a.extra.name, version: a.extra.version, chainId: 8453, verifyingContract: a.asset }, { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }, auth);
  const payload = v >= 2 ? { x402Version: 2, resource: r1.requirements.resource, accepted: a, payload: { signature: sigx, authorization: auth } } : { x402Version: 1, scheme: 'exact', network: 'base', payload: { signature: sigx, authorization: auth } };
  const [s2, r2] = await post('/agent/x402call', { url: item.url, method: item.method, query, payment: Buffer.from(JSON.stringify(payload)).toString('base64'), version: v });
  return [s2, r2, r1];
}
[st, j] = await post('/agent/market', {});
let [s, r, r402] = await payAndCall(j.items[0], { city: 'Berlin' }); ok(r.status === 200 && JSON.parse(r.body).weather === 'sunny' && r.settlement.success, 'x402 v1 call paid', { body: r.body, settlement: r.settlement });
[s, r, r402] = await payAndCall(j.items[1], { topic: 'base' }); ok(r.status === 200 && JSON.parse(r.body).headline && r.settlement && r.settlement.success && r402.requirements.x402Version === 2, 'x402 v2 call paid (header requirements)', r.body);
const strict = { ...env, X402_ALLOW_LOCAL: '0' };
const r5 = await w.fetch(new Request(BASE + '/agent/x402call', { method: 'POST', headers: { Origin: O, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:8105/weather' }) }), strict).then((x) => x.json()); ok(r5.error === 'bad_url', 'ssrf blocked in production', r5);
const r6 = await w.fetch(new Request(BASE + '/agent/x402call', { method: 'POST', headers: { Origin: O, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://10.0.0.1/x' }) }), strict).then((x) => x.json()); ok(r6.error === 'bad_url', 'private ip blocked', r6);

// our own seller endpoints
const g = (p, h = {}) => w.fetch(new Request(BASE + p, { headers: h }), env);
let res = await g('/x402'); let idx = await res.json(); ok(res.status === 200 && idx.services.length === 23 && idx.payTo === TRE && res.headers.get('Access-Control-Allow-Origin') === '*', 'x402 index', idx.services.map((x) => x.id + ' $' + x.priceUsd));
res = await g('/x402/signal?asset=ETH&tf=1h'); const reqd = JSON.parse(Buffer.from(res.headers.get('PAYMENT-REQUIRED'), 'base64').toString()); ok(res.status === 402 && reqd.accepts[0].payTo === TRE && reqd.accepts[0].amount === '100000', '402 with requirements', reqd.accepts[0]);
async function buyOwn(path, amount, to = TRE, v = 2) {
  const a = reqd.accepts[0];
  const auth = { from: user.address, to, value: amount, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: '0x' + crypto.randomBytes(32).toString('hex') };
  const sigx = await user.signTypedData({ name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: a.asset }, { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }, auth);
  const p = v === 2 ? { x402Version: 2, accepted: a, payload: { signature: sigx, authorization: auth } } : { x402Version: 1, scheme: 'exact', network: 'base', payload: { signature: sigx, authorization: auth } };
  return g(path, { [v === 2 ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT']: Buffer.from(JSON.stringify(p)).toString('base64') });
}
res = await buyOwn('/x402/signal?asset=ETH&tf=1h', '100000'); let body = await res.json(); ok(res.status === 200 && body.data.asset === 'ETH' && body.receipt.success && res.headers.get('PAYMENT-RESPONSE'), 'own signal sold (v2) -> treasury', { bias: body.data.bias, rcpt: body.receipt });
res = await buyOwn('/x402/token?token=' + DEG, '50000', TRE, 1); body = await res.json(); ok(res.status === 200 && body.data.symbol === 'DEGEN', 'own token check sold (v1)', body.data.priceUsd);
res = await buyOwn('/x402/signal?asset=ETH', '99999'); ok(res.status === 402, 'underpaid rejected');
res = await buyOwn('/x402/signal?asset=ETH', '100000', M.SELLER); ok(res.status === 402, 'wrong payTo rejected');
{ const cases = [['/x402/mtf?asset=ETH', '250000', (d) => d['1h'] && d['4h'] && d['1d'] && d.alignment], ['/x402/compare?assets=BTC,ETH&tf=4h', '400000', (d) => d.ranked && d.ranked.length === 2],
    ['/x402/price?asset=BTC', '50000', (d) => d.priceUsd > 0], ['/x402/rugbatch?tokens=' + t0, '1000000', (d) => d.results && d.results.length === 1 && d.results[0].grade],
    ['/x402/launches', '100000', (d) => Array.isArray(d.launches)], ['/x402/explain?token=' + t0, '500000', (d) => d.risk && d.risk.grade && 'summary' in d],
    ['/x402/diligence?token=' + DEG, '5000000', (d) => d.signals && d.risk && 'report' in d], ['/x402/board20?tf=4h', '1000000', (d) => Array.isArray(d) && d.length === 20]];
  for (const [u, amt, chk] of cases) { const r = await buyOwn(u, amt); const b = await r.json().catch(() => ({})); ok(r.status === 200 && chk(b.data || {}), 'own ' + u.split('?')[0] + ' sold for $' + Number(amt) / 1e6, r.status + ' ' + JSON.stringify(b).slice(0, 200)); }
  const bad = await buyOwn('/x402/rugcheck?token=nope', '150000'); ok(bad.status === 400, 'bad input -> 400, not charged', bad.status);
  const hi = await g('/x402/diligence?token=' + DEG); const rq = JSON.parse(Buffer.from(hi.headers.get('PAYMENT-REQUIRED'), 'base64').toString()); ok(rq.accepts[0].amount === '5000000', 'diligence costs $5', rq.accepts[0].amount); }
ok(kv.get('x4:signal') === '1' && kv.get('x4:token') === '1', 'sales counted', [kv.get('x4:signal'), kv.get('x4:token')]);
const noT = await w.fetch(new Request(BASE + '/x402/signal'), { ...env, TREASURY: '' }); ok(noT.status === 503, 'no treasury -> 503');
seller.close();
// own service through the marketplace proxy (in-process, no self-fetch)
{ const own = (await post('/agent/market', {}))[1].own.find((o) => o.url.endsWith('/x402/signal'));
  const [s1, r1] = await post('/agent/x402call', { url: own.url, method: 'GET', query: { asset: 'BTC', tf: '1h' } });
  ok(r1.status === 402 && r1.requirements.accepts[0].payTo === TRE, 'own service via proxy -> 402', r1.requirements && r1.requirements.x402Version);
  const a = r1.requirements.accepts[0];
  const auth = { from: user.address, to: a.payTo, value: a.amount, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: '0x' + crypto.randomBytes(32).toString('hex') };
  const sx = await user.signTypedData({ name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: a.asset }, { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }, auth);
  const pay = Buffer.from(JSON.stringify({ x402Version: 2, resource: r1.requirements.resource, accepted: a, payload: { signature: sx, authorization: auth } })).toString('base64');
  const [s2, r2] = await post('/agent/x402call', { url: own.url, method: 'GET', query: { asset: 'BTC', tf: '1h' }, payment: pay, version: 2 });
  ok(r2.status === 200 && JSON.parse(r2.body).data.asset === 'BTC' && r2.settlement.success, 'own service paid via proxy', JSON.parse(r2.body).receipt);
  const core = (await post('/agent/market', {}))[1].own.find((o) => o.url.endsWith('/x402/core'));
  const [c1, q1] = await post('/agent/x402call', { url: core.url, method: 'GET', query: { q: 'Is $DEGEN safe? 4h signal?' } });
  const b = q1.requirements.accepts[0]; ok(q1.status === 402 && b.amount === '250000', 'core service costs $0.25', b.amount);
  const auth2 = { from: user.address, to: b.payTo, value: b.amount, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: '0x' + crypto.randomBytes(32).toString('hex') };
  const sy = await user.signTypedData({ name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: b.asset }, { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }, auth2);
  const pay2 = Buffer.from(JSON.stringify({ x402Version: 2, resource: q1.requirements.resource, accepted: b, payload: { signature: sy, authorization: auth2 } })).toString('base64');
  const [c2, q2] = await post('/agent/x402call', { url: core.url, method: 'GET', query: { q: 'Is $DEGEN safe? 4h signal?' }, payment: pay2, version: 2 });
  const cb = JSON.parse(q2.body); ok(q2.status === 200 && cb.data.agentsUsed.includes('SENTINEL') && cb.data.agentsUsed.includes('ZEN') && typeof cb.data.answer === 'string', 'core service paid: orchestrated answer', cb.data.agentsUsed);
  ok(!M.calls.some((c) => c.startsWith('https://api.oaap.si')), 'no self-fetch'); }
