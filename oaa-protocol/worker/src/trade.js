// OAA trading: swaps for any token on Base through the KyberSwap aggregator.
// Non-custodial: the worker only builds the transaction, the user signs it in their own wallet.
// A small swap fee (SWAP_FEE_BPS, default 30 = 0.3%) is routed by the aggregator straight to the TREASURY.
import { NATIVE, WETH } from './market.js';

const KYBER = 'https://aggregator-api.kyberswap.com/base/api/v1';
const CLIENT = 'OAA';

export function feeBps(env) { const n = parseInt(env.SWAP_FEE_BPS == null ? '30' : env.SWAP_FEE_BPS, 10); return isFinite(n) && n >= 0 && n <= 100 ? n : 30; }

async function kyber(path, init) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(KYBER + path, { ...init, headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT, ...(init && init.headers) }, signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || (j.code != null && j.code !== 0)) throw new Error((j && j.message) || 'no_route');
    return j.data;
  } finally { clearTimeout(t); }
}
function feeQuery(env) {
  const bps = feeBps(env);
  return env.TREASURY && bps > 0 ? '&feeAmount=' + bps + '&feeReceiver=' + env.TREASURY + '&chargeFeeBy=currency_in&isInBps=true' : '';
}

// amountIn is a decimal string in base units (wei)
export async function quote(env, tokenIn, tokenOut, amountIn) {
  const d = await kyber('/routes?tokenIn=' + tokenIn + '&tokenOut=' + tokenOut + '&amountIn=' + amountIn + '&gasInclude=true' + feeQuery(env));
  const s = d.routeSummary;
  return { routeSummary: s, router: d.routerAddress, amountIn: s.amountIn, amountOut: s.amountOut, amountInUsd: Number(s.amountInUsd || 0), amountOutUsd: Number(s.amountOutUsd || 0), gasUsd: Number(s.gasUsd || 0) };
}

export async function build(env, q, sender, slippageBps) {
  const d = await kyber('/route/build', { method: 'POST', body: JSON.stringify({ routeSummary: q.routeSummary, sender, recipient: sender, slippageTolerance: Math.max(10, Math.min(1500, slippageBps || 100)), source: CLIENT, enableGasEstimation: false }) });
  return { to: d.routerAddress, data: d.data, value: '0x' + BigInt(d.transactionValue || '0').toString(16), amountOut: d.amountOut, router: d.routerAddress };
}

export const isNative = (a) => a.toLowerCase() === NATIVE.toLowerCase();
export { NATIVE, WETH };
