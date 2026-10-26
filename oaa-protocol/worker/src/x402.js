// OAA x402: marketplace (discover + call paid APIs) and our own agents sold over x402.
// Buying: the user signs a USDC payment (EIP-3009) in their own wallet; this worker only forwards the request,
//         because most x402 servers do not allow browser (CORS) calls. It never holds or moves funds.
// Selling: /x402/<service> answers with HTTP 402. Payments go to TREASURY in USDC on Base and are
//          verified and settled by an x402 facilitator (FACILITATOR_URL, default PayAI).
import { signalFor, signalBoard, tokenByAddress, tokenBySymbol, trendingBase, lastPrice, MAJORS, USDC } from './market.js';
import { rugCheck } from './rug.js';
import { record, batch } from './proof.js';

const BAZAAR = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery';
const b64 = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const unb64 = (s) => JSON.parse(decodeURIComponent(escape(atob(s))));
const isBase = (n) => n === 'base' || n === 'eip155:8453';
const amountOf = (a) => a.amount != null ? a.amount : a.maxAmountRequired;

// ---------- marketplace: discovery ----------
const memo = new Map();
async function fetchJson(url, ms = 10000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctl.signal }); if (!r.ok) throw new Error('http ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
function normalize(it) {
  const acc = (it.accepts || []).filter((a) => isBase(a.network) && a.scheme === 'exact' && String(a.asset || '').toLowerCase() === USDC.toLowerCase());
  if (!acc.length) return null;
  const a = acc.slice().sort((x, y) => Number(amountOf(x)) - Number(amountOf(y)))[0];
  const info = ((it.extensions || {}).bazaar || {}).info || {};
  const legacyOut = a.outputSchema || {};
  const input = info.input || legacyOut.input || {};
  let host = ''; try { host = new URL(it.resource).hostname; } catch { return null; }
  return {
    url: it.resource, name: it.serviceName || host, host, description: String(it.description || a.description || '').slice(0, 400),
    priceUsd: Number(amountOf(a)) / 1e6, payTo: a.payTo, network: 'base', x402Version: it.x402Version || 1,
    method: String(input.method || 'GET').toUpperCase(), input: { queryParams: input.queryParams || null, body: input.body || input.bodyFields || null },
    outputExample: info.output && info.output.example !== undefined ? info.output.example : null,
    calls30d: it.quality ? Number(it.quality.l30DaysTotalCalls || 0) : null, payers30d: it.quality ? Number(it.quality.l30DaysUniquePayers || 0) : null,
    lastCalledAt: it.quality ? it.quality.lastCalledAt || null : null, tags: (it.tags || []).slice(0, 5), icon: it.iconUrl || null, curated: !!it.curated,
  };
}
export async function discover(q, maxUsd) {
  const key = 'd:' + (q || '') + ':' + (maxUsd || '');
  const hit = memo.get(key); if (hit && hit.exp > Date.now()) return hit.val;
  let items;
  if (q) { const j = await fetchJson(BAZAAR + '/search?query=' + encodeURIComponent(q.slice(0, 200)) + '&network=eip155:8453&limit=20' + (maxUsd ? '&maxUsdPrice=' + maxUsd : '')); items = j.resources || []; }
  else { const j = await fetchJson(BAZAAR + '/resources?type=http&limit=100'); items = j.items || []; }
  const seen = new Set();
  const val = items.map(normalize).filter((x) => x && !seen.has(x.url) && seen.add(x.url))
    .sort((a, b) => (b.calls30d || 0) - (a.calls30d || 0));
  memo.set(key, { val, exp: Date.now() + 120000 }); if (memo.size > 300) memo.clear();
  return val;
}

// ---------- marketplace: paid call proxy ----------
function safeUrl(u, env) {
  let x; try { x = new URL(u); } catch { return null; }
  const local = env.X402_ALLOW_LOCAL === '1';
  if (x.protocol !== 'https:' && !(local && x.protocol === 'http:')) return null;
  const h = x.hostname.toLowerCase();
  if (!local && (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':') || h.startsWith('['))) return null;
  if (x.username || x.password) return null;
  return x;
}
function readRequirements(r, text) {
  const h = r.headers.get('PAYMENT-REQUIRED') || r.headers.get('payment-required');
  let pr = null;
  if (h) { try { pr = unb64(h); } catch {} }
  if (!pr) { try { pr = JSON.parse(text); } catch {} }
  if (!pr || !Array.isArray(pr.accepts)) return null;
  const accepts = pr.accepts.filter((a) => isBase(a.network) && a.scheme === 'exact' && String(a.asset || '').toLowerCase() === USDC.toLowerCase());
  return { x402Version: pr.x402Version || 1, resource: pr.resource || null, accepts, error: pr.error || null };
}
export async function callPaid(env, body, self) {
  const x = safeUrl(String(body.url || ''), env); if (!x) return { error: 'bad_url' };
  const method = body.method === 'POST' ? 'POST' : 'GET';
  if (body.query && typeof body.query === 'object') for (const [k, v] of Object.entries(body.query).slice(0, 20)) if (v !== '' && v != null) x.searchParams.set(String(k).slice(0, 60), String(v).slice(0, 500));
  const headers = { Accept: 'application/json, text/plain, */*', 'User-Agent': 'OAA-x402/1.0' };
  if (body.payment) {
    if (typeof body.payment !== 'string' || body.payment.length > 8000) return { error: 'bad_payment' };
    if (Number(body.version) >= 2) headers['PAYMENT-SIGNATURE'] = body.payment; else headers['X-PAYMENT'] = body.payment;
  }
  let payload;
  if (method === 'POST') { headers['Content-Type'] = 'application/json'; payload = typeof body.body === 'string' ? body.body.slice(0, 20000) : JSON.stringify(body.body || {}).slice(0, 20000); }
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 25000);
  const own = self && x.origin === self.origin && x.pathname.startsWith('/x402/');
  let r; try { r = own ? await sellerRoutes(new Request(x.toString(), { method, headers }), env, x) : await fetch(x.toString(), { method, headers, body: payload, redirect: 'manual', signal: ctl.signal }); } catch { clearTimeout(t); return { error: 'unreachable' }; }
  clearTimeout(t);
  const buf = new Uint8Array(await r.arrayBuffer()); const text = new TextDecoder().decode(buf.slice(0, 200000));
  if (r.status === 402) {
    const req = readRequirements(r, text);
    return { status: 402, requirements: req, paid: !!body.payment, message: req && req.error ? String(req.error).slice(0, 200) : null };
  }
  const pr = r.headers.get('PAYMENT-RESPONSE') || r.headers.get('X-PAYMENT-RESPONSE');
  let settlement = null; if (pr) { try { settlement = unb64(pr); } catch {} }
  return { status: r.status, contentType: (r.headers.get('Content-Type') || '').slice(0, 100), body: text, truncated: buf.length > 200000, settlement, url: x.toString() };
}

