// OAA market data + signal engine. Only free public sources, cached so the worker stays inside their rate limits.
//   DexScreener   token prices, liquidity, volume on Base            https://api.dexscreener.com
//   GeckoTerminal OHLCV candles of Base pools, trending pools        https://api.geckoterminal.com
//   Coinbase      candles of major coins (BTC, ETH, SOL ...)         https://api.exchange.coinbase.com
//   Frankfurter   daily ECB reference rates for forex                https://api.frankfurter.dev

const mem = new Map();
export async function cached(key, ttlSec, fn) {
  const hit = mem.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  if (hit && hit.pending) return hit.pending;
  const pending = fn().then((val) => { mem.set(key, { val, exp: Date.now() + ttlSec * 1000 }); if (mem.size > 2000) mem.clear(); return val; })
    .catch((e) => { if (hit && hit.val !== undefined) { mem.set(key, { val: hit.val, exp: Date.now() + 30000 }); return hit.val; } mem.delete(key); throw e; });
  mem.set(key, { val: hit && hit.val, exp: 0, pending });
  return pending;
}
async function getJson(url, ms = 9000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'OAA-Agents/1.0' }, signal: ctl.signal });
    if (!r.ok) throw new Error('http ' + r.status + ' ' + url.split('?')[0]);
    return await r.json();
  } finally { clearTimeout(t); }
}

