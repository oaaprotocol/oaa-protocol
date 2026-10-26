// Test fixtures: replaces the public APIs (not reachable from the sandbox) with realistic responses.
import { ethers } from 'ethers';
export const ROUTER = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc'.replace('9965507D1a55bcC2695C58ba16FB37d819B0A4dc', '976EA74026E726554dB657fA54763abd0C3a0aa9'); // hardhat #6
export const SELLER = '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955'; // hardhat #7
export const calls = [];
const realFetch = globalThis.fetch;
function candles(n, start, drift, stepSec, vol = 0.01, seed = 1) {
  let p = start, s = seed; const out = []; const now = Math.floor(Date.now() / 1000 / stepSec) * stepSec;
  for (let i = n - 1; i >= 0; i--) { s = (s * 9301 + 49297) % 233280; const rnd = s / 233280 - 0.5; const o = p; p = p * (1 + drift + rnd * vol); const h = Math.max(o, p) * (1 + vol / 3), l = Math.min(o, p) * (1 - vol / 3); out.push([now - i * stepSec, o, h, l, p, 1000 + (s % 500)]); }
  return out; // ascending
}
const J = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...headers } });
export function pair(addr, sym, name, price, liq) {
  return { chainId: 'base', dexId: 'aerodrome', url: 'https://dexscreener.com/base/0xpool' + sym, pairAddress: '0x' + sym.toLowerCase().padEnd(40, 'a').slice(0, 40).replace(/[^0-9a-f]/g, 'a'), baseToken: { address: addr, name, symbol: sym }, quoteToken: { symbol: 'WETH' },
    priceNative: '0.0001', priceUsd: String(price), txns: { h24: { buys: 420, sells: 380 } }, volume: { h24: 125000 }, priceChange: { m5: 0.4, h1: 2.1, h6: -1.2, h24: 8.5 }, liquidity: { usd: liq }, fdv: price * 1e9, marketCap: price * 1e9, pairCreatedAt: Date.now() - 86400000 * 30 };
}
export const TOKENS = {}; // address(lower) -> pair, filled by tests
export const PM = { v: 1 }; // price multiplier for Coinbase / FX candles (to simulate moves)
export const SCOUT = {};
export const RELAY = { calls: [], noOaa: false };
export const GUARD = {}; // wallet(lower) -> blockscout token items // address(lower) -> { verified, holders:[{address,value}] }
export function install({ local = 'http://127.0.0.1:8104' } = {}) {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
    calls.push(url.split('?')[0]);
    const u = new URL(url);
    if (u.host === 'api.relay.link') {
      RELAY.calls.push({ path: u.pathname, body: init.body ? JSON.parse(init.body) : null });
      if (u.pathname === '/chains') return J({ chains: [{ id: 8253038, currency: { address: 'bc1qnative' } }, { id: 792703809, currency: { address: '11111111111111111111111111111111' } }, { id: 1, currency: { address: '0x0000000000000000000000000000000000000000' } }] });
      if (u.pathname === '/quote/v2') {
        const b = JSON.parse(init.body); if (RELAY.noOaa && b.destinationCurrency !== '0x0000000000000000000000000000000000000000') return J({ message: 'No route' }, 400);
        const dep = !!b.useDepositAddress; const isUsdc = /^0x(833589|a0b869|af88d0)/i.test(b.originCurrency);
        const steps = dep ? [{ id: 'deposit', kind: 'transaction', depositAddress: b.originChainId === 8253038 ? 'bc1qrelaydepositaddressxxxxxxxxxxxxxxxxxx' : 'RelayDep0sitSoLanaAddre55xxxxxxxxxxxxxxxx', requestId: '0x' + 'ab'.repeat(32), items: [{ status: 'incomplete', data: {} }] }]
          : [].concat(isUsdc ? [{ id: 'approve', kind: 'transaction', action: 'Approve USDC', description: 'Approve', items: [{ status: 'incomplete', data: { to: b.originCurrency, data: '0x095ea7b3', value: '0', chainId: b.originChainId } }] }] : [], [{ id: 'deposit', kind: 'transaction', action: 'Confirm', description: 'Deposit', requestId: '0x' + 'cd'.repeat(32), items: [{ status: 'incomplete', data: { to: '0x' + '11'.repeat(20), data: '0xdeadbeef', value: isUsdc ? '0' : b.amount, chainId: b.originChainId } }] }]);
        return J({ requestId: '0x' + 'cd'.repeat(32), steps, fees: { app: { amountUsd: '0.15' }, relayer: { amountUsd: '0.40' }, gas: { amountUsd: '0.10' } }, details: { currencyIn: { amountUsd: '50.00' }, currencyOut: { amountFormatted: b.destinationCurrency === '0x0000000000000000000000000000000000000000' ? '0.0123' : '1234567.89', amountUsd: '49.35', currency: { symbol: b.destinationCurrency === '0x0000000000000000000000000000000000000000' ? 'ETH' : 'OAA' } }, timeEstimate: dep ? 900 : 12 } });
      }
      if (u.pathname === '/requests/v3') return J({ requests: [{ status: 'success', data: { inTxs: [{ hash: '0xin' }], outTxs: [{ hash: '0xout' }] } }] });
    }
    if (u.host === 'api.dexscreener.com') {
      if (u.pathname.startsWith('/latest/dex/tokens/')) { const a = u.pathname.split('/').pop().toLowerCase(); return J({ pairs: TOKENS[a] ? [TOKENS[a], { ...TOKENS[a], chainId: 'ethereum', liquidity: { usd: 9e9 } }] : [] }); }
      if (u.pathname === '/latest/dex/search') { const q = u.searchParams.get('q').toUpperCase(); return J({ pairs: Object.values(TOKENS).filter((p) => p.baseToken.symbol.toUpperCase() === q) }); }
    }
    if (u.host === 'api.geckoterminal.com') {
      if (u.pathname.endsWith('/trending_pools')) return J({ data: Object.values(TOKENS).map((p) => ({ id: 'base_' + p.pairAddress, attributes: { name: p.baseToken.symbol + ' / WETH', address: p.pairAddress, base_token_price_usd: p.priceUsd, price_change_percentage: { h1: '1.2', h24: '8.5' }, volume_usd: { h24: '125000' }, reserve_in_usd: String(p.liquidity.usd), market_cap_usd: null, fdv_usd: String(p.fdv) }, relationships: { base_token: { data: { id: 'base_' + p.baseToken.address } } } })) });
      if (u.pathname.includes('/ohlcv/')) { const c = candles(200, 0.0012, 0.004, 3600, 0.02, 7).reverse(); return J({ data: { attributes: { ohlcv_list: c.map((x) => [x[0], x[1], x[2], x[3], x[4], x[5]]) } } }); }
    }
    if (u.host === 'api.exchange.coinbase.com') {
      const sym = u.pathname.split('/')[2].split('-')[0]; const g = Number(u.searchParams.get('granularity'));
      const start = { BTC: 64000, ETH: 3500, SOL: 150 }[sym] || 10; const drift = sym === 'BTC' ? 0.002 : sym === 'SOL' ? -0.003 : 0.0005;
      return J(candles(300, start, drift, g, 0.008, sym.length * 13).reverse().map((x) => [x[0], x[3] * PM.v, x[2] * PM.v, x[1] * PM.v, x[4] * PM.v, x[5]]));
    }
    if (u.host === 'api.frankfurter.dev' || u.host === 'api.frankfurter.app') {
      const to = u.searchParams.get('to'); const rates = {}; const c = candles(200, 1.08, 0.0008, 86400, 0.004, 3);
      c.forEach((x) => { rates[new Date(x[0] * 1000).toISOString().slice(0, 10)] = { [to]: Number((x[4] * PM.v).toFixed(5)) }; });
      return J({ amount: 1, base: u.searchParams.get('from'), rates });
    }
    if (u.host === 'aggregator-api.kyberswap.com') {
      if (u.pathname.endsWith('/routes')) {
        const ai = u.searchParams.get('amountIn'); const tin = u.searchParams.get('tokenIn');
        const fee = u.searchParams.get('feeReceiver');
        return J({ code: 0, message: 'successfully', data: { routerAddress: ROUTER, routeSummary: { tokenIn: tin, amountIn: ai, amountInUsd: '35', tokenOut: u.searchParams.get('tokenOut'), amountOut: (BigInt(ai) * 1000n).toString(), amountOutUsd: '34.8', gas: '200000', gasPrice: '1', gasUsd: '0.01', l1FeeUsd: '0', extraFee: fee ? { feeAmount: u.searchParams.get('feeAmount'), chargeFeeBy: u.searchParams.get('chargeFeeBy'), isInBps: true, feeReceiver: fee } : {}, route: [], routeID: 'r1', checksum: '1', timestamp: Math.floor(Date.now() / 1000) } } });
      }
      if (u.pathname.endsWith('/route/build')) {
        const b = JSON.parse(init.body); const native = b.routeSummary.tokenIn.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
        return J({ code: 0, message: 'successfully', data: { amountIn: b.routeSummary.amountIn, amountOut: b.routeSummary.amountOut, routerAddress: ROUTER, data: '0x', transactionValue: native ? b.routeSummary.amountIn : '0', extraFee: b.routeSummary.extraFee } });
      }
    }
    if (u.host === 'api.cdp.coinbase.com') {
      const items = [
        { resource: local + '/weather', type: 'http', x402Version: 1, description: 'Weather for a city', serviceName: 'Mock Weather', accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '1000', resource: local + '/weather', payTo: SELLER, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' }, outputSchema: { input: { type: 'http', method: 'GET', queryParams: { city: 'Berlin' } } } }], quality: { l30DaysTotalCalls: 5400, l30DaysUniquePayers: 120, lastCalledAt: new Date().toISOString() } },
        { resource: local + '/news', type: 'http', x402Version: 2, description: 'Crypto news summary', serviceName: 'Mock News', accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '5000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: SELLER, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }], extensions: { bazaar: { info: { input: { type: 'http', method: 'GET', queryParams: { topic: 'base' } }, output: { type: 'json', example: { headline: '...' } } } } }, quality: { l30DaysTotalCalls: 900, l30DaysUniquePayers: 40 } },
        { resource: 'https://solana.example/x', type: 'http', x402Version: 2, accepts: [{ scheme: 'exact', network: 'solana', amount: '10', asset: 'So111', payTo: 'abc' }] },
      ];
      if (u.pathname.endsWith('/search')) return J({ resources: items.filter((i) => (i.description || '').toLowerCase().includes((u.searchParams.get('query') || '').toLowerCase().split(' ')[0])), partialResults: false, x402Version: 2 });
      return J({ items, x402Version: 2, pagination: { limit: 100, offset: 0, total: items.length } });
    }
    if (u.host === 'base.blockscout.com') {
      const m = u.pathname.match(/0x[0-9a-fA-F]{40}/); const a = m && m[0].toLowerCase();
      if (u.pathname.endsWith('/tokens') && u.pathname.includes('/addresses/')) return J({ items: GUARD[a] || [], next_page_params: null });
      const d = SCOUT[a];
      if (!d) return J({ message: 'Not found' }, 404);
      if (u.pathname.includes('/smart-contracts/')) return J({ is_verified: d.verified, name: 'X' });
      if (u.pathname.endsWith('/holders')) return J({ items: d.holders.map((h) => ({ address_hash: { hash: h.address, is_contract: false }, value: h.value })), next_page_params: null });
    }
    if (u.host === 'facilitator.payai.network') {
      const b = JSON.parse(init.body); const pp = b.paymentPayload, rq = b.paymentRequirements; const a = pp.payload.authorization;
      const signer = ethers.verifyTypedData({ name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: rq.asset }, { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }, a, pp.payload.signature);
      const ok = signer.toLowerCase() === a.from.toLowerCase() && a.to.toLowerCase() === rq.payTo.toLowerCase() && BigInt(a.value) >= BigInt(rq.amount || rq.maxAmountRequired);
      if (u.pathname === '/verify') return J(ok ? { isValid: true, payer: a.from } : { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' });
      return J(ok ? { success: true, transaction: '0x' + 'ab'.repeat(32), network: 'eip155:8453', payer: a.from } : { success: false, errorReason: 'invalid' });
    }
    return new Response('blocked in test: ' + url, { status: 599 });
  };
}
// Local x402 seller used by the marketplace test (v1 style /weather, v2 style /news).
export function sellerServer(http, port = 8104) {
  return http.createServer((q, s) => {
    const u = new URL(q.url, 'http://127.0.0.1:' + port);
    const v1 = u.pathname === '/weather';
    const reqs = v1 ? { scheme: 'exact', network: 'base', maxAmountRequired: '1000', resource: 'http://127.0.0.1:' + port + '/weather', description: 'Weather', mimeType: 'application/json', payTo: SELLER, maxTimeoutSeconds: 60, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', extra: { name: 'USD Coin', version: '2' } }
      : { scheme: 'exact', network: 'eip155:8453', amount: '5000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: SELLER, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } };
    const hdr = q.headers[v1 ? 'x-payment' : 'payment-signature'];
    const pr = { x402Version: v1 ? 1 : 2, error: 'payment required', resource: { url: u.href }, accepts: [reqs] };
    if (!hdr) { s.writeHead(402, { 'Content-Type': 'application/json', ...(v1 ? {} : { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(pr)).toString('base64') }) }); return s.end(v1 ? JSON.stringify(pr) : ''); }
    try {
      const p = JSON.parse(Buffer.from(hdr, 'base64').toString()); const a = p.payload.authorization;
      const signer = ethers.verifyTypedData({ name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: reqs.asset }, { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }, a, p.payload.signature);
      if (signer.toLowerCase() !== a.from.toLowerCase() || a.to.toLowerCase() !== SELLER.toLowerCase() || (!v1 && JSON.stringify(p.accepted) !== JSON.stringify(reqs))) throw 0;
      const rcpt = Buffer.from(JSON.stringify({ success: true, transaction: '0x' + 'cd'.repeat(32), network: 'base', payer: a.from })).toString('base64');
      s.writeHead(200, { 'Content-Type': 'application/json', [v1 ? 'X-PAYMENT-RESPONSE' : 'PAYMENT-RESPONSE']: rcpt });
      s.end(JSON.stringify(v1 ? { city: u.searchParams.get('city'), weather: 'sunny', temperatureC: 21 } : { headline: 'Base hits new activity record', topic: u.searchParams.get('topic') }));
    } catch { s.writeHead(402, { 'Content-Type': 'application/json' }); s.end(JSON.stringify({ ...pr, error: 'invalid payment' })); }
  }).listen(port);
}
