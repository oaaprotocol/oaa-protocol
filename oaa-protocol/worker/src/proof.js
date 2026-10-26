// OAA "Proof of Signal": every hour ZEN's signals are written down, committed with one hash on Base,
// and scored automatically once their time is up. Nobody (not even OAA) can change or delete a signal later.
//   Cron trigger:   Cloudflare → Worker → Settings → Triggers → Cron: "5 * * * *" (every hour)
//   KEEPER_KEY:     secret, private key of a NEW small wallet that only pays the gas of the hourly hash
//                   (a 0 ETH transaction to itself, about $0.001 on Base). Without it, signals are still
//                   logged and scored, but not anchored on Base.
// Storage: KV "MEDIA" (b:<batch>, pending, stats, recent)
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { signalBoard, lastPrice, MAJORS } from './market.js';

const HORIZON_H = { '1h': 24, '4h': 96, '1d': 168 };
const FX_LIST = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'EUR/GBP'];
const MAGIC = '51534947'; // "QSIG"
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => { h = h.replace(/^0x/, ''); if (h.length % 2) h = '0' + h; const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
const enc = (s) => new TextEncoder().encode(s);

// ---------- commitment (anyone can recompute this from the public batch JSON) ----------
export function commitOf(s) {
  // fixed key order: this exact string is hashed
  return JSON.stringify({ id: s.id, asset: s.asset, kind: s.kind, tf: s.tf, bias: s.bias, score: s.score, confidence: s.confidence, price: s.price, createdAt: s.createdAt, horizonH: s.horizonH });
}
export function leafOf(s) { return '0x' + hex(keccak_256(enc(commitOf(s)))); }
export function rootOf(signals) {
  const all = new Uint8Array(signals.length * 32);
  signals.forEach((s, i) => all.set(unhex(leafOf(s)), i * 32));
  return '0x' + hex(keccak_256(all));
}
export async function queueBrief(env, b) { const q = await kvGet(env, 'gq', []); q.push(b); await kvPut(env, 'gq', q.slice(-2000)); }
export function briefsRootOf(briefs) { const all = new Uint8Array(briefs.length * 32); briefs.forEach((b, i) => all.set(unhex(b.hash), i * 32)); return '0x' + hex(keccak_256(all)); }
export function combinedRoot(sigRoot, briefsRoot) { const a = new Uint8Array(64); a.set(unhex(sigRoot), 0); a.set(unhex(briefsRoot), 32); return '0x' + hex(keccak_256(a)); }
export function anchorData(batchId, root, count) {
  return '0x' + MAGIC + '01' + root.slice(2) + BigInt(batchId).toString(16).padStart(16, '0') + count.toString(16).padStart(4, '0');
}

// ---------- minimal EIP-1559 transaction signing for the keeper ----------
function rlp(x) {
  if (Array.isArray(x)) { const body = concat(x.map(rlp)); return concat([lenPrefix(body.length, 0xc0), body]); }
  const b = x instanceof Uint8Array ? x : x === 0n || x === 0 || x === '' ? new Uint8Array(0) : typeof x === 'bigint' || typeof x === 'number' ? unhex(BigInt(x).toString(16)) : unhex(x);
  if (b.length === 1 && b[0] < 0x80) return b;
  return concat([lenPrefix(b.length, 0x80), b]);
}
function lenPrefix(n, off) { if (n < 56) return new Uint8Array([off + n]); const l = unhex(n.toString(16)); return concat([new Uint8Array([off + 55 + l.length]), l]); }
function concat(arr) { const n = arr.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(n); let i = 0; for (const a of arr) { o.set(a, i); i += a.length; } return o; }
function addressOf(key) { const pub = secp.getPublicKey(unhex(key), false); return '0x' + hex(keccak_256(pub.slice(1))).slice(-40); }

async function rpc(env, method, params) {
  const r = await fetch(env.BASE_RPC || 'https://mainnet.base.org', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message || 'rpc'); return j.result;
}
export async function anchor(env, data) {
  const key = String(env.KEEPER_KEY || '').replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(key)) return null;
  const from = addressOf(key);
  const [chainId, nonce, block, tip] = await Promise.all([rpc(env, 'eth_chainId', []), rpc(env, 'eth_getTransactionCount', [from, 'pending']), rpc(env, 'eth_getBlockByNumber', ['latest', false]), rpc(env, 'eth_maxPriorityFeePerGas', []).catch(() => '0x186a0')]);
  const prio = BigInt(tip), base = BigInt(block.baseFeePerGas || '0x0'), max = base * 2n + prio;
  const fields = [BigInt(chainId), BigInt(nonce), prio, max, 60000n, from, 0n, unhex(data), []];
  const msg = concat([new Uint8Array([2]), rlp(fields)]);
  const sig = await secp.signAsync(keccak_256(msg), unhex(key));
  const raw = '0x02' + hex(rlp([...fields, BigInt(sig.recovery), sig.r, sig.s]));
  const hash = await rpc(env, 'eth_sendRawTransaction', [raw]);
  return { hash, from };
}

