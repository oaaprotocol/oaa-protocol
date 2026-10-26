// OAA Rug Check: fast, explainable risk check for any token on Base.
// Sources: Base RPC (bytecode, owner, proxy slots, supply), Blockscout (verified source, top holders), DexScreener (liquidity, age, trades).
// It is a heuristic, not an audit. Every point is shown with its reason.
import { keccak_256 } from '@noble/hashes/sha3';
import { tokenByAddress, cached } from './market.js';

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const sel = (sig) => hex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8);
const ZERO = '0x0000000000000000000000000000000000000000', DEAD = '0x000000000000000000000000000000000000dead';
const RISKY = {
  mint: ['mint(address,uint256)', 'mint(uint256)', 'mintTo(address,uint256)', '_mint(address,uint256)'],
  blacklist: ['blacklist(address)', 'addToBlacklist(address)', 'setBlacklist(address,bool)', 'blacklistAddress(address,bool)', 'setBots(address[],bool)', 'addBots(address[])', 'setBot(address,bool)', 'setIsBlacklisted(address,bool)'],
  fees: ['setFee(uint256)', 'setFees(uint256,uint256)', 'setTaxFee(uint256)', 'setBuyFee(uint256)', 'setSellFee(uint256)', 'updateFees(uint256,uint256)', 'setTax(uint256)', 'setTaxes(uint256,uint256)', 'updateBuyFees(uint256,uint256,uint256)', 'updateSellFees(uint256,uint256,uint256)', 'setSwapFees(uint256,uint256)'],
  limits: ['setMaxTxAmount(uint256)', 'setMaxWalletSize(uint256)', 'setMaxTx(uint256)', 'setMaxWallet(uint256)', 'updateMaxTxnAmount(uint256)', 'updateMaxWalletAmount(uint256)'],
  pause: ['pause()', 'setTradingEnabled(bool)', 'enableTrading()', 'openTrading()', 'setTrading(bool)'],
};
const SELS = Object.fromEntries(Object.entries(RISKY).map(([k, list]) => [k, list.map(sel)]));
const SLOT_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const SLOT_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