export const MAJORS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'LINK', 'AVAX', 'LTC', 'DOT', 'SUI', 'SHIB', 'UNI', 'AAVE', 'NEAR', 'APT', 'ARB', 'OP', 'PEPE', 'BCH'];
export const FX = ['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD', 'SEK', 'NOK', 'PLN', 'TRY', 'CNY', 'HKD', 'SGD', 'MXN', 'ZAR', 'INR'];
export const WETH = '0x4200000000000000000000000000000000000006';
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// ---------- DexScreener ----------
function pairOut(p) {
  return {
    symbol: p.baseToken && p.baseToken.symbol, name: p.baseToken && p.baseToken.name, address: p.baseToken && p.baseToken.address,
    pair: p.pairAddress, dex: p.dexId, quote: p.quoteToken && p.quoteToken.symbol,
    priceUsd: p.priceUsd != null ? Number(p.priceUsd) : null,
    change: { m5: num(p.priceChange, 'm5'), h1: num(p.priceChange, 'h1'), h6: num(p.priceChange, 'h6'), h24: num(p.priceChange, 'h24') },
    volume24hUsd: num(p.volume, 'h24'), liquidityUsd: p.liquidity ? Number(p.liquidity.usd || 0) : null,
    marketCapUsd: p.marketCap != null ? Number(p.marketCap) : (p.fdv != null ? Number(p.fdv) : null),
    txns24h: p.txns && p.txns.h24 ? { buys: p.txns.h24.buys, sells: p.txns.h24.sells } : null,
    createdAt: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString().slice(0, 10) : null, url: p.url || null,
  };
}
function num(o, k) { return o && o[k] != null ? Number(o[k]) : null; }
function best(pairs, addr) {
  const base = (pairs || []).filter((p) => p.chainId === 'base' && (!addr || (p.baseToken && p.baseToken.address.toLowerCase() === addr.toLowerCase())));
  base.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
  return base[0] || null;
}
export async function tokenByAddress(addr) {
  const j = await cached('ds:t:' + addr.toLowerCase(), 30, () => getJson('https://api.dexscreener.com/latest/dex/tokens/' + addr));
  const p = best(j.pairs, addr); return p ? pairOut(p) : null;
}
export async function tokenBySymbol(sym) {
  const s = sym.replace(/^\$/, '').toUpperCase();
  const j = await cached('ds:s:' + s, 60, () => getJson('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(s)));
  const pairs = (j.pairs || []).filter((p) => p.chainId === 'base' && p.baseToken && p.baseToken.symbol.toUpperCase() === s);
  const p = best(pairs); return p ? pairOut(p) : null;
}

// ---------- GeckoTerminal ----------
export async function trendingBase() {
  const j = await cached('gt:trend', 300, () => getJson('https://api.geckoterminal.com/api/v2/networks/base/trending_pools?page=1'));
  return (j.data || []).slice(0, 12).map((d) => {
    const a = d.attributes || {}; const bt = (((d.relationships || {}).base_token || {}).data || {}).id || '';
    return { name: a.name, pool: a.address, token: bt.replace(/^base_/, ''), priceUsd: a.base_token_price_usd != null ? Number(a.base_token_price_usd) : null,
      change: { h1: num(a.price_change_percentage, 'h1'), h24: num(a.price_change_percentage, 'h24') },
      volume24hUsd: num(a.volume_usd, 'h24'), liquidityUsd: a.reserve_in_usd != null ? Number(a.reserve_in_usd) : null,
      marketCapUsd: a.market_cap_usd != null ? Number(a.market_cap_usd) : (a.fdv_usd != null ? Number(a.fdv_usd) : null) };
  });
}
async function poolCandles(pool, tf) {
  const path = tf === '1d' ? 'day?aggregate=1' : tf === '4h' ? 'hour?aggregate=4' : 'hour?aggregate=1';
  const j = await cached('gt:o:' + pool + tf, tf === '1d' ? 1800 : 300, () => getJson('https://api.geckoterminal.com/api/v2/networks/base/pools/' + pool + '/ohlcv/' + path + '&limit=200&currency=usd'));
  const list = (((j.data || {}).attributes || {}).ohlcv_list || []).map((c) => [Number(c[0]), +c[1], +c[2], +c[3], +c[4], +c[5]]);
  return list.sort((a, b) => a[0] - b[0]);
}

// ---------- Coinbase (majors) ----------
async function majorCandles(sym, tf) {
  const g = tf === '1d' ? 86400 : tf === '4h' ? 21600 : 3600;
  const j = await cached('cb:' + sym + g, tf === '1d' ? 1800 : 300, () => getJson('https://api.exchange.coinbase.com/products/' + sym + '-USD/candles?granularity=' + g));
  if (!Array.isArray(j)) throw new Error('no candles');
  return j.map((c) => [Number(c[0]), +c[3], +c[2], +c[1], +c[4], +c[5]]).sort((a, b) => a[0] - b[0]);
}

// ---------- Frankfurter (forex, daily) ----------
export async function fxSeries(base, quote) {
  const from = new Date(Date.now() - 300 * 864e5).toISOString().slice(0, 10);
  const q = '?from=' + base + '&to=' + quote;
  const j = await cached('fx:' + base + quote, 3600, () => getJson('https://api.frankfurter.dev/v1/' + from + '..' + q).catch(() => getJson('https://api.frankfurter.app/' + from + '..' + q)));
  return Object.keys(j.rates || {}).sort().map((d) => { const v = Number(j.rates[d][quote]); return [Date.parse(d) / 1000, v, v, v, v, 0]; });
}

// ---------- indicators ----------
function ema(xs, n) { const k = 2 / (n + 1); let e = xs[0]; const o = [e]; for (let i = 1; i < xs.length; i++) { e = xs[i] * k + e * (1 - k); o.push(e); } return o; }
function rsi(xs, n = 14) {
  if (xs.length <= n) return null; let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = xs[i] - xs[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < xs.length; i++) { const d = xs[i] - xs[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function atr(c, n = 14) {
  if (c.length <= n) return null; const tr = [];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])));
  let a = tr.slice(0, n).reduce((s, x) => s + x, 0) / n; for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n; return a;
}
const r = (x, d = 2) => x == null || !isFinite(x) ? null : Number(x.toFixed(d));
const sig = (x) => { if (x == null || !isFinite(x) || x === 0) return x; const d = Math.max(2, 4 - Math.floor(Math.log10(Math.abs(x)))); return Number(x.toFixed(Math.min(d, 12))); };

// Deterministic, explainable signal. Same input always gives the same output.
export function analyze(candles, opts = {}) {
  const c = candles.filter((x) => x[4] > 0);
  if (c.length < 30) return { bias: 'no signal', score: 0, confidence: 0, reasons: ['Not enough price history yet (' + c.length + ' candles).'], invalidation: null };
  const close = c.map((x) => x[4]), last = close[close.length - 1];
  const e20 = ema(close, 20), e50 = ema(close, 50), m12 = ema(close, 12), m26 = ema(close, 26);
  const macd = m12.map((v, i) => v - m26[i]), sigl = ema(macd, 9), hist = macd[macd.length - 1] - sigl[sigl.length - 1];
  const histPrev = macd[macd.length - 2] - sigl[sigl.length - 2];
  const R = rsi(close), A = atr(c), E20 = e20[e20.length - 1], E50 = e50[e50.length - 1];
  const win = c.slice(-48), sup = Math.min(...win.map((x) => x[3])), res = Math.max(...win.map((x) => x[2]));
  const vol = c.map((x) => x[5]), vNow = vol.slice(-24).reduce((s, x) => s + x, 0), vPrev = vol.slice(-48, -24).reduce((s, x) => s + x, 0);
  let score = 0; const reasons = [];
  if (last > E50) { score += 1; reasons.push('Price is above the 50 EMA (uptrend).'); } else { score -= 1; reasons.push('Price is below the 50 EMA (downtrend).'); }
  if (E20 > E50) { score += 1; reasons.push('20 EMA is above the 50 EMA.'); } else { score -= 1; reasons.push('20 EMA is below the 50 EMA.'); }
  if (hist > 0) { score += 1; reasons.push('MACD momentum is positive' + (hist > histPrev ? ' and rising.' : ' but fading.')); } else { score -= 1; reasons.push('MACD momentum is negative' + (hist < histPrev ? ' and falling.' : ' but improving.')); }
  if (R != null) {
    if (R >= 70) { score -= 1; reasons.push('RSI ' + R.toFixed(0) + ': overbought, pullbacks are likely.'); }
    else if (R <= 30) { score += 1; reasons.push('RSI ' + R.toFixed(0) + ': oversold, a bounce is possible.'); }
    else if (R >= 50) { score += 0.5; reasons.push('RSI ' + R.toFixed(0) + ': healthy momentum.'); }
    else { score -= 0.5; reasons.push('RSI ' + R.toFixed(0) + ': weak momentum.'); }
  }
  if (vPrev > 0) { const vr = vNow / vPrev; if (vr > 1.5) reasons.push('Volume is ' + vr.toFixed(1) + 'x higher than the period before, the move has participation.'); else if (vr < 0.6) reasons.push('Volume is falling, the move has little participation.'); }
  let conf = 35 + Math.abs(score) * 11;
  if (c.length < 100) conf -= 10;
  if (opts.liquidityUsd != null && opts.liquidityUsd < 50000) { conf -= 15; reasons.push('Low liquidity (under $50k): prices can move very fast and slippage is high.'); }
  conf = Math.max(5, Math.min(85, Math.round(conf)));
  const bias = score >= 2 ? 'bullish' : score <= -2 ? 'bearish' : 'neutral';
  const invalidation = bias === 'bullish' ? 'A close below ' + sig(Math.max(sup, E50 * 0.98)) + ' (support / 50 EMA) breaks this view.'
    : bias === 'bearish' ? 'A close above ' + sig(Math.min(res, E50 * 1.02)) + ' (resistance / 50 EMA) breaks this view.'
    : 'No clear direction: wait for a break of ' + sig(sup) + ' or ' + sig(res) + '.';
  return {
    bias, score: r(score, 1), confidence: conf, price: sig(last),
    change: r((last / close[Math.max(0, close.length - 25)] - 1) * 100),
    indicators: { rsi14: r(R, 1), ema20: sig(E20), ema50: sig(E50), macdHist: sig(hist), atrPct: A ? r(A / last * 100) : null },
    levels: { support: sig(sup), resistance: sig(res) },
    reasons, invalidation, candles: c.length, asOf: new Date(c[c.length - 1][0] * 1000).toISOString(),
  };
}

// One call for any asset: "ETH", "$DEGEN", "0x…", "EUR/USD".
export async function signalFor(query, tf = '1h') {
  const q = String(query || '').trim();
  const fx = q.toUpperCase().match(/^([A-Z]{3})\s*[\/-]?\s*([A-Z]{3})$/);
  if (fx && FX.includes(fx[1]) && FX.includes(fx[2])) {
    const s = analyze(await fxSeries(fx[1], fx[2]));
    return { asset: fx[1] + '/' + fx[2], kind: 'forex', timeframe: '1d', source: 'ECB reference rates (daily) via Frankfurter', ...s };
  }
  const sym = q.replace(/^\$/, '').toUpperCase();
  if (MAJORS.includes(sym)) {
    const s = analyze(await majorCandles(sym, tf));
    return { asset: sym, kind: 'major', timeframe: tf, source: 'Coinbase Exchange candles', ...s };
  }
  const t = /^0x[0-9a-fA-F]{40}$/.test(q) ? await tokenByAddress(q) : await tokenBySymbol(sym);
  if (!t) return { asset: q, kind: 'unknown', bias: 'no signal', reasons: ['No Base trading pair was found for this token.'] };
  const s = analyze(await poolCandles(t.pair, tf), { liquidityUsd: t.liquidityUsd });
  return { asset: t.symbol, kind: 'base-token', timeframe: tf, source: 'GeckoTerminal candles, DexScreener market data', token: t, ...s };
}

export async function signalBoard(list, tf = '1h') {
  const out = [];
  for (const a of list) { try { out.push(await cached('sb:' + a + tf, 300, () => signalFor(a, tf))); } catch (e) { out.push({ asset: a, bias: 'no signal', reasons: ['Data source is busy, try again in a minute.'] }); } }
  return out.map((s) => ({ asset: s.asset, kind: s.kind, bias: s.bias, score: s.score, confidence: s.confidence, price: s.price, change: s.change, rsi14: s.indicators && s.indicators.rsi14, support: s.levels && s.levels.support, resistance: s.levels && s.levels.resistance, reasons: (s.reasons || []).slice(0, 3), invalidation: s.invalidation, asOf: s.asOf, timeframe: s.timeframe }));
}

// Latest price of a major coin or forex pair (used to score old signals).
export async function lastPrice(asset) {
  const fx = String(asset).match(/^([A-Z]{3})\/([A-Z]{3})$/);
  if (fx) { const s = await fxSeries(fx[1], fx[2]); return s.length ? s[s.length - 1][4] : null; }
  const c = await majorCandles(asset, '1h'); return c.length ? c[c.length - 1][4] : null;
}
export function clearCache() { mem.clear(); } // tests only