// ---------- hourly job ----------
const kvGet = async (env, k, d) => { const v = await env.MEDIA.get(k); if (!v) return d; try { return JSON.parse(v); } catch { return d; } };
const kvPut = (env, k, v) => env.MEDIA.put(k, JSON.stringify(v));

export async function hourly(env, now = Date.now()) {
  if (!env.MEDIA) return { error: 'kv_off' };
  const batchId = Math.floor(now / 3600000);
  if (await env.MEDIA.get('b:' + batchId)) return { skipped: 'exists', batchId };
  const hour = new Date(batchId * 3600000).getUTCHours();
  const createdAt = new Date(now).toISOString();
  const jobs = [['1h', MAJORS.slice(0, 8)]];
  if (hour % 4 === 0) jobs.push(['4h', MAJORS.slice(0, 8)]);
  if (hour === 0) jobs.push(['1d', MAJORS.slice(0, 8)]);
  const signals = [];
  for (const [tf, list] of jobs) {
    const board = await signalBoard(list, tf).catch(() => []);
    for (const s of board) {
      if (!s || s.price == null || !['bullish', 'bearish', 'neutral'].includes(s.bias)) continue;
      signals.push({ id: batchId + '-' + signals.length, asset: s.asset, kind: s.kind === 'forex' ? 'forex' : 'major', tf, bias: s.bias, score: s.score, confidence: s.confidence, price: s.price, createdAt, horizonH: HORIZON_H[tf] });
    }
  }
  const briefs = (await kvGet(env, 'gq', [])).slice(0, 2000); if (briefs.length) await kvPut(env, 'gq', []);
  const out = { batchId, count: signals.length, briefs: briefs.length };
  if (signals.length) {
    const sigRoot = rootOf(signals); const briefsRoot = briefs.length ? briefsRootOf(briefs) : null; const root = briefsRoot ? combinedRoot(sigRoot, briefsRoot) : sigRoot;
    let tx = null; try { tx = await anchor(env, anchorData(batchId, root, signals.length)); } catch (e) { out.anchorError = String(e.message || e).slice(0, 200); }
    await kvPut(env, 'b:' + batchId, { id: batchId, createdAt, root, sigRoot, briefsRoot, briefs, tx: tx ? tx.hash : null, keeper: tx ? tx.from : null, signals, results: {} });
    const pending = await kvGet(env, 'pending', []); pending.push(batchId); await kvPut(env, 'pending', pending.slice(-400));
    Object.assign(out, { root, tx: tx && tx.hash });
  }
  out.scored = await score(env, now);
  return out;
}

