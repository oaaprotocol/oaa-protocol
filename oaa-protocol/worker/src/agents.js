// OAA Agentverse: AI trading, signals and forex agents on Base, plus the x402 marketplace.
// Money flows to the OAA treasury three ways, all on-chain and visible on BaseScan:
//   1. Agent credits     visitors pay ETH to TREASURY after 5 free requests a day ($0.04 per request)
//   2. Swap fee          SWAP_FEE_BPS (default 0.3%) of every swap prepared by AQL goes to TREASURY
//   3. x402 sales        other apps and agents pay USDC per call to /x402/* (see x402.js)
// Variables (Cloudflare → Worker → Settings → Variables):
//   TREASURY  wallet that receives all payments (required for paid features)
//   LAUNCHPAD OAA launchpad contract (optional, enables launchpad token data)
//   BASE_RPC  Base RPC URL (optional, default https://mainnet.base.org)
//   SWAP_FEE_BPS, FACILITATOR_URL, FACILITATOR_KEY (optional)
// KV binding "MEDIA" stores sessions and credits.
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { signalFor, signalBoard, tokenByAddress, tokenBySymbol, trendingBase, MAJORS, FX, NATIVE } from './market.js';
import { quote, build, feeBps } from './trade.js';
import { discover, callPaid, SERVICES } from './x402.js';
import { rugCheck } from './rug.js';
import { record, batch, queueBrief } from './proof.js';

const PRICE_USD = 0.04;
const FREE_PER_DAY = 5;
// Agents are free for now. Set AGENTS_PAID=1 to switch back to 5 free requests a day + credits.
// AGENTS_FAIR_USE (default 60) is a per-visitor daily cap that protects the Workers AI quota while free.
const isPaid = (env) => env.AGENTS_PAID === '1';
const fairUse = (env) => { const n = parseInt(env.AGENTS_FAIR_USE || '60', 10); return isFinite(n) && n > 0 ? n : 60; };
const perDay = (env) => isPaid(env) ? FREE_PER_DAY : fairUse(env);
// $OAA holder perk: wallets that signed in and hold at least HOLDER_MIN $OAA get HOLDER_MULT x the free daily limit.
const holderMin = (env) => { const n = Number(env.HOLDER_MIN || '1000000'); return isFinite(n) && n > 0 ? n : 1000000; };
const holderMult = (env) => { const n = parseInt(env.HOLDER_MULT || '5', 10); return isFinite(n) && n > 1 ? Math.min(n, 50) : 5; };
const HOLD = new Map();
async function oaaBalance(env, w) {
  const t = String(env.OAA_TOKEN || ''); if (!/^0x[0-9a-fA-F]{40}$/.test(t) || !w) return null;
  const c = HOLD.get(w); if (c && Date.now() - c.at < 600000) return c.bal;
  const data = '0x70a08231' + w.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  let bal = null; try { const r = await rpc(env, 'eth_call', [{ to: t, data }, 'latest']); bal = Number(big(r)) / 1e18; } catch { bal = null; }
  HOLD.set(w, { at: Date.now(), bal }); if (HOLD.size > 20000) HOLD.clear();
  return bal;
}
async function holderOf(env, w) { const bal = await oaaBalance(env, w); return { balance: bal, holder: bal != null && bal >= holderMin(env), min: holderMin(env), mult: holderMult(env), live: /^0x[0-9a-fA-F]{40}$/.test(String(env.OAA_TOKEN || '')) }; }
const MIN_CONF = 2;
const FEED_DEFAULT = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';
const free = new Map();
let tokenCache = { at: 0, list: [] };

export const AGENTS = {
  core: { name: 'CORE', role: 'Orchestrator',
    prompt: 'You are the OAA Core, the orchestrator of the OAA agent network on Base. For every request you decide which specialist agents work on it (AQL trading data, ZEN signals, SENTINEL risk checks, SCOUT discovery, PROOF track record) and combine their results into one clear answer. TOOL DATA.agentsUsed lists the agents that worked on this request: start with one short line like "Agents: ZEN → SENTINEL", then give the combined answer. You never hold funds; swaps are always signed by the user.' },
  aql: { name: 'AQL', role: 'Trading Agent',
    prompt: 'You are AQL, the crypto trading agent of OAA on Base. You read live market data (TOOL DATA) for any Base token, check wallets and OAA launches, and prepare real swaps through a DEX aggregator. The user always reviews and signs the swap in their own wallet; you never hold funds.' },
  zen: { name: 'ZEN', role: 'Signals Agent',
    prompt: 'You are ZEN, the signals agent of OAA. TOOL DATA contains a computed technical signal (bias, score, confidence, indicators, levels, reasons, invalidation). Explain it clearly: what the data shows, how confident one can be and what would break the view. You never tell anyone to buy or sell.' },
  sentinel: { name: 'SENTINEL', role: 'Risk Agent',
    prompt: 'You are SENTINEL, the risk agent of OAA. TOOL DATA.rugCheck contains an automatic risk check of a Base token (grade A to F, score, owner powers, upgradeability, verified source, holders, liquidity, honeypot signs). Explain the biggest risks first, in plain words, and what the user should verify themselves. It is a heuristic, not an audit; say so briefly.' },
  scout: { name: 'SCOUT', role: 'Discovery Agent',
    prompt: 'You are SCOUT, the discovery agent of OAA. TOOL DATA contains trending pools on Base and the newest tokens launched on the OAA launchpad. Summarize what is moving and why it may matter, with prices, volume and liquidity from TOOL DATA. Point out thin liquidity and very new tokens as risks. Never hype.' },
  proof: { name: 'PROOF', role: 'Verification Agent',
    prompt: 'You are PROOF, the verification agent of OAA. TOOL DATA.record is the public track record of ZEN signals: every batch of signals is committed by hash on Base before the outcome is known and scored afterwards. Explain the hit rate, sample size, the latest batch and how anyone can verify it (Verify button in Signals > Track record, BaseScan transaction). Be honest about small samples.' },
};
export const RULES_TEXT = `Rules:
- Reply in the user's language. Be concise: short paragraphs or bullets, no tables.
- Use only numbers from TOOL DATA. If data is missing, say so. Never invent prices, addresses or dates.
- No financial advice. Signals are probabilities, not promises; mention risk briefly.
- Never ask for seed phrases or private keys.
- If an ACTION is present, explain it in one or two sentences and tell the user to review it and confirm it in their wallet.`;

