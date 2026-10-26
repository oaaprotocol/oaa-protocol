import fs from 'fs';
import { ethers } from 'ethers';
import * as M from './mock.mjs';
import { TEST_KEY } from './testkeys.mjs';
M.install({ local: 'http://127.0.0.1:8107' });
const w = (await import('../dist/worker.js')).default;
const P = await import('./proof.js');
const LP = fs.readFileSync(new URL('./local/lp.txt', import.meta.url), 'utf8').trim(), FEED = fs.readFileSync(new URL('./local/feed.txt', import.meta.url), 'utf8').trim();
const pr = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
const kv = new Map(); const MEDIA = { get: async (k) => kv.has(k) ? kv.get(k) : null, put: async (k, v) => kv.set(k, v) };
const KEY = TEST_KEY(9);
const env = { AI: { run: async () => ({ response: 'ok' }) }, MEDIA, TREASURY: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc', LAUNCHPAD: LP, BASE_RPC: 'http://127.0.0.1:8545', ETH_USD: FEED, KEEPER_KEY: KEY };
const ok = (c, m, x) => { console.log((c ? 'PASS ' : 'FAIL ') + m + (x !== undefined ? '  ' + JSON.stringify(x).slice(0, 300) : '')); if (!c) process.exitCode = 1; };
const post = (p, b) => w.fetch(new Request('https://api.oaap.si' + p, { method: 'POST', headers: { Origin: 'https://oaap.netlify.app', 'Content-Type': 'application/json', 'CF-Connecting-IP': '3.3.3.3' }, body: JSON.stringify(b) }), env).then(async (r) => [r.status, await r.json()]);
const lp = new ethers.Contract(LP, ['function allTokens(uint256) view returns (address)'], pr);
const HALL = await lp.allTokens(0);
const sym = await new ethers.Contract(HALL, ['function symbol() view returns (string)'], pr).symbol();
M.TOKENS[HALL.toLowerCase()] = M.pair(HALL, sym, 'Hall', 0.0000351, 42000);
// bad token on chain
const B = JSON.parse(fs.readFileSync('./bad/bad.json'));
const dep = await pr.getSigner(5);
const bad = await new ethers.ContractFactory(B.abi, B.bytecode, dep).deploy(); await bad.waitForDeployment(); const BAD = (await bad.getAddress()).toLowerCase();
const bp = M.pair(BAD, 'BAD', 'Bad Token', 0.001, 6000); bp.txns.h24 = { buys: 80, sells: 0 }; bp.pairCreatedAt = Date.now() - 3600e3; M.TOKENS[BAD] = bp;
M.SCOUT[BAD] = { verified: false, holders: [{ address: (await dep.getAddress()).toLowerCase(), value: (9n * 10n ** 26n).toString() }, { address: '0x000000000000000000000000000000000000beef', value: (10n ** 26n).toString() }] };
M.SCOUT[HALL.toLowerCase()] = { verified: true, holders: [{ address: LP.toLowerCase(), value: '1' }] };

// ---- rug check
let [st, r] = await post('/agent/rug', { token: BAD });
ok(st === 200 && r.grade === 'F' && r.risk === 'very high', 'bad token gets F', { score: r.score, checks: r.checks.map((c) => c.id + ':' + c.status) });
ok(['mint', 'blacklist', 'fees', 'honeypot', 'verified', 'owner', 'holders', 'liquidity', 'age'].every((id) => r.checks.find((c) => c.id === id && c.status !== 'ok')), 'all red flags found');
[st, r] = await post('/agent/rug', { token: HALL });
ok(st === 200 && r.launchedOnOAA && ['A', 'B'].includes(r.grade) && r.checks.find((c) => c.id === 'functions' && c.status === 'ok') && !r.owner && !r.upgradeable, 'OAA launchpad token gets A/B', { score: r.score, grade: r.grade, checks: r.checks.map((c) => c.id + ':' + c.status) });
[st, r] = await post('/agent/rug', { token: '$' + sym }); ok(st === 200 && r.address === HALL.toLowerCase(), 'rug check by symbol');
[st, r] = await post('/agent/rug', { token: '0x' + '12'.repeat(20) }); ok(st === 400 && r.error === 'not_a_contract', 'EOA rejected', r);
[st, r] = await post('/agent/chat', { agent: 'aql', messages: [{ role: 'user', content: 'is ' + BAD + ' safe?' }] }); ok(st === 200 && r.data.rugCheck && r.data.rugCheck.grade === 'F', 'AQL chat uses the rug check');
const g = await w.fetch(new Request('https://api.oaap.si/x402/rugcheck?token=' + BAD), env); ok(g.status === 402 && JSON.parse(Buffer.from(g.headers.get('PAYMENT-REQUIRED'), 'base64').toString()).accepts[0].amount === '150000', 'rugcheck sold over x402 ($0.15)');

// ---- proof of signal
const T0 = Date.UTC(2026, 9, 24, 0, 5); // 00:05 UTC: 1h + 4h + 1d + fx
await pr.send('hardhat_setBalance', [new ethers.Wallet(KEY).address, '0x16345785D8A0000']);
const bal0 = await pr.getBalance(new ethers.Wallet(KEY).address);
let h = await P.hourly(env, T0);
ok(h.count === 8 + 8 + 8 && /^0x[0-9a-f]{64}$/.test(h.tx), 'batch at 00:05 has 24 signals (no forex) and is anchored', { count: h.count, tx: h.tx, err: h.anchorError });
const tx = await pr.getTransaction(h.tx); const rc = await pr.getTransactionReceipt(h.tx);
ok(rc.status === 1 && tx.to.toLowerCase() === tx.from.toLowerCase() && tx.value === 0n && tx.data === P.anchorData(h.batchId, h.root, h.count), 'anchor tx: 0 ETH to itself, input = QSIG + root');
let again = await P.hourly(env, T0 + 60000); ok(again.skipped === 'exists', 'same hour is not logged twice');
const h2 = await P.hourly(env, T0 + 3600e3); ok(h2.count === 8, 'next hour only 1h signals', h2.count);
// public batch + independent verification
const res = await w.fetch(new Request('https://api.oaap.si/proof/batch/' + h.batchId), env); const b = await res.json();
const leaves = b.signals.map((s) => ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({ id: s.id, asset: s.asset, kind: s.kind, tf: s.tf, bias: s.bias, score: s.score, confidence: s.confidence, price: s.price, createdAt: s.createdAt, horizonH: s.horizonH }))));
const root = ethers.keccak256(ethers.concat(leaves));
ok(res.headers.get('Access-Control-Allow-Origin') === '*' && root === b.root && tx.data.slice(10, 10 + 2 + 64).slice(2) === root.slice(2), 'anyone can recompute the root and match it with the tx on Base');
// nothing scored before horizon
let [s1, rec] = await post('/agent/record', {}); ok(s1 === 200 && rec.total.n === 0 && rec.anchored && rec.lastBatch.count === 8, 'no results before horizon', rec.total);
// price rises 5%, 25h later: bullish 1h signals hit, bearish miss
M.PM.v = 1.05; (await import('./market.js')).clearCache();
const h3 = await P.hourly(env, T0 + 25 * 3600e3);
[s1, rec] = await post('/agent/record', {});
const one = b.signals.filter((s) => s.tf === '1h');
const exp = one.filter((s) => s.bias !== 'neutral'), hits = exp.filter((s) => s.bias === 'bullish').length;
ok(rec.byTimeframe['1h'] && rec.byTimeframe['1h'].n >= exp.length && h3.scored >= one.length, '1h signals of first batch scored after 24h', { scored: h3.scored, byTf: rec.byTimeframe, expected: exp.length });
ok(!rec.byTimeframe['4h'] && !rec.byTimeframe['1d'], '4h and 1d signals still open');
const first = rec.recent.filter((x) => x.batch === h.batchId);
ok(first.every((x) => x.bias === 'neutral' ? x.hit === null : x.bias === 'bullish' ? x.hit === true : x.hit === false) && first.every((x) => x.tx === h.tx), 'hits computed correctly, recent rows link the anchor tx', first.slice(0, 3).map((x) => x.asset + ' ' + x.bias + ' ' + x.change + '% ' + x.hit));
const b2 = await (await w.fetch(new Request('https://api.oaap.si/proof/batch/' + h.batchId), env)).json();
ok(b2.root === b.root && b2.signals.filter((s) => s.result).length === one.length, 'results added later do not change the committed root');
console.log('INFO record', JSON.stringify({ total: rec.total, byAsset: rec.byAsset.slice(0, 3) }));
// without keeper: still logged
const env2 = { ...env, KEEPER_KEY: '' }; const h4 = await P.hourly(env2, T0 + 30 * 3600e3); ok(h4.count === 8 && !h4.tx, 'without KEEPER_KEY: logged but not anchored');
const bal1 = await pr.getBalance(new ethers.Wallet(KEY).address); console.log('INFO keeper gas spent (local chain)', ethers.formatEther(bal0 - bal1), 'ETH for', 3, 'anchors');
// cron entry
let waited; await w.scheduled({ scheduledTime: T0 + 40 * 3600e3 }, env, { waitUntil: (p) => { waited = p; } }); await waited;
ok(kv.has('b:' + Math.floor((T0 + 40 * 3600e3) / 3600e3)), 'scheduled() runs the hourly job');