// ---------- our own services, sold over x402 ----------
let ASK = null; export function setAsk(fn) { ASK = fn; }
const TF = (p, d = '1h') => (['1h', '4h', '1d'].includes(p.get('tf')) ? p.get('tf') : d);
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const list = (p, k, max) => String(p.get(k) || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean).slice(0, max);
const addrs = (p, k, max) => { const a = list(p, k, max); return a.length && a.every((x) => ADDR.test(x)) ? a : null; };
const tok = async (t) => (ADDR.test(t) ? tokenByAddress(t) : tokenBySymbol(t));
const H = async () => (await import('./agents.js'));
async function write(env, sys, data, q) {
  if (!ASK) return null;
  try { return await ASK(env, sys + '\nUse ONLY the numbers in TOOL DATA. Plain language, no advice to buy or sell.\nTOOL DATA: ' + JSON.stringify(data).slice(0, 9000), [{ role: 'user', content: q }]); } catch { return null; }
}
const NOTE = 'Not financial advice. Data from public sources at request time.';
// Every OAA agent sold over x402. agent = which OAA agent answers (used to group the marketplace).
export const SERVICES = {
  // ---- CORE · orchestrator & reports
  core: { agent: 'CORE', price: 0.25, title: 'OAA Core', description: 'Ask anything about Base tokens and markets in plain language. The OAA Core routes your question to the right agents (ZEN, AQL, SENTINEL, SCOUT, PROOF) and returns one combined answer plus the raw data.',
    params: { q: 'Is $AERO safe and what does the 4h signal say?' }, run: async (p, env) => { const q = String(p.get('q') || '').slice(0, 500).trim(); if (!q) return { error: 'missing_q' };
      const { orchestrate, AGENTS, RULES_TEXT } = await H(); const o = await orchestrate(env, q);
      let answer = null; if (ASK) { try { answer = await ASK(env, AGENTS.core.prompt + '\n' + RULES_TEXT + '\nTOOL DATA: ' + JSON.stringify(o.data).slice(0, 9000), [{ role: 'user', content: q }]); } catch { answer = null; } }
      return { question: q, agentsUsed: o.data.agentsUsed, answer, data: o.data, note: NOTE }; } },
  explain: { agent: 'CORE', price: 0.5, title: 'Token explained', description: 'One Base token explained in plain words: live market data (AQL), risk grade with every reason (SENTINEL) and the 4h signal (ZEN), summarised by the OAA Core.',
    params: { token: '0x940181a94A35A4569E4529A3CDfB74e38FD98631' }, run: async (p, env) => { const t = String(p.get('token') || ''); if (!ADDR.test(t)) return { error: 'bad_address' };
      const { HELP } = await H(); const [info, risk, sig] = await Promise.all([HELP.tokenInfo(env, t).catch(() => null), rugCheck(env, t).catch(() => null), signalFor(t, '4h').catch(() => null)]);
      if (!info && !risk) return { error: 'not_found' }; const data = { token: info, risk, signal4h: sig };
      return { ...data, summary: await write(env, 'You are the OAA Core. Explain this token in 5 short bullet points: what it is, market size and liquidity, risk grade and its main reasons, what the 4h signal says, one thing to watch.', data, 'Explain this token.'), note: NOTE }; } },
  brief: { agent: 'CORE', price: 1, title: 'Market brief', description: 'Today\'s market in one call: ZEN signals for the 8 biggest coins, what is trending on Base (SCOUT) and a short written brief by the OAA Core.',
    params: { tf: '4h' }, run: async (p, env) => { const tf = TF(p, '4h'); const [board, trending] = await Promise.all([signalBoard(MAJORS.slice(0, 8), tf), trendingBase().catch(() => [])]);
      const data = { timeframe: tf, board, trending: (trending || []).slice(0, 10) };
      return { ...data, brief: await write(env, 'You are the OAA Core writing a short market brief (max 150 words): overall mood, strongest and weakest coins with their signals, what is moving on Base.', data, 'Write the market brief.'), note: NOTE }; } },
  guardian: { agent: 'CORE', price: 2, title: 'Wallet Guardian report', description: 'Full OAA Guardian report for any Base wallet: risk grade for every token (SENTINEL), 4h signals (ZEN), health score 0-100 and a written brief by the OAA Core. The brief hash is anchored on Base by PROOF.',
    params: { wallet: '0x0000000000000000000000000000000000000000' }, run: async (p, env) => { const w = String(p.get('wallet') || '').toLowerCase(); if (!ADDR.test(w)) return { error: 'bad_wallet' };
      const { scanWallet } = await H(); const r = await scanWallet(env, w, ASK || (async () => null)); return { ...r.data, brief: r.brief, proof: r.proof, note: 'Automatic check of public on-chain data. Not an audit, not financial advice.' }; } },
  diligence: { agent: 'CORE', price: 5, title: 'Deep due diligence', description: 'The full OAA research report on one Base token: contract and launch facts, market data, SENTINEL risk grade with every check, ZEN signals on 1h, 4h and 1d, and a structured written report (about 300 words) by the OAA Core.',
    params: { token: '0x940181a94A35A4569E4529A3CDfB74e38FD98631' }, run: async (p, env) => { const t = String(p.get('token') || ''); if (!ADDR.test(t)) return { error: 'bad_address' };
      const { HELP } = await H(); const [info, risk, s1, s4, sd] = await Promise.all([HELP.tokenInfo(env, t).catch(() => null), rugCheck(env, t).catch(() => null), signalFor(t, '1h').catch(() => null), signalFor(t, '4h').catch(() => null), signalFor(t, '1d').catch(() => null)]);
      if (!info && !risk) return { error: 'not_found' }; const data = { token: info, risk, signals: { '1h': s1, '4h': s4, '1d': sd } };
      return { ...data, report: await write(env, 'You are the OAA Core writing a due diligence report (about 300 words) with these headings: Overview, Market & liquidity, Contract risk, Technical picture (1h/4h/1d), Key risks, What would change the view.', data, 'Write the due diligence report.'), note: 'Automatic research from public data. Not an audit, not financial advice.' }; } },
  // ---- ZEN · signals
  signal: { agent: 'ZEN', price: 0.1, title: 'ZEN signal', description: 'Explainable technical signal for any Base token or major coin: trend, RSI, MACD, support and resistance, confidence and what would break the view.',
    params: { asset: 'ETH', tf: '1h' }, run: (p) => signalFor(p.get('asset') || 'ETH', TF(p)) },
  mtf: { agent: 'ZEN', price: 0.25, title: 'ZEN multi-timeframe', description: 'The same asset on 1h, 4h and 1d in one call, plus whether the timeframes agree.',
    params: { asset: 'ETH' }, run: async (p) => { const a = p.get('asset') || 'ETH'; const [h1, h4, d1] = await Promise.all(['1h', '4h', '1d'].map((tf) => signalFor(a, tf).catch(() => null)));
      const b = [h1, h4, d1].map((x) => String(x && x.bias || '')); const bull = b.filter((x) => /bull/i.test(x)).length, bear = b.filter((x) => /bear/i.test(x)).length;
      return { asset: a, '1h': h1, '4h': h4, '1d': d1, alignment: bull === 3 ? 'all bullish' : bear === 3 ? 'all bearish' : bull > bear ? 'mostly bullish' : bear > bull ? 'mostly bearish' : 'mixed' }; } },
  compare: { agent: 'ZEN', price: 0.4, title: 'ZEN compare', description: 'Compare up to 5 coins or Base tokens side by side on one timeframe, ranked by signal score.',
    params: { assets: 'BTC,ETH,SOL', tf: '4h' }, run: async (p) => { const a = list(p, 'assets', 5); if (a.length < 2) return { error: 'need_2_to_5_assets' };
      const r = await signalBoard(a, TF(p, '4h')); return { timeframe: TF(p, '4h'), ranked: r.slice().sort((x, y) => (y.score || 0) - (x.score || 0)) }; } },
  board: { agent: 'ZEN', price: 0.5, title: 'ZEN signal board', description: 'Signals for the 8 biggest coins in one call.',
    params: { tf: '1h' }, run: (p) => signalBoard(MAJORS.slice(0, 8), TF(p)) },
  board20: { agent: 'ZEN', price: 1, title: 'ZEN board · top 20', description: 'Signals for the 20 biggest coins in one call, with price, change, RSI and levels.',
    params: { tf: '4h' }, run: (p) => signalBoard(MAJORS.slice(0, 20), TF(p, '4h')) },
  // ---- AQL · token & trading data
  token: { agent: 'AQL', price: 0.05, title: 'AQL token check', description: 'Live price, liquidity, volume, market cap and buy/sell flow of a Base token by address or symbol.',
    params: { token: '0x4200000000000000000000000000000000000006' }, run: async (p) => (await tok(p.get('token') || '')) || { error: 'not_found' } },
  price: { agent: 'AQL', price: 0.05, title: 'AQL price', description: 'Latest price of a major coin (BTC, ETH, SOL and more) from Coinbase Exchange.',
    params: { asset: 'BTC' }, run: async (p) => { const a = String(p.get('asset') || 'BTC').toUpperCase().replace(/^\$/, ''); if (!MAJORS.includes(a)) return { error: 'unknown_asset', supported: MAJORS };
      const px = await lastPrice(a); return px == null ? { error: 'not_found' } : { asset: a, priceUsd: px, source: 'Coinbase Exchange', at: new Date().toISOString() }; } },
  tokens: { agent: 'AQL', price: 0.3, title: 'AQL batch check', description: 'Market data for up to 10 Base tokens in one call.',
    params: { tokens: '0x4200000000000000000000000000000000000006,0x940181a94A35A4569E4529A3CDfB74e38FD98631' }, run: async (p) => { const a = addrs(p, 'tokens', 10); if (!a) return { error: 'bad_address' };
      return { tokens: await Promise.all(a.map((t) => tokenByAddress(t).then((r) => r || { address: t, error: 'not_found' }).catch(() => ({ address: t, error: 'unavailable' })))) }; } },
  wallet: { agent: 'AQL', price: 0.2, title: 'AQL wallet view', description: 'ETH balance and every ERC-20 token of a Base wallet with amounts and USD values. Read-only.',
    params: { wallet: '0x0000000000000000000000000000000000000000' }, run: async (p, env) => { const w = String(p.get('wallet') || '').toLowerCase(); if (!ADDR.test(w)) return { error: 'bad_wallet' };
      const { HELP } = await H(); const [eth, items] = await Promise.all([HELP.walletInfo(env, w).catch(() => null), HELP.scoutTokens(w)]);
      const tokens = items.map((it) => { const t = it.token || {}; const amt = Number(it.value || 0) / Math.pow(10, Number(t.decimals || 18)); const px = t.exchange_rate != null ? Number(t.exchange_rate) : null;
        return { address: String(t.address_hash || t.address || '').toLowerCase(), symbol: String(t.symbol || '?').slice(0, 16), amount: amt, priceUsd: px, valueUsd: px != null ? amt * px : null }; }).filter((x) => x.amount > 0).sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
      return { wallet: w, eth, tokens, totalUsd: (eth && eth.ethBalanceUsd || 0) + tokens.reduce((s, t) => s + (t.valueUsd || 0), 0) }; } },
  quote: { agent: 'AQL', price: 0.15, title: 'AQL swap quote', description: 'Best route to buy or sell a Base token for ETH, with expected amount, price impact and a ready unsigned transaction you sign yourself.',
    params: { token: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', side: 'buy', amountEth: '0.01', percent: '', sender: '0x0000000000000000000000000000000000000000' }, run: async (p, env) => { const { HELP } = await H();
      const side = p.get('side') === 'sell' ? 'sell' : 'buy'; const r = await HELP.swap(env, { sender: p.get('sender') || '', token: p.get('token') || '', side, amountEth: Number(p.get('amountEth') || 0), percent: Number(p.get('percent') || 0), amountTokens: Number(p.get('amountTokens') || 0), slippageBps: 300 });
      return r || { error: 'no_route' }; } },
  // ---- SCOUT · discovery
  trending: { agent: 'SCOUT', price: 0.1, title: 'SCOUT trending on Base', description: 'Trending pools on Base right now with price, volume, liquidity and market cap.',
    params: {}, run: () => trendingBase() },
  launches: { agent: 'SCOUT', price: 0.1, title: 'SCOUT new OAA launches', description: 'The newest tokens launched on the OAA launchpad, with creator, pool, price and market cap. Liquidity of every one is locked forever.',
    params: {}, run: async (p, env) => { const { HELP } = await H(); return { launches: await HELP.oaaTokens(env) }; } },
  safetrend: { agent: 'SCOUT', price: 1.5, title: 'Trending, risk-checked', description: 'The top 10 trending pools on Base, each with a SENTINEL risk grade A to F and the main red flags, so you see what is moving and what is safe.',
    params: {}, run: async (p, env) => { const t = ((await trendingBase()) || []).slice(0, 10);
      return { trending: await Promise.all(t.map(async (x) => { const a = typeof x.token === 'string' ? x.token : null; const rc = a && ADDR.test(a) ? await rugCheck(env, a).catch(() => null) : null;
        return { ...x, grade: rc ? rc.grade : null, score: rc ? rc.score : null, flags: rc && Array.isArray(rc.checks) ? rc.checks.filter((c) => c.status === 'bad' || c.status === 'warn').slice(0, 3).map((c) => c.title || c.label || c.id) : [] }; })) }; } },
  // ---- SENTINEL · risk
  rugcheck: { agent: 'SENTINEL', price: 0.15, title: 'SENTINEL rug check', description: 'Risk grade A to F for any Base token: verified source, upgradeability, owner powers (mint, blacklist, taxes, pause), holder concentration, liquidity, honeypot signs and age.',
    params: { token: '0x4200000000000000000000000000000000000006' }, run: async (p, env) => { const t = p.get('token') || ''; if (!ADDR.test(t)) return { error: 'bad_address' }; return rugCheck(env, t); } },
  rugbatch: { agent: 'SENTINEL', price: 1, title: 'SENTINEL batch check', description: 'Rug check for up to 10 Base tokens in one call, sorted from riskiest to safest.',
    params: { tokens: '0x4200000000000000000000000000000000000006,0x940181a94A35A4569E4529A3CDfB74e38FD98631' }, run: async (p, env) => { const a = addrs(p, 'tokens', 10); if (!a) return { error: 'bad_address' };
      const r = await Promise.all(a.map((t) => rugCheck(env, t).catch(() => ({ token: t, error: 'unavailable' })))); return { results: r.sort((x, y) => (x.score == null ? 101 : x.score) - (y.score == null ? 101 : y.score)) }; } },
  walletrisk: { agent: 'SENTINEL', price: 0.75, title: 'SENTINEL wallet risk', description: 'Risk grade for the 6 biggest tokens in any Base wallet, 4h signals for the top 3 and an overall health score 0-100. No written brief.',
    params: { wallet: '0x0000000000000000000000000000000000000000' }, run: async (p, env) => { const w = String(p.get('wallet') || '').toLowerCase(); if (!ADDR.test(w)) return { error: 'bad_wallet' };
      const { scanWallet } = await H(); return (await scanWallet(env, w, null, { brief: false })).data; } },
  // ---- PROOF · verification
  record: { agent: 'PROOF', price: 0.05, title: 'PROOF track record', description: 'Verifiable hit rate of all past ZEN signals, by asset and timeframe. Every signal is committed on Base before its outcome is known.',
    params: {}, run: (p, env) => record(env) },
  batch: { agent: 'PROOF', price: 0.05, title: 'PROOF batch data', description: 'Every signal and brief hash of one hourly batch, with Merkle leaves, the root anchored on Base and step-by-step verification.',
    params: { id: '1' }, run: async (p, env) => { const id = String(p.get('id') || ''); const r = await batch(env, id); return r || { error: 'not_found' }; } },
};
function requirement(env, svc, resource) {
  return { scheme: 'exact', network: 'eip155:8453', amount: String(Math.round(SERVICES[svc].price * 1e6)), asset: USDC, payTo: env.TREASURY, maxTimeoutSeconds: 120, extra: { name: 'USD Coin', version: '2' } };
}
function requirementV1(env, svc, resource) {
  return { scheme: 'exact', network: 'base', maxAmountRequired: String(Math.round(SERVICES[svc].price * 1e6)), resource, description: SERVICES[svc].description, mimeType: 'application/json', payTo: env.TREASURY, maxTimeoutSeconds: 120, asset: USDC, extra: { name: 'USD Coin', version: '2' } };
}
const OPEN = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-PAYMENT, PAYMENT-SIGNATURE', 'Access-Control-Expose-Headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE', 'Cache-Control': 'no-store' };
const out = (body, status, extra) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...OPEN, ...(extra || {}) } });