async function rpc(env, method, params) {
  const r = await fetch(env.BASE_RPC || 'https://mainnet.base.org', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message || 'rpc'); return j.result;
}
const call = (env, to, data) => rpc(env, 'eth_call', [{ to, data }, 'latest']);
async function scout(path) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9000);
  try { const r = await fetch('https://base.blockscout.com/api/v2' + path, { headers: { Accept: 'application/json' }, signal: ctl.signal }); if (!r.ok) throw new Error('http ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
const addr = (w) => '0x' + String(w).slice(-40).toLowerCase();
const big = (w) => BigInt(w && w !== '0x' ? w : '0x0');
function str(r) { try { const d = r.slice(2), off = parseInt(d.slice(0, 64), 16) * 2, len = parseInt(d.slice(off, off + 64), 16); const b = new Uint8Array(len); for (let i = 0; i < len; i++) b[i] = parseInt(d.substr(off + 64 + i * 2, 2), 16); return new TextDecoder().decode(b); } catch { return ''; } }

export async function rugCheck(env, token, opts = {}) {
  const a = String(token).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return { error: 'bad_address' };
  return cached('rug:' + a, 600, () => run(env, a, opts));
}

async function run(env, a, opts) {
  const code = await rpc(env, 'eth_getCode', [a, 'latest']);
  if (!code || code === '0x') return { address: a, error: 'not_a_contract' };
  const [nm, sy, dec, sup, own, impl, beacon, market, verified, holders] = await Promise.all([
    call(env, a, '0x06fdde03').catch(() => null), call(env, a, '0x95d89b41').catch(() => null), call(env, a, '0x313ce567').catch(() => null), call(env, a, '0x18160ddd').catch(() => null),
    call(env, a, '0x8da5cb5b').catch(() => null),
    rpc(env, 'eth_getStorageAt', [a, SLOT_IMPL, 'latest']).catch(() => null), rpc(env, 'eth_getStorageAt', [a, SLOT_BEACON, 'latest']).catch(() => null),
    tokenByAddress(a).catch(() => null),
    scout('/smart-contracts/' + a).then((j) => !!(j && j.is_verified)).catch(() => null),
    scout('/tokens/' + a + '/holders').then((j) => (j.items || []).map((x) => ({ address: ((x.address_hash || x.address || {}).hash || '').toLowerCase(), isContract: !!(x.address_hash || x.address || {}).is_contract, value: x.value }))).catch(() => null),
  ]);
  if (!sy || sy === '0x' || !dec || dec === '0x') return { address: a, error: 'not_a_token' };
  const decimals = Number(big(dec)), supply = Number(big(sup)) / 10 ** decimals;
  const body = code.slice(2).toLowerCase();
  const has = (k) => SELS[k].some((s) => body.includes('63' + s));
  const checks = []; let score = 100;
  const add = (id, label, status, detail, pts) => { checks.push({ id, label, status, detail }); score -= pts || 0; };
  let ql = null;
  if (env.LAUNCHPAD) { try { const l = (await call(env, env.LAUNCHPAD, '0x' + sel('getLaunch(address)') + a.slice(2).padStart(64, '0'))).slice(2); if (big('0x' + l.slice(64, 128)) !== 0n) ql = { pool: addr(l.slice(64, 128)) }; } catch {} }

  if (ql) add('oaa', 'Launched on OAA', 'ok', 'Fixed supply, no owner, no tax. Liquidity is locked forever in the OAA launchpad and the creator’s first buy is locked for 30 months.', 0);
  // source
  if (verified === true) add('verified', 'Source code verified', 'ok', 'The contract source is public on the block explorer.');
  else if (verified === false) add('verified', 'Source code not verified', 'bad', 'Nobody can read what this contract really does.', 20);
  else add('verified', 'Source code', 'info', 'Could not check the block explorer right now.');
  // proxy
  const minimal = body.startsWith('363d3d373d3d3d363d73');
  const isProxy = minimal || (impl && big(impl) !== 0n) || (beacon && big(beacon) !== 0n);
  if (isProxy) add('proxy', 'Upgradeable contract', minimal ? 'warn' : 'bad', minimal ? 'Minimal proxy: the logic lives in another contract.' : 'The logic can be swapped at any time by whoever controls the upgrade.', minimal ? 10 : 25);
  else add('proxy', 'Not upgradeable', 'ok', 'The code cannot be replaced.');
  // owner
  let owner = null;
  if (own && own.length >= 66) owner = addr(own);
  const renounced = !owner || owner === ZERO || owner === DEAD;
  if (renounced) add('owner', owner ? 'Ownership renounced' : 'No owner', 'ok', 'No single wallet controls special functions.');
  else add('owner', 'Has an owner', 'warn', 'Owner ' + owner.slice(0, 6) + '…' + owner.slice(-4) + ' can use admin functions.', 10);
  // dangerous functions (only matter while someone controls them)
  const live = !renounced || isProxy;
  const f = (k, label, detail, pts) => { if (has(k)) add(k, label, live ? 'bad' : 'warn', detail + (live ? '' : ' Ownership is renounced, so it is probably locked.'), live ? pts : Math.round(pts / 4)); };
  f('mint', 'Can mint new tokens', 'New supply can dilute holders.', 25);
  f('blacklist', 'Can block wallets', 'Specific wallets can be stopped from selling.', 20);
  f('fees', 'Can change taxes', 'Buy/sell taxes can be raised later.', 15);
  f('pause', 'Can pause or gate trading', 'Trading can be switched off.', 15);
  f('limits', 'Can change max wallet / max tx', 'Limits can be used to block sells.', 8);
  if (!['mint', 'blacklist', 'fees', 'pause', 'limits'].some(has)) add('functions', 'No risky admin functions found', 'ok', 'No mint, blacklist, tax, pause or limit functions in the bytecode.');
  // holders
  if (holders && holders.length && supply > 0) {
    const skip = new Set([ZERO, DEAD, a, (market && market.pair || '').toLowerCase(), String(env.LAUNCHPAD || '').toLowerCase()]);
    const top = holders.filter((h) => !skip.has(h.address)).slice(0, 10);
    const pct = top.reduce((s, h) => s + Number(BigInt(h.value || '0')) / 10 ** decimals, 0) / supply * 100;
    const one = top.length ? Number(BigInt(top[0].value || '0')) / 10 ** decimals / supply * 100 : 0;
    const st = pct > 60 || one > 25 ? 'bad' : pct > 35 || one > 10 ? 'warn' : 'ok';
    add('holders', 'Top 10 holders own ' + pct.toFixed(1) + '%', st, 'Largest single holder: ' + one.toFixed(1) + '% (pool, burn address and launchpad excluded).', st === 'bad' ? 20 : st === 'warn' ? 8 : 0);
  } else add('holders', 'Holder distribution', 'info', 'Could not load the holder list right now.');
  // market
  if (market) {
    const liq = market.liquidityUsd || 0;
    add('liquidity', 'Liquidity ' + (liq >= 1e6 ? '$' + (liq / 1e6).toFixed(2) + 'M' : '$' + Math.round(liq).toLocaleString('en-US')), liq < 10000 ? 'bad' : liq < 50000 ? 'warn' : 'ok', liq < 10000 ? 'Very thin: small sells move the price a lot.' : liq < 50000 ? 'Thin liquidity, expect slippage.' : 'Enough liquidity for normal trades.', liq < 10000 ? 15 : liq < 50000 ? 5 : 0);
    if (!ql) add('lock', 'Liquidity lock', 'info', 'Cannot be verified here for tokens outside the OAA launchpad. Check the LP lock yourself.');
    const tx = market.txns24h;
    if (tx && tx.buys >= 30 && tx.sells === 0) add('honeypot', 'Nobody sold in 24h', 'bad', tx.buys + ' buys and 0 sells: selling may be blocked (honeypot).', 40);
    else if (tx && tx.buys + tx.sells > 0) add('honeypot', 'Buys and sells both happen', 'ok', tx.buys + ' buys and ' + tx.sells + ' sells in 24h.');
    const ageD = market.createdAt ? (Date.now() - Date.parse(market.createdAt)) / 864e5 : null;
    if (ageD != null && ageD < 2) add('age', 'Very new', 'warn', 'The pool is less than 2 days old.', 10);
    else if (ageD != null) add('age', 'Pool age ' + Math.floor(ageD) + ' days', 'ok', 'Trading since ' + market.createdAt + '.');
  } else add('liquidity', 'No market found', 'bad', 'No trading pair on Base was found.', 20);

  if (ql) score = Math.max(score, 80);
  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : score >= 30 ? 'D' : 'F';
  const risk = score >= 85 ? 'low' : score >= 70 ? 'medium' : score >= 50 ? 'high' : 'very high';
  return { address: a, name: str(nm), symbol: str(sy), decimals, totalSupply: supply, owner: renounced ? null : owner, upgradeable: !!isProxy, verified, score, grade, risk, launchedOnOAA: !!ql,
    market: market ? { priceUsd: market.priceUsd, liquidityUsd: market.liquidityUsd, marketCapUsd: market.marketCapUsd, volume24hUsd: market.volume24hUsd, txns24h: market.txns24h, pair: market.pair, url: market.url } : null,
    checks, checkedAt: new Date().toISOString(), note: 'Automatic heuristic, not an audit. Always do your own research.' };
}