// ---- OAA Guardian
{
  const W = '0x' + '5a'.repeat(20);
  M.GUARD[W] = [
    { token: { address_hash: HALL, symbol: sym, name: 'Hall', decimals: '18', exchange_rate: '0.0000351' }, value: (2000000n * 10n ** 18n).toString() },
    { token: { address_hash: BAD, symbol: 'BAD', name: 'Bad Token', decimals: '18', exchange_rate: '0.001' }, value: (50000n * 10n ** 18n).toString() },
  ];
  const g = (b, ip) => w.fetch(new Request('https://api.oaap.si/agent/guardian', { method: 'POST', headers: { Origin: 'https://oaap.netlify.app', 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify(b) }), env).then(async (r) => [r.status, await r.json()]);
  let [st, r] = await g({ wallet: W }, '6.6.6.6');
  const bad = r.tokens && r.tokens.find((t) => t.symbol === 'BAD'), hall = r.tokens && r.tokens.find((t) => t.address === HALL.toLowerCase());
  ok(st === 200 && r.tokens.length === 2 && r.tokens[0].address === HALL.toLowerCase() && bad.grade && ['D', 'F'].includes(bad.grade) && bad.flags.length > 0 && hall && ['A', 'B'].includes(hall.grade), 'guardian: tokens graded by SENTINEL, sorted by value', r.tokens && r.tokens.map((t) => t.symbol + ':' + t.grade + ':' + Math.round(t.valueUsd)));
  ok(st === 200 && r.health >= 0 && r.health < 70 && typeof r.brief === 'string' && /^0x[0-9a-f]{64}$/.test(r.proof.hash) && /queued/.test(r.proof.status) && r.scansLeft === 0 && !r.holder, 'guardian: health score, brief, proof hash queued, free scan used', { health: r.health, proof: r.proof.status });
  [st, r] = await g({ wallet: W }, '6.6.6.6'); ok(st === 429 && r.error === 'limit', 'guardian: 1 free scan per day for non-holders');
  [st, r] = await g({ wallet: 'nope' }, '6.6.6.7'); ok(st === 400, 'guardian: bad wallet rejected');
  const qd = JSON.parse(kv.get('gq') || '[]'); ok(qd.length === 1, 'brief hash waiting in the proof queue');
  const h = await P.hourly(env, Date.UTC(2031, 0, 1, 7, 5));
  const b = JSON.parse(kv.get('b:' + h.batchId));
  ok(h.briefs === 1 && b.briefs.length === 1 && b.root === P.combinedRoot(b.sigRoot, P.briefsRootOf(b.briefs)) && JSON.parse(kv.get('gq')).length === 0, 'brief anchored in the next hourly batch (combined root)', { root: b.root });
}