async function facilitator(env, path, payload) {
  const base = (env.FACILITATOR_URL || 'https://facilitator.payai.network').replace(/\/$/, '');
  const h = { 'Content-Type': 'application/json' }; if (env.FACILITATOR_KEY) h.Authorization = 'Bearer ' + env.FACILITATOR_KEY;
  const r = await fetch(base + '/' + path, { method: 'POST', headers: h, body: JSON.stringify(payload) });
  const j = await r.json().catch(() => ({}));
  return j;
}

export async function sellerRoutes(request, env, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: OPEN });
  const svc = url.pathname.replace(/^\/x402\/?/, '').replace(/\/$/, '');
  const origin = url.origin;
  if (!svc) {
    return out({ name: 'OAA agents', description: 'Pay-per-call AI agent data from OAA on Base. Pay with USDC over x402, no account needed.', payTo: env.TREASURY || null, network: 'eip155:8453', asset: USDC,
      services: Object.entries(SERVICES).map(([k, s]) => ({ id: k, url: origin + '/x402/' + k, agent: s.agent, title: s.title, description: s.description, priceUsd: s.price, method: 'GET', queryParams: s.params })) }, 200);
  }
  const S = SERVICES[svc]; if (!S || request.method !== 'GET') return out({ error: 'not_found' }, 404);
  if (!env.TREASURY) return out({ error: 'x402 payments are not set up yet' }, 503);
  const resource = origin + '/x402/' + svc;
  const v2 = { x402Version: 2, error: 'Payment required', resource: { url: resource, description: S.description, mimeType: 'application/json', serviceName: 'OAA · ' + S.title },
    accepts: [requirement(env, svc, resource)], extensions: { bazaar: { info: { input: { type: 'http', method: 'GET', queryParams: S.params }, output: { type: 'json' } } } } };
  const sig2 = request.headers.get('PAYMENT-SIGNATURE'), sig1 = request.headers.get('X-PAYMENT');
  if (!sig2 && !sig1) return out(v2, 402, { 'PAYMENT-REQUIRED': b64(v2) });

  let payload; try { payload = unb64(sig2 || sig1); } catch { return out({ ...v2, error: 'invalid_payment' }, 402, { 'PAYMENT-REQUIRED': b64(v2) }); }
  const version = sig2 ? 2 : 1;
  const reqs = version === 2 ? requirement(env, svc, resource) : requirementV1(env, svc, resource);
  const auth = payload && payload.payload && payload.payload.authorization;
  if (!auth || String(auth.to || '').toLowerCase() !== env.TREASURY.toLowerCase() || BigInt(auth.value || 0) < BigInt(version === 2 ? reqs.amount : reqs.maxAmountRequired))
    return out({ ...v2, error: 'payment_does_not_match' }, 402, { 'PAYMENT-REQUIRED': b64(v2) });
  const fp = { x402Version: version, paymentPayload: payload, paymentRequirements: reqs };
  let v; try { v = await facilitator(env, 'verify', fp); } catch { v = null; }
  if (!v || !v.isValid) return out({ ...v2, error: (v && v.invalidReason) || 'verification_failed' }, 402, { 'PAYMENT-REQUIRED': b64(v2) });
  let result; try { result = await S.run(url.searchParams, env); } catch (e) { return out({ error: 'data_unavailable', detail: 'The data source is busy, you were not charged. Try again in a minute.' }, 503); }
  if (result && result.error && Object.keys(result).length <= 3) return out({ error: result.error, detail: 'Check your input, you were not charged.' }, 400);
  let s; try { s = await facilitator(env, 'settle', fp); } catch { s = null; }
  if (!s || !s.success) return out({ ...v2, error: (s && s.errorReason) || 'settlement_failed' }, 402, { 'PAYMENT-REQUIRED': b64(v2) });
  if (env.MEDIA) { try { const k = 'x4:' + svc; await env.MEDIA.put(k, String(Number((await env.MEDIA.get(k)) || 0) + 1)); } catch {} }
  const receipt = { success: true, transaction: s.transaction, network: s.network || 'eip155:8453', payer: s.payer || v.payer || null };
  return out({ service: svc, data: result, paidUsd: S.price, receipt }, 200, { 'PAYMENT-RESPONSE': b64(receipt), 'X-PAYMENT-RESPONSE': b64(receipt) });
}