// ---------- helpers ----------
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => { h = h.replace(/^0x/, ''); const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
const pad = (h) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const addrOf = (w) => '0x' + w.slice(-40);
const big = (w) => BigInt('0x' + (String(w).replace(/^0x/, '') || '0'));
function str(r) { try { const d = r.slice(2), off = parseInt(d.slice(0, 64), 16) * 2, len = parseInt(d.slice(off, off + 64), 16); return new TextDecoder().decode(unhex(d.slice(off + 64, off + 64 + len * 2))); } catch { return ''; } }
function sel(sig) { return '0x' + hex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8); }
const SEL = { name: '0x06fdde03', symbol: '0x95d89b41', decimals: '0x313ce567', supply: '0x18160ddd', balanceOf: '0x70a08231', allowance: '0xdd62ed3e', count: '0x9f181b5e', all: '0x634282af', slot0: '0x3850c7bd', latest: '0xfeaf968c' };
SEL.getLaunch = sel('getLaunch(address)'); SEL.weth = sel('weth()');

async function rpc(env, method, params) {
  const r = await fetch(env.BASE_RPC || 'https://mainnet.base.org', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message || 'rpc'); return j.result;
}
const call = (env, to, data) => rpc(env, 'eth_call', [{ to, data }, 'latest']);
async function ethUsd(env) {
  const r = await call(env, env.ETH_USD || FEED_DEFAULT, SEL.latest);
  const d = r.slice(2); const p = Number(big(d.slice(64, 128))) / 1e8; const upd = Number(big(d.slice(192, 256)));
  if (!(p > 0) || Date.now() / 1000 - upd > 6 * 3600) throw new Error('price feed unavailable');
  return p;
}
function toUnits(x, dec) {
  const [i, f = ''] = Number(x).toFixed(Math.min(dec, 18)).split('.');
  return (BigInt(i) * 10n ** BigInt(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0')).toString();
}
const fromUnits = (s, dec) => Number(BigInt(s)) / 10 ** dec;

// ---------- on-chain tools ----------
async function erc20(env, a) {
  const [n, s, dec, sup] = await Promise.all([call(env, a, SEL.name), call(env, a, SEL.symbol), call(env, a, SEL.decimals), call(env, a, SEL.supply)].map((p) => p.catch(() => null)));
  if (!s || s === '0x' || !dec || dec === '0x') return null;
  const d = Number(big(dec));
  return { address: a, name: str(n), symbol: str(s), decimals: d, totalSupply: sup ? Number(big(sup)) / 10 ** d : null };
}
async function launchInfo(env, a) {
  if (!env.LAUNCHPAD) return null;
  try {
    const l = (await call(env, env.LAUNCHPAD, SEL.getLaunch + pad(a))).slice(2);
    const pool = addrOf(l.slice(64, 128)); if (pool === '0x' + '0'.repeat(40)) return null;
    const at = Number(big(l.slice(5 * 64, 6 * 64)));
    const weth = addrOf((await call(env, env.LAUNCHPAD, SEL.weth)).slice(2));
    const s0 = (await call(env, pool, SEL.slot0)).slice(2); const sq = Number(big(s0.slice(0, 64))) / 2 ** 96; let p = sq * sq; if (a.toLowerCase() > weth.toLowerCase()) p = 1 / p;
    let usd = null; try { usd = await ethUsd(env); } catch {}
    return { launchedOnOAA: true, creator: addrOf(l.slice(0, 64)), pool, launchedAt: new Date(at * 1000).toISOString().slice(0, 10), priceEth: p, priceUsd: usd ? p * usd : null, marketCapUsd: usd ? p * usd * 1e9 : null,
      liquidity: '100% locked forever in the OAA launchpad', creatorFirstBuy: 'locked in the launchpad for 30 months, then unlocks linearly over 12 months', fees: '1% per trade (0.4% creator, 0.3% buyback & burn of $OAA, 0.3% treasury)' };
  } catch { return null; }
}
async function tokenInfo(env, a) {
  const [t, l, m] = await Promise.all([erc20(env, a).catch(() => null), launchInfo(env, a), tokenByAddress(a).catch(() => null)]);
  if (!t && !m) return null;
  const o = { ...(t || { address: a, symbol: m.symbol, name: m.name }), market: m || null, ...(l || { launchedOnOAA: false }) };
  if (!l) o.note = 'Not launched on OAA: liquidity locks, owner rights and taxes cannot be verified here. Check the contract on BaseScan.';
  return o;
}
async function oaaTokens(env) {
  if (!env.LAUNCHPAD) return [];
  if (Date.now() - tokenCache.at < 60000) return tokenCache.list;
  const n = Number(big(await call(env, env.LAUNCHPAD, SEL.count)));
  const ids = []; for (let i = n - 1; i >= 0 && i >= n - 30; i--) ids.push(i);
  const addrs = await Promise.all(ids.map((i) => call(env, env.LAUNCHPAD, SEL.all + pad(i.toString(16))).then((r) => addrOf(r.slice(2)))));
  const list = (await Promise.all(addrs.map(async (a) => { const [t, l] = await Promise.all([erc20(env, a), launchInfo(env, a)]); return t && l ? { ...t, ...l } : null; }))).filter(Boolean);
  tokenCache = { at: Date.now(), list };
  return list;
}
async function walletInfo(env, a) {
  const bal = Number(big(await rpc(env, 'eth_getBalance', [a, 'latest']))) / 1e18;
  let usd = null; try { usd = await ethUsd(env); } catch {}
  return { address: a, ethBalance: bal, ethBalanceUsd: usd ? bal * usd : null };
}

// ---------- intent router (deterministic) ----------
function timeframe(t) { return /\b(1d|daily|day|täglich|tages)\b/.test(t) ? '1d' : /\b4h\b/.test(t) ? '4h' : '1h'; }
function fxPair(text) {
  const u = text.toUpperCase();
  const m = u.match(/\b([A-Z]{3})\s*[\/\-]\s*([A-Z]{3})\b/) || u.match(/\b(EUR|GBP|USD|AUD|NZD|CHF|CAD)(USD|JPY|CHF|GBP|CAD|EUR|AUD|NZD|TRY)\b/);
  return m && FX.includes(m[1]) && FX.includes(m[2]) && m[1] !== m[2] ? m[1] + '/' + m[2] : null;
}
function amountIntent(t) {
  const side = /\b(sell|verkauf|verkaufe|verkaufen|dump)\b/.test(t) ? 'sell' : /\b(buy|kauf|kaufe|kaufen|ape|swap)\b/.test(t) ? 'buy' : null;
  if (!side) return null;
  let m = t.match(/(\d+(?:[.,]\d+)?)\s*(eth|%|usd|dollar|\$)/), amount = null;
  if (m) { const n = parseFloat(m[1].replace(',', '.')); amount = m[2] === 'eth' ? { amountEth: n } : m[2] === '%' ? { percent: Math.min(100, n) } : { amountUsd: n }; }
  else if ((m = t.match(/\$\s*(\d+(?:[.,]\d+)?)/))) amount = { amountUsd: parseFloat(m[1].replace(',', '.')) };
  else if (/\b(all|alles|max)\b/.test(t) && side === 'sell') amount = { percent: 100 };
  return { side, ...(amount || {}) };
}
function symbolIn(text) {
  const m = text.match(/\$([A-Za-z][A-Za-z0-9]{1,11})\b/); if (m) return m[1].toUpperCase();
  const w = text.replace(/\d+(?:[.,]\d+)?\s*(eth|usd|usdc|dollar)\b/gi, ' ').toUpperCase().match(/\b[A-Z][A-Z0-9]{1,9}\b/g) || [];
  return w.find((x) => MAJORS.includes(x)) || null;
}
async function resolveToken(env, text) {
  const addr = (text.match(/0x[a-fA-F0-9]{40}/) || [])[0]; const sym = symbolIn(text);
  if (addr) return await tokenInfo(env, addr).catch(() => null) || { address: addr };
  if (sym && !MAJORS.includes(sym)) {
    const list = await oaaTokens(env).catch(() => []); const hit = list.find((x) => x.symbol.toUpperCase() === sym);
    if (hit) return { ...hit, market: await tokenByAddress(hit.address).catch(() => null) };
    const m = await tokenBySymbol(sym).catch(() => null); if (m) return { address: m.address, symbol: m.symbol, name: m.name, market: m, launchedOnOAA: false };
  }
  return null;
}
// OAA Core: picks the specialist agents for a request, runs them and hands all results to one answer.
export async function orchestrate(env, text) {
  const t = text.toLowerCase(); const used = []; const data = {}; let action = null;
  const sym = symbolIn(text); const addr = (text.match(/0x[a-fA-F0-9]{40}/) || [])[0];
  const wantsSignal = /signal|rsi|macd|chart|technical|technisch|analy|bull|bear|trend of|support|resistance|overbought|oversold|long|short/.test(t);
  const wantsRisk = /safe|rug|scam|honeypot|risk|sicher|seriös|legit|audit|check|prüf|vertrau/.test(t);
  const wantsScout = /trend|hot|top|pump|gainer|mover|new|neu|latest|launch|discover|find|finde/.test(t);
  const wantsProof = /track record|hit rate|trefferquote|proof|verify|verif|accuracy|genau|history|bilanz/.test(t);
  if (wantsSignal || (sym && MAJORS.includes(sym))) {
    const target = addr || sym; used.push('ZEN');
    if (target) data.signal = await signalFor(target, timeframe(t)).catch(() => ({ error: 'Market data is temporarily unavailable.' }));
    else data.board = await signalBoard(MAJORS.slice(0, 6), timeframe(t)).catch(() => []);
  }
  let tk = null;
  if (addr || (sym && !MAJORS.includes(sym))) { tk = await resolveToken(env, text); if (tk) { data.token = tk; used.push('AQL'); } }
  if (wantsRisk && tk && tk.address) { data.rugCheck = await rugCheck(env, tk.address).catch(() => null); used.push('SENTINEL'); }
  if (wantsScout) { data.trendingOnBase = await trendingBase().catch(() => []); const q = await oaaTokens(env).catch(() => []); if (q.length) data.oaaLaunches = q.slice(0, 8).map((x) => ({ symbol: x.symbol, address: x.address, priceUsd: x.priceUsd, marketCapUsd: x.marketCapUsd })); used.push('SCOUT'); }
  if (wantsProof) { data.record = await record(env).catch(() => null); used.push('PROOF'); }
  const intent = amountIntent(t);
  if (intent && tk && tk.address) {
    action = { type: 'swap', side: intent.side, token: tk.address, symbol: tk.symbol, amountEth: intent.amountEth || null, amountUsd: intent.amountUsd || null, percent: intent.percent || null, feeBps: feeBps(env) };
    if (intent.side === 'buy' && !action.amountEth && !action.amountUsd) action.amountEth = 0.01;
    if (intent.side === 'sell' && !action.percent && !action.amountUsd && !action.amountEth) action.percent = 100;
    if (!used.includes('AQL')) used.push('AQL');
  }
  if (!used.length) { data.board = await signalBoard(MAJORS.slice(0, 4), '1h').catch(() => []); data.trendingOnBase = (await trendingBase().catch(() => [])).slice(0, 5); used.push('ZEN', 'SCOUT'); }
  data.agentsUsed = [...new Set(used)];
  return { data, action };
}

async function route(env, agent, text) {
  const data = {}; let action = null;
  const t = text.toLowerCase();
  const addr = (text.match(/0x[a-fA-F0-9]{40}/) || [])[0];
  const sym = symbolIn(text);
  if (agent === 'core') return orchestrate(env, text);
  if (agent === 'sentinel') {
    const tk = await resolveToken(env, text);
    if (tk && tk.address) { data.token = tk; data.rugCheck = await rugCheck(env, tk.address).catch(() => ({ error: 'Risk data is temporarily unavailable.' })); }
    else data.note = 'Name a Base token by symbol (e.g. $AERO) or paste its contract address (0x...) to run a risk check.';
    return { data, action };
  }
  if (agent === 'scout') {
    data.trendingOnBase = await trendingBase().catch(() => []);
    const q = await oaaTokens(env).catch(() => []);
    if (q.length) data.oaaLaunches = q.slice(0, 10).map((x) => ({ symbol: x.symbol, name: x.name, address: x.address, priceUsd: x.priceUsd, marketCapUsd: x.marketCapUsd, launchedAt: x.launchedAt }));
    return { data, action };
  }
  if (agent === 'proof') {
    data.record = await record(env).catch(() => ({ error: 'The track record is not available right now.' }));
    return { data, action };
  }
  if (agent === 'zen') {
    const target = addr || sym;
    if (target) data.signal = await signalFor(target, timeframe(t)).catch(() => ({ error: 'Market data is temporarily unavailable.' }));
    else data.board = await signalBoard(MAJORS.slice(0, 6), timeframe(t)).catch(() => []);
    return { data, action };
  }
  // aql
  let token = null;
  if (addr) { token = await tokenInfo(env, addr).catch(() => null); if (token) data.token = token; else data.wallet = await walletInfo(env, addr).catch(() => null); }
  if (!token && !sym) {
    const list = await oaaTokens(env).catch(() => []);
    const hit = list.find((x) => new RegExp('\\b' + x.symbol.replace(/[^A-Za-z0-9]/g, '') + '\\b', 'i').test(text));
    if (hit) { token = { ...hit, market: await tokenByAddress(hit.address).catch(() => null) }; data.token = token; }
  }
  if (!token && sym && !MAJORS.includes(sym)) {
    const list = await oaaTokens(env).catch(() => []);
    const hit = list.find((x) => x.symbol.toUpperCase() === sym);
    if (hit) { token = { ...hit, market: await tokenByAddress(hit.address).catch(() => null) }; }
    else { const m = await tokenBySymbol(sym).catch(() => null); if (m) token = { address: m.address, symbol: m.symbol, name: m.name, market: m, launchedOnOAA: false }; }
    if (token) data.token = token;
  }
  if (token && token.address && /safe|rug|scam|honeypot|risk|sicher|seriös|legit|audit|check|prüf/.test(t)) data.rugCheck = await rugCheck(env, token.address).catch(() => null);
  if (/trend|hot|top|pump|gainer|neu|new|latest|launch|list/.test(t)) {
    data.trendingOnBase = await trendingBase().catch(() => []);
    const q = await oaaTokens(env).catch(() => []);
    if (q.length) data.oaaLaunches = q.slice(0, 10).map((x) => ({ symbol: x.symbol, name: x.name, address: x.address, priceUsd: x.priceUsd, marketCapUsd: x.marketCapUsd, launchedAt: x.launchedAt }));
  }
  if (!token && sym && MAJORS.includes(sym) && sym !== 'ETH') data.note = sym + ' is not a Base token. AQL trades tokens on Base; ask ZEN for a ' + sym + ' signal.';
  const intent = amountIntent(t);
  if (intent && token && token.address) {
    action = { type: 'swap', side: intent.side, token: token.address, symbol: token.symbol, amountEth: intent.amountEth || null, amountUsd: intent.amountUsd || null, percent: intent.percent || null, feeBps: feeBps(env) };
    if (intent.side === 'buy' && !action.amountEth && !action.amountUsd) action.amountEth = 0.01;
    if (intent.side === 'sell' && !action.percent && !action.amountUsd && !action.amountEth) action.percent = 100;
  }
  return { data, action };
}

// ---------- swap builder (free, the fee goes to the treasury) ----------
export async function swap(env, b) {
  const sender = String(b.sender || ''); const token = String(b.token || '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(sender) || !/^0x[0-9a-fA-F]{40}$/.test(token)) return { error: 'bad_request' };
  const side = b.side === 'sell' ? 'sell' : 'buy';
  const t = await erc20(env, token); if (!t) return { error: 'not_a_token' };
  let amountIn;
  if (side === 'buy') {
    let eth = Number(b.amountEth || 0);
    if (!eth && b.amountUsd) eth = Number(b.amountUsd) / (await ethUsd(env));
    if (!(eth > 0) || eth > 1000) return { error: 'bad_amount' };
    amountIn = toUnits(eth, 18);
  } else {
    const bal = big(await call(env, token, SEL.balanceOf + pad(sender)));
    if (b.percent) amountIn = (bal * BigInt(Math.round(Math.min(100, Number(b.percent)) * 100)) / 10000n).toString();
    else if (b.amountTokens) amountIn = toUnits(Number(b.amountTokens), t.decimals);
    else return { error: 'bad_amount' };
    if (BigInt(amountIn) <= 0n) return { error: 'no_balance', balance: '0' };
    if (BigInt(amountIn) > bal) return { error: 'no_balance', balance: fromUnits(bal.toString(), t.decimals) };
  }
  const tokenIn = side === 'buy' ? NATIVE : token, tokenOut = side === 'buy' ? token : NATIVE;
  let q; try { q = await quote(env, tokenIn, tokenOut, amountIn); } catch (e) { return { error: 'no_route' }; }
  const tx = await build(env, q, sender, Number(b.slippageBps) || 100).catch(() => null);
  if (!tx) return { error: 'no_route' };
  let approve = null;
  if (side === 'sell') {
    const al = big(await call(env, token, SEL.allowance + pad(sender) + pad(tx.to)).catch(() => '0x0'));
    if (al < BigInt(amountIn)) approve = { token, spender: tx.to, data: '0x095ea7b3' + pad(tx.to) + pad(BigInt(amountIn).toString(16)) };
  }
  const decIn = side === 'buy' ? 18 : t.decimals, decOut = side === 'buy' ? t.decimals : 18;
  return { side, symbol: t.symbol, token, decimals: t.decimals, tx: { from: sender, to: tx.to, data: tx.data, value: tx.value }, approve,
    amountIn: fromUnits(q.amountIn, decIn), amountOut: fromUnits(tx.amountOut || q.amountOut, decOut), amountInUsd: q.amountInUsd, amountOutUsd: q.amountOutUsd, gasUsd: q.gasUsd,
    feeBps: env.TREASURY ? feeBps(env) : 0, slippageBps: Number(b.slippageBps) || 100, via: 'KyberSwap aggregator' };
}

// ---------- sessions, credits ----------
async function sha(s) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))); }
function recover(message, sig) {
  const m = new TextEncoder().encode(message);
  const h = keccak_256(new Uint8Array([...new TextEncoder().encode('\x19Ethereum Signed Message:\n' + m.length), ...m]));
  const b = unhex(sig); let v = b[64]; if (v >= 27) v -= 27;
  const pub = secp.Signature.fromCompact(b.slice(0, 64)).addRecoveryBit(v).recoverPublicKey(h).toRawBytes(false);
  return '0x' + hex(keccak_256(pub.slice(1))).slice(-40);
}
export function signInMessage(wallet, keyHash, issued) { return `OAA Agentverse sign-in\nWallet: ${wallet.toLowerCase()}\nSession: ${keyHash}\nIssued: ${issued}\n\nThis only proves you own this wallet. It costs nothing and moves no funds.`; }
async function walletOf(env, key) { if (!key || !env.MEDIA || !/^[0-9a-f]{64}$/.test(key)) return null; return env.MEDIA.get('s:' + (await sha(key))); }
async function creditsOf(env, w) { return Number((env.MEDIA && w && (await env.MEDIA.get('c:' + w))) || 0); }
function day() { return new Date().toISOString().slice(0, 10) + ':'; }


