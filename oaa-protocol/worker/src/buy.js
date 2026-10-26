// OAA "Buy with any coin": quotes and orders through Relay (cross-chain swaps), output is $OAA on Base.
// EVM coins (ETH, USDC, BNB) are signed in the buyer's own wallet; BTC and SOL use a one-time Relay deposit address.
// An app fee (BUY_FEE_BPS, default 30 = 0.3%) accrues to TREASURY as a claimable USDC balance at Relay.
// Nothing here holds funds.
const RELAY = 'https://api.relay.link';
// Since 2 Oct 2026 Relay requires an API key (RELAY_API_KEY) for every quote. Without it, only ETH on Base works (direct swap via the AQL swap builder).
const BASE = 8453;
const NATIVE_EVM = '0x0000000000000000000000000000000000000000';
export const PAY = {
  btc: { label: 'BTC', name: 'Bitcoin', chainId: 8253038, decimals: 8, native: true, kind: 'deposit', addr: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/ },
  sol: { label: 'SOL', name: 'Solana', chainId: 792703809, decimals: 9, native: true, kind: 'deposit', addr: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ },
  eth: { label: 'ETH', name: 'Ethereum', decimals: 18, native: true, kind: 'wallet', nets: { 1: 'Ethereum', 8453: 'Base', 42161: 'Arbitrum' } },
  usdc: { label: 'USDC', name: 'USD Coin', decimals: 6, kind: 'wallet', nets: { 8453: 'Base', 1: 'Ethereum', 42161: 'Arbitrum' },
    tokens: { 8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' } },
  bnb: { label: 'BNB', name: 'BNB Chain', decimals: 18, native: true, kind: 'wallet', nets: { 56: 'BNB Chain' } },
};
const feeBps = (env) => { const n = parseInt(env.BUY_FEE_BPS || '30', 10); return isFinite(n) && n >= 0 && n <= 100 ? n : 30; };
const oaa = (env) => (/^0x[0-9a-fA-F]{40}$/.test(String(env.OAA_TOKEN || '')) ? env.OAA_TOKEN : null);
let CHAINS = { at: 0, map: {} };
async function nativeOf(env, chainId) {
  if (Date.now() - CHAINS.at > 3600e3) {
    try { const r = await fetch(RELAY + '/chains', { headers: hdr(env) }); const j = await r.json(); const m = {}; for (const c of (j.chains || [])) m[c.id] = c.currency && c.currency.address; CHAINS = { at: Date.now(), map: m }; } catch {}
  }
  return CHAINS.map[chainId] || (chainId === 792703809 ? '11111111111111111111111111111111' : chainId === 8253038 ? 'bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8' : NATIVE_EVM);
}
function hdr(env) { const h = { 'Content-Type': 'application/json' }; if (env.RELAY_API_KEY) h['x-api-key'] = env.RELAY_API_KEY; return h; }
function units(amount, dec) {
  const s = String(amount || '').trim(); if (!/^\d{1,12}(\.\d{1,18})?$/.test(s)) return null;
  const [i, f = ''] = s.split('.'); const v = BigInt(i) * 10n ** BigInt(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0'); return v > 0n ? v.toString() : null;
}
function summary(q, twoStep) {
  const d = q.details || {}; const out = d.currencyOut || {}; const fees = q.fees || {};
  const step = (q.steps || []).find((s) => s.depositAddress) || null;
  return {
    requestId: q.requestId || (q.steps && q.steps[0] && q.steps[0].requestId) || null,
    out: out.amountFormatted || null, outUsd: out.amountUsd || null, outSymbol: (out.currency && out.currency.symbol) || null,
    inUsd: (d.currencyIn && d.currencyIn.amountUsd) || null, timeSec: d.timeEstimate || null, rate: d.rate || null,
    fees: { app: fees.app ? fees.app.amountUsd : null, relayer: fees.relayer ? fees.relayer.amountUsd : null, gas: fees.gas ? fees.gas.amountUsd : null },
    depositAddress: step ? step.depositAddress : null, twoStep: !!twoStep,
    steps: (q.steps || []).filter((s) => !s.depositAddress).map((s) => ({ id: s.id, kind: s.kind, action: s.action, description: s.description, items: (s.items || []).map((it) => ({ status: it.status, data: it.data ? { to: it.data.to, data: it.data.data, value: it.data.value, chainId: it.data.chainId } : null })) })),
  };
}
async function quote(env, b) {
  const p = PAY[b.pay]; if (!p) return { error: 'bad_pay' };
  const token = oaa(env); if (!token) return { error: 'not_live' };
  const recipient = String(b.recipient || ''); if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) return { error: 'bad_recipient' };
  let chainId, currency, user;
  if (p.kind === 'deposit') {
    chainId = p.chainId; currency = await nativeOf(env, chainId); user = String(b.from || '').trim();
    if (!p.addr.test(user)) return { error: 'bad_from' };
  } else {
    chainId = Number(b.chainId); if (!p.nets[chainId]) return { error: 'bad_chain' };
    currency = p.tokens ? p.tokens[chainId] : NATIVE_EVM; user = String(b.from || '');
    if (!/^0x[0-9a-fA-F]{40}$/.test(user)) return { error: 'bad_from' };
  }
  const amount = units(b.amount, p.decimals); if (!amount) return { error: 'bad_amount' };
  if (!env.RELAY_API_KEY) {
    if (b.pay !== 'eth' || chainId !== BASE) return { error: 'needs_key' };
    if (user.toLowerCase() !== recipient.toLowerCase()) return { error: 'bad_recipient', message: 'Without cross-chain routing the paying wallet also receives the $OAA.' };
    const { swap } = await import('./agents.js');
    const r = await swap(env, { sender: user, token, side: 'buy', amountEth: Number(b.amount), slippageBps: 300 });
    if (!r || r.error) return { error: r && r.error === 'no_route' ? 'no_route' : 'unavailable' };
    const feeUsd = r.amountInUsd && r.feeBps ? (Number(r.amountInUsd) * r.feeBps / 10000).toFixed(2) : null;
    return { requestId: null, out: r.amountOut, outUsd: r.amountOutUsd || null, outSymbol: 'OAA', inUsd: r.amountInUsd || null, timeSec: 5, fees: { app: feeUsd, relayer: '0', gas: r.gasUsd || null }, depositAddress: null, twoStep: false, direct: true,
      steps: [{ id: 'swap', kind: 'transaction', action: 'Swap ETH to $OAA', items: [{ status: 'incomplete', data: { to: r.tx.to, data: r.tx.data, value: r.tx.value, chainId: BASE } }] }] };
  }
  const body = { user, recipient, originChainId: chainId, destinationChainId: BASE, originCurrency: currency, destinationCurrency: token, amount, tradeType: 'EXACT_INPUT',
    slippageTolerance: '300', appFees: env.TREASURY && feeBps(env) ? [{ recipient: env.TREASURY, fee: String(feeBps(env)) }] : undefined };
  if (p.kind === 'deposit') { body.useDepositAddress = true; body.refundTo = user; }
  const ask = async (b2) => { let r = await fetch(RELAY + '/quote/v2', { method: 'POST', headers: hdr(env), body: JSON.stringify(b2) }); if (r.status === 404) r = await fetch(RELAY + '/quote', { method: 'POST', headers: hdr(env), body: JSON.stringify(b2) }); const j = await r.json().catch(() => ({})); return { ok: r.ok, j }; };
  let { ok, j } = await ask(body);
  if (ok) return summary(j, false);
  // fallback: route to ETH on Base; the buyer then swaps ETH -> $OAA on Aerodrome (second step in the same window)
  const b2 = { ...body, destinationCurrency: NATIVE_EVM }; const r2 = await ask(b2);
  if (r2.ok) return summary(r2.j, true);
  return { error: 'no_route', message: String((j && j.message) || (r2.j && r2.j.message) || 'No route right now.').slice(0, 200) };
}
async function status(env, b) {
  const q = new URLSearchParams(); if (/^0x[0-9a-fA-F]{64}$/.test(String(b.requestId || ''))) q.set('id', b.requestId); else if (/^[A-Za-z0-9]{20,100}$/.test(String(b.depositAddress || ''))) q.set('depositAddress', b.depositAddress); else return { error: 'bad_request' };
  try { const r = await fetch(RELAY + '/requests/v3?' + q, { headers: hdr(env) }); if (!r.ok) return { status: 'unknown' }; const j = await r.json(); const x = (j.requests || [])[0];
    return x ? { status: x.status, inTx: x.data && x.data.inTxs && x.data.inTxs[0] ? x.data.inTxs[0].hash : null, outTx: x.data && x.data.outTxs && x.data.outTxs[0] ? x.data.outTxs[0].hash : null } : { status: 'waiting' };
  } catch { return { error: 'unavailable' }; }
}
const HITS = new Map();
function slow(ip) { const now = Date.now(); const h = (HITS.get(ip) || []).filter((t) => now - t < 60000); if (h.length >= 40) return true; h.push(now); HITS.set(ip, h); if (HITS.size > 20000) HITS.clear(); return false; }
export async function buyRoutes(request, env, url, origin, json) {
  if (slow(request.headers.get('CF-Connecting-IP') || 'unknown')) return json({ error: 'slow_down' }, 429, origin);
  let b = {}; try { b = await request.json(); } catch { return json({ error: 'bad_request' }, 400, origin); }
  if (url.pathname === '/buy/config') return json({ live: !!oaa(env), crossChain: !!env.RELAY_API_KEY, token: oaa(env), feeBps: feeBps(env), treasury: env.TREASURY || null, pay: Object.fromEntries(Object.entries(PAY).map(([k, p]) => [k, { label: p.label, name: p.name, kind: p.kind, nets: p.nets || null }])) }, 200, origin);
  if (url.pathname === '/buy/quote') { const r = await quote(env, b).catch(() => ({ error: 'unavailable' })); return json(r, r.error ? (r.error === 'not_live' ? 409 : r.error === 'no_route' ? 404 : r.error === 'unavailable' ? 503 : 400) : 200, origin); }
  if (url.pathname === '/buy/status') { const r = await status(env, b); return json(r, r.error ? 400 : 200, origin); }
  return json({ error: 'not_found' }, 404, origin);
}