async function score(env, now) {
  const pending = await kvGet(env, 'pending', []);
  if (!pending.length) return 0;
  const stats = await kvGet(env, 'stats', { since: null, by: {} });
  let recent = await kvGet(env, 'recent', []);
  const prices = {}; let n = 0; const still = [];
  for (const id of pending) {
    const b = await kvGet(env, 'b:' + id, null); if (!b) continue;
    let changed = false, open = false;
    for (const s of b.signals) {
      if (b.results[s.id]) continue;
      if (Date.parse(s.createdAt) + s.horizonH * 3600000 > now) { open = true; continue; }
      if (!(s.asset in prices)) prices[s.asset] = await lastPrice(s.asset).catch(() => null);
      const end = prices[s.asset]; if (end == null) { open = true; continue; }
      const chg = (end / s.price - 1) * 100;
      const hit = s.bias === 'neutral' ? null : s.bias === 'bullish' ? chg > 0 : chg < 0;
      const ret = s.bias === 'neutral' ? 0 : s.bias === 'bullish' ? chg : -chg;
      b.results[s.id] = { end, change: Math.round(chg * 100) / 100, hit, ret: Math.round(ret * 100) / 100, scoredAt: new Date(now).toISOString() };
      changed = true; n++;
      if (hit !== null) {
        const k = s.asset + '|' + s.tf; const x = stats.by[k] || (stats.by[k] = { n: 0, hits: 0, ret: 0 });
        x.n++; if (hit) x.hits++; x.ret = Math.round((x.ret + ret) * 100) / 100;
        if (!stats.since || s.createdAt < stats.since) stats.since = s.createdAt;
      }
      recent.unshift({ id: s.id, batch: b.id, asset: s.asset, tf: s.tf, bias: s.bias, confidence: s.confidence, price: s.price, end, change: b.results[s.id].change, hit, createdAt: s.createdAt, tx: b.tx });
    }
    if (changed) await kvPut(env, 'b:' + id, b);
    if (open) still.push(id);
  }
  if (n) { recent = recent.slice(0, 60); await kvPut(env, 'stats', stats); await kvPut(env, 'recent', recent); }
  if (still.length !== pending.length) await kvPut(env, 'pending', still);
  return n;
}

// ---------- read side ----------
export async function record(env) {
  if (!env.MEDIA) return { error: 'kv_off' };
  const [stats, recent, pending] = await Promise.all([kvGet(env, 'stats', { since: null, by: {} }), kvGet(env, 'recent', []), kvGet(env, 'pending', [])]);
  const tot = { n: 0, hits: 0, ret: 0 }, byTf = {}, byAsset = {};
  for (const [k, x] of Object.entries(stats.by)) {
    const [asset, tf] = k.split('|');
    tot.n += x.n; tot.hits += x.hits; tot.ret += x.ret;
    const t = byTf[tf] || (byTf[tf] = { n: 0, hits: 0, ret: 0 }); t.n += x.n; t.hits += x.hits; t.ret += x.ret;
    const a = byAsset[asset] || (byAsset[asset] = { asset, n: 0, hits: 0, ret: 0 }); a.n += x.n; a.hits += x.hits; a.ret += x.ret;
  }
  const rate = (x) => x.n ? Math.round(x.hits / x.n * 1000) / 10 : null;
  const avg = (x) => x.n ? Math.round(x.ret / x.n * 100) / 100 : null;
  const last = pending.length ? await kvGet(env, 'b:' + pending[pending.length - 1], null) : null;
  return {
    since: stats.since, total: { n: tot.n, hits: tot.hits, hitRate: rate(tot), avgReturn: avg(tot) },
    byTimeframe: Object.fromEntries(Object.entries(byTf).map(([k, x]) => [k, { n: x.n, hitRate: rate(x), avgReturn: avg(x) }])),
    byAsset: Object.values(byAsset).map((x) => ({ asset: x.asset, n: x.n, hitRate: rate(x), avgReturn: avg(x) })).sort((a, b) => b.n - a.n),
    recent: recent.slice(0, 30), openBatches: pending.length,
    lastBatch: last ? { id: last.id, createdAt: last.createdAt, count: last.signals.length, root: last.root, tx: last.tx } : null,
    anchored: !!(last && last.tx), rule: 'A bullish signal counts as a hit if the price is higher when its time is up (1h: 24 hours, 4h: 4 days, 1d: 7 days); bearish if lower. Neutral signals are logged but not scored.',
  };
}
export async function batch(env, id) {
  if (!env.MEDIA || !/^\d{1,10}$/.test(String(id))) return null;
  const b = await kvGet(env, 'b:' + id, null); if (!b) return null;
  return { id: b.id, createdAt: b.createdAt, root: b.root, sigRoot: b.sigRoot || b.root, briefsRoot: b.briefsRoot || null, briefs: b.briefs || [], tx: b.tx, keeper: b.keeper, count: b.signals.length, signals: b.signals.map((s) => ({ ...s, leaf: leafOf(s), result: b.results[s.id] || null })),
    howToVerify: 'For each signal, hash the JSON string of {id, asset, kind, tf, bias, score, confidence, price, createdAt, horizonH} (in this order) with keccak256. Concatenate the hashes in order and hash again: that is the root. The anchor transaction input is 0x51534947 01 <root> <batch id, 8 bytes> <count, 2 bytes>.' };
}