// ---------- OAA Guardian: read-only wallet check by SENTINEL + ZEN, daily brief by CORE, brief hash anchored by PROOF ----------
const GFREE = new Map();
async function scoutTokens(w) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try { const r = await fetch('https://base.blockscout.com/api/v2/addresses/' + w + '/tokens?type=ERC-20', { headers: { Accept: 'application/json' }, signal: ctl.signal }); if (!r.ok) return []; const j = await r.json(); return Array.isArray(j.items) ? j.items : []; }
  catch { return []; } finally { clearTimeout(t); }
}
export async function scanWallet(env, w, askWith, opts = {}) {
  const ethWei = await rpc(env, 'eth_getBalance', [w, 'latest']).catch(() => '0x0');
  let ethUsdP = null; try { ethUsdP = await ethUsd(env); } catch {}
  const eth = Number(big(ethWei)) / 1e18;
  const raw = (await scoutTokens(w)).map((it) => { const tk = it.token || {}; const dec = Number(tk.decimals || 18); const amt = Number(it.value || 0) / Math.pow(10, dec); const px = tk.exchange_rate != null ? Number(tk.exchange_rate) : null;
    return { address: String(tk.address_hash || tk.address || '').toLowerCase(), symbol: String(tk.symbol || '?').slice(0, 16), name: String(tk.name || '').slice(0, 40), amount: amt, priceUsd: px, valueUsd: px != null ? amt * px : null }; })
    .filter((x) => /^0x[0-9a-f]{40}$/.test(x.address) && x.amount > 0);
  raw.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
  const top = raw.slice(0, 6);
  const tokens = await Promise.all(top.map(async (x, i) => {
    const rc = await rugCheck(env, x.address).catch(() => null);
    const sig = i < 3 ? await signalFor(x.address, '4h').catch(() => null) : null;
    const flags = rc && Array.isArray(rc.checks) ? rc.checks.filter((c) => c.status === 'bad' || c.status === 'warn').slice(0, 3).map((c) => c.title || c.label || c.id) : [];
    const mk = rc && rc.market; const valueUsd = x.valueUsd != null ? x.valueUsd : mk && mk.priceUsd ? x.amount * mk.priceUsd : null;
    return { symbol: x.symbol, name: x.name, address: x.address, amount: x.amount, valueUsd, grade: rc && rc.grade || null, score: rc && rc.score != null ? rc.score : null, flags,
      signal: sig && sig.bias ? { bias: sig.bias, confidence: sig.confidence, timeframe: '4h' } : null };
  }));
  const ethVal = ethUsdP ? eth * ethUsdP : null;
  let wsum = ethVal || 0, ssum = (ethVal || 0) * 100;
  tokens.forEach((t) => { const v = t.valueUsd || 0; if (t.score != null && v > 0) { wsum += v; ssum += v * t.score; } });
  const health = wsum > 0 ? Math.round(ssum / wsum) : (tokens.length ? Math.round(tokens.reduce((a, t) => a + (t.score || 50), 0) / tokens.length) : 100);
  const data = { wallet: w, eth: { amount: eth, valueUsd: ethVal }, tokens, otherTokens: Math.max(0, raw.length - top.length), health };
  let brief = null;
  if (opts.brief !== false) try { brief = await askWith(env, 'You are the OAA Core writing the daily OAA Guardian brief for one wallet on Base. Use ONLY the numbers in TOOL DATA (balances, risk grades A-F from SENTINEL, 4h signals from ZEN, health score 0-100). Structure: one line with the health score, then 3 to 5 short bullet points: biggest risks first (low grades and their flags), then what the signals say, then one practical tip. Plain language, no advice to buy or sell, no tables. Max 120 words.\nTOOL DATA: ' + JSON.stringify(data).slice(0, 7000), [{ role: 'user', content: 'Write my wallet brief for today.' }]); } catch { brief = null; }
  if (opts.brief === false) return { data, brief: null, proof: null };
  const createdAt = new Date().toISOString(); const id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const hash = '0x' + hex(keccak_256(new TextEncoder().encode(JSON.stringify({ id, createdAt, wallet: w, health, brief }))));
  let proof = { id, hash, createdAt, status: 'not anchored (storage off)' };
  if (env.MEDIA) { await queueBrief(env, { id, hash, createdAt }).catch(() => null); proof.status = 'queued: anchored on Base with the next hourly OAA proof batch'; }
  return { data, brief, proof };
}
export async function guardian(env, body, ip, d) {
  const w = String(body.wallet || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(w)) return { error: 'bad_wallet' };
  const signed = await walletOf(env, body.key); const hold = signed && signed === w ? await holderOf(env, w) : null; const holder = !!(hold && hold.holder);
  const k = day() + (holder ? 'h:' + w : 'f:' + ip); const used = GFREE.get(k) || 0; const limit = holder ? 20 : 1;
  if (used >= limit) return { error: 'limit', holder, limit };
  const { data, brief, proof } = await scanWallet(env, w, d.askWith);
  GFREE.set(k, used + 1); if (GFREE.size > 20000) GFREE.clear();
  return { ...data, brief, holder, scansLeft: limit - used - 1, proof, note: 'Automatic check of public on-chain data. Not an audit, not financial advice.' };
}

export async function agentRoutes(request, env, url, origin, d) {
  const { json } = d;
  const p = url.pathname;
  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400, origin); }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  if (p === '/agent/config') {
    const w = await walletOf(env, body.key);
    let price = null; try { price = await ethUsd(env); } catch {}
    return json({ agents: Object.fromEntries(Object.entries(AGENTS).map(([k, v]) => [k, { name: v.name, role: v.role }])), paid: isPaid(env), priceUsd: PRICE_USD, freePerDay: perDay(env),
      freeLeft: perDay(env) - (free.get(day() + ip) || 0), treasury: env.TREASURY || null, ethUsd: price, wallet: w, credits: await creditsOf(env, w),
      swapFeeBps: env.TREASURY ? feeBps(env) : 0, x402: { sellerUrl: url.origin + '/x402', services: Object.entries(SERVICES).map(([k, s]) => ({ id: k, title: s.title, priceUsd: s.price, description: s.description, params: s.params })) } }, 200, origin);
  }
  if (p === '/agent/session') {
    if (!env.MEDIA) return json({ error: 'kv_off' }, 503, origin);
    const { wallet, key, issued, sig } = body;
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet || '') || !/^[0-9a-f]{64}$/.test(key || '') || !/^0x[0-9a-fA-F]{130}$/.test(sig || '')) return json({ error: 'bad_request' }, 400, origin);
    if (Math.abs(Date.now() - Date.parse(issued)) > 10 * 60 * 1000) return json({ error: 'expired' }, 400, origin);
    let who; try { who = recover(signInMessage(wallet, await sha(key), issued), sig); } catch { return json({ error: 'bad_signature' }, 400, origin); }
    if (who !== wallet.toLowerCase()) return json({ error: 'bad_signature' }, 400, origin);
    await env.MEDIA.put('s:' + (await sha(key)), who, { expirationTtl: 60 * 60 * 24 * 30 });
    return json({ wallet: who, credits: await creditsOf(env, who) }, 200, origin);
  }
  if (p === '/agent/credits') {
    if (!env.MEDIA || !env.TREASURY) return json({ error: 'credits_off' }, 503, origin);
    const w = await walletOf(env, body.key); if (!w) return json({ error: 'sign_in' }, 401, origin);
    const h = String(body.tx || ''); if (!/^0x[0-9a-fA-F]{64}$/.test(h)) return json({ error: 'bad_request' }, 400, origin);
    if (await env.MEDIA.get('t:' + h.toLowerCase())) return json({ error: 'used' }, 409, origin);
    const [tx, rc, tip] = await Promise.all([rpc(env, 'eth_getTransactionByHash', [h]), rpc(env, 'eth_getTransactionReceipt', [h]), rpc(env, 'eth_blockNumber', [])]);
    if (!tx || !rc) return json({ error: 'pending' }, 202, origin);
    if (rc.status !== '0x1') return json({ error: 'failed_tx' }, 400, origin);
    if (Number(big(tip)) - Number(big(rc.blockNumber)) + 1 < MIN_CONF) return json({ error: 'pending' }, 202, origin);
    if ((tx.from || '').toLowerCase() !== w || (tx.to || '').toLowerCase() !== env.TREASURY.toLowerCase()) return json({ error: 'wrong_tx' }, 400, origin);
    const usd = Number(big(tx.value)) / 1e18 * (await ethUsd(env));
    const add = Math.floor(usd / PRICE_USD + 1e-6); if (add < 1) return json({ error: 'too_small' }, 400, origin);
    await env.MEDIA.put('t:' + h.toLowerCase(), w);
    const c = (await creditsOf(env, w)) + add; await env.MEDIA.put('c:' + w, String(c));
    return json({ added: add, credits: c, usd }, 200, origin);
  }
  if (p === '/agent/chat') {
    const agent = AGENTS[body.agent] ? body.agent : null; if (!agent) return json({ error: 'bad_request' }, 400, origin);
    const messages = d.cleanMessages(body.messages); if (!messages) return json({ error: 'bad_request' }, 400, origin);
    const w = await walletOf(env, body.key); let credits = await creditsOf(env, w), paid = false;
    const used = free.get(day() + ip) || 0;
    const hold = w ? await holderOf(env, w) : null; const limit = fairUse(env) * (hold && hold.holder ? holderMult(env) : 1);
    if (!isPaid(env)) { if (used >= limit) return json({ error: 'fair_use', freeLeft: 0, holder: !!(hold && hold.holder) }, 429, origin); }
    else if (used < FREE_PER_DAY) paid = false; else if (credits > 0) paid = true; else return json({ error: 'no_credits', credits, freeLeft: 0 }, 402, origin);
    const last = messages[messages.length - 1].content;
    let tool = { data: {}, action: null }; try { tool = await route(env, agent, last); } catch (e) { tool.data.error = 'Market data is temporarily unavailable.'; }
    const sys = AGENTS[agent].prompt + '\n' + RULES_TEXT + '\nToday: ' + new Date().toISOString().slice(0, 10) + '\nTOOL DATA: ' + JSON.stringify(tool.data).slice(0, 9000) + (tool.action ? '\nACTION: ' + JSON.stringify(tool.action) : '');
    let reply;
    try { reply = await d.askWith(env, sys, messages); } catch (e) { if (d.QUOTA.test(String(e && e.message))) return json({ error: 'daily_limit' }, 429, origin); return json({ error: 'failed' }, 502, origin); }
    if (paid) { credits -= 1; await env.MEDIA.put('c:' + w, String(credits)); } else { free.set(day() + ip, used + 1); if (free.size > 20000) free.clear(); }
    return json({ reply, action: tool.action, data: tool.data, credits, freeLeft: (isPaid(env) ? perDay(env) : limit) - (free.get(day() + ip) || 0), holder: !!(hold && hold.holder) }, 200, origin);
  }
  if (p === '/agent/holder') {
    const w = await walletOf(env, body.key);
    let wallet = w; if (!wallet && /^0x[0-9a-fA-F]{40}$/.test(String(body.wallet || ''))) wallet = String(body.wallet).toLowerCase();
    const h = wallet ? await holderOf(env, wallet) : { balance: null, holder: false, min: holderMin(env), mult: holderMult(env), live: /^0x[0-9a-fA-F]{40}$/.test(String(env.OAA_TOKEN || '')) };
    return json({ wallet: wallet || null, signedIn: !!w, ...h, token: env.OAA_TOKEN || null, freePerDay: fairUse(env) }, 200, origin);
  }
  if (p === '/agent/guardian') { const r = await guardian(env, body, ip, d).catch(() => ({ error: 'unavailable' })); return json(r, r.error ? (r.error === 'limit' ? 429 : r.error === 'unavailable' ? 503 : 400) : 200, origin); }
  if (p === '/agent/rug') {
    let a = String(body.token || '').trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) { const m = await tokenBySymbol(a.replace(/^\$/, '')).catch(() => null); if (!m) return json({ error: 'not_found' }, 404, origin); a = m.address; }
    const r = await rugCheck(env, a).catch(() => ({ error: 'unavailable' }));
    return json(r, r.error ? (r.error === 'unavailable' ? 503 : 400) : 200, origin);
  }
  if (p === '/agent/record') { const r = await record(env).catch(() => ({ error: 'unavailable' })); return json(r, r.error ? 503 : 200, origin); }
  if (p === '/agent/batch') { const r = await batch(env, body.id).catch(() => null); return r ? json(r, 200, origin) : json({ error: 'not_found' }, 404, origin); }
  if (p === '/agent/swap') {
    const r = await swap(env, body).catch(() => ({ error: 'failed' }));
    return json(r, r.error ? (r.error === 'no_route' ? 404 : 400) : 200, origin);
  }
  if (p === '/agent/signals') {
    const tf = ['1h', '4h', '1d'].includes(body.tf) ? body.tf : '1h';
    if (body.asset) { const s = await signalFor(String(body.asset).slice(0, 60), tf).catch(() => null); return s ? json({ signal: s }, 200, origin) : json({ error: 'unavailable' }, 503, origin); }
    const board = await signalBoard(MAJORS.slice(0, 8), tf).catch(() => []);
    return json({ board, timeframe: tf, generatedAt: new Date().toISOString() }, 200, origin);
  }
  if (p === '/agent/market') {
    const own = Object.entries(SERVICES).map(([k, s]) => ({ url: url.origin + '/x402/' + k, agent: s.agent, name: 'OAA · ' + s.title, host: url.host, description: s.description, priceUsd: s.price, payTo: env.TREASURY || null, network: 'base', x402Version: 2, method: 'GET', input: { queryParams: s.params, body: null }, own: true }));
    let items = []; let error = null;
    try { items = await discover(String(body.q || '').slice(0, 200), body.maxUsd ? Number(body.maxUsd) : null); } catch { error = 'The x402 directory is not reachable right now.'; }
    const q = String(body.q || '').toLowerCase();
    return json({ own: env.TREASURY ? own.filter((o) => !q || (o.name + ' ' + o.description).toLowerCase().includes(q)) : [], items: items.slice(0, 60), error }, 200, origin);
  }
  if (p === '/agent/x402call') {
    const r = await callPaid(env, body, url).catch(() => ({ error: 'failed' }));
    return json(r, 200, origin);
  }
  return json({ error: 'not_found' }, 404, origin);
}
export const HELP = { oaaTokens, walletInfo, tokenInfo, scoutTokens, swap };
