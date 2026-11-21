// Re-rank the fleet. Score = EXCESS R: a trade's net R minus the average of same-side, same-timeframe shadow trades in the same
// window, so a long-only scanner is not rewarded or punished for the market's drift. Persistence of that score is measured
// walk-forward first, and the shrink it implies is applied before anything is ranked.
import fs from 'node:fs';
const D = new URL('.', import.meta.url).pathname;
const all = JSON.parse(fs.readFileSync(D + 'trades120.json', 'utf8')).filter((t) => Number.isFinite(t.r) && (t.bt === 2 || t.bt === 0));
const L = JSON.parse(fs.readFileSync(D + 'live.json', 'utf8'));
const NOW = Math.max(...all.map((t) => t.at)), DAY = 864e5;
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const f = (x, d = 3) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(d) : '–');
const cellKey = (t) => `${t.sc}|${t.sym}|${t.tf}`;
function withExcess(rows) {
  const base = new Map();
  for (const t of rows.filter((x) => x.bt === 2)) { const k = `${t.side}|${t.tf}`; (base.get(k) ?? base.set(k, []).get(k)).push(t.r); }
  const m = new Map([...base].map(([k, v]) => [k, avg(v)]));
  return rows.map((t) => ({ ...t, x: t.r - (m.get(`${t.side}|${t.tf}`) ?? 0) }));
}
// ---------- 1. persistence of the excess score, walk-forward ----------
const t0 = Math.min(...all.map((t) => t.at));
const pairs = [];
for (let s = t0; s + 21 * DAY <= NOW + 1; s += 7 * DAY) {
  const tr = withExcess(all.filter((t) => t.at >= s && t.at < s + 14 * DAY)), te = withExcess(all.filter((t) => t.at >= s + 14 * DAY && t.at < s + 21 * DAY));
  const a = new Map(), b = new Map();
  for (const t of tr) (a.get(cellKey(t)) ?? a.set(cellKey(t), []).get(cellKey(t))).push(t.x);
  for (const t of te) (b.get(cellKey(t)) ?? b.set(cellKey(t), []).get(cellKey(t))).push(t.x);
  for (const [k, v] of a) if (v.length >= 15 && (b.get(k)?.length ?? 0) >= 6) pairs.push({ train: avg(v), test: avg(b.get(k)), w: Math.min(v.length, b.get(k).length) });
}
let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
for (const p of pairs) { sw += p.w; sx += p.w * p.train; sy += p.w * p.test; sxx += p.w * p.train * p.train; sxy += p.w * p.train * p.test; }
const slope = (sxy - (sx * sy) / sw) / (sxx - (sx * sx) / sw);
console.log(`persistence of excess R across ${pairs.length} (cell, window) pairs: next-window excess = ${f(slope, 2)} x this-window excess  (1.00 would be a pure skill; 0 pure luck)`);
const B = Math.max(0, Math.min(0.5, slope));
// ---------- 2. rank on the last 28 days ----------
const win = withExcess(all.filter((t) => t.at >= NOW - 28 * DAY));
const byCell = new Map();
for (const t of win) (byCell.get(cellKey(t)) ?? byCell.set(cellKey(t), []).get(cellKey(t))).push(t);
const quarantined = new Set(L.quarantined);
const liveKeys = new Set(L.live.map((p) => `${p.sc}|${p.sym}|${p.tf}`));
const nm = (id) => (L.names[id] ?? id).slice(0, 30);
function se(rows, key) {
  const m = avg(rows.map((r) => r[key])), d = new Map();
  for (const r of rows) d.set(Math.floor(r.at / DAY), (d.get(Math.floor(r.at / DAY)) ?? 0) + r[key] - m);
  let s = 0; for (const v of d.values()) s += v * v;
  return d.size >= 2 ? Math.sqrt(s) / rows.length : NaN;
}
const row = (k, v) => ({ k, sc: v[0].sc, sym: v[0].sym, tf: v[0].tf, n: v.length, r: avg(v.map((t) => t.r)), x: avg(v.map((t) => t.x)), se: se(v, 'x'), exp: B * avg(v.map((t) => t.x)), acct: v.filter((t) => t.bt === 0).length, longs: v.filter((t) => t.side === 'long').length / v.length });
console.log(`\nshrink applied to a past excess score: x${f(B, 2)}\n`);
console.log('=== THE 33 LIVE CELLS, last 28 days (account trades; excess = net R minus same-side same-timeframe shadow average) ===');
console.log('scanner'.padEnd(31) + 'market'.padEnd(11) + 'tf   n    rawR   excess  ±se   expected next');
const liveRows = L.live.map((p) => { const k = `${p.sc}|${p.sym}|${p.tf}`; const v = byCell.get(k); return v ? row(k, v) : { k, sc: p.sc, sym: p.sym, tf: p.tf, n: 0 }; }).sort((a, b) => (b.exp ?? -9) - (a.exp ?? -9));
for (const r of liveRows) console.log(nm(r.sc).padEnd(31) + r.sym.padEnd(11) + r.tf.padEnd(4) + String(r.n).padStart(3) + (r.n ? `  ${f(r.r)}  ${f(r.x)}  ${f(r.se, 2)}  ${f(r.exp)}` : '   no trades in 28d'));
const ev = liveRows.filter((r) => r.n >= 10);
console.log(`live cells with >=10 trades: ${ev.length} of ${liveRows.length}; n-weighted raw R ${f(avg(ev.flatMap((r) => Array(r.n).fill(r.r))))}, expected next excess ${f(avg(ev.flatMap((r) => Array(r.n).fill(r.exp))))}`);
console.log('\n=== BEST NON-LIVE CELLS by expected next-week excess (n>=25 in 28d, scanner not quarantined) ===');
console.log('scanner'.padEnd(31) + 'market'.padEnd(11) + 'tf   n    rawR   excess  ±se   expected next  long%');
const cand = [...byCell].filter(([k, v]) => !liveKeys.has(k) && !quarantined.has(v[0].sc) && v.length >= 25).map(([k, v]) => row(k, v)).sort((a, b) => b.exp - a.exp);
for (const r of cand.slice(0, 18)) console.log(nm(r.sc).padEnd(31) + r.sym.padEnd(11) + r.tf.padEnd(4) + String(r.n).padStart(3) + `  ${f(r.r)}  ${f(r.x)}  ${f(r.se, 2)}  ${f(r.exp)}      ${(r.longs * 100).toFixed(0)}%`);
const top = cand.slice(0, 20);
console.log(`\ntop 20 candidates: n ${top.reduce((s, r) => s + r.n, 0)}, n-weighted raw R ${f(avg(top.flatMap((r) => Array(r.n).fill(r.r))))}, expected next excess ${f(avg(top.flatMap((r) => Array(r.n).fill(r.exp))))}; scanners ${new Set(top.map((r) => r.sc)).size}, markets ${new Set(top.map((r) => r.sym)).size}, long share ${f(avg(top.map((r) => r.longs)) * 100, 0)}%`);
const bySc = new Map(); for (const r of top) bySc.set(nm(r.sc), (bySc.get(nm(r.sc)) ?? 0) + 1);
console.log('candidate cells per scanner: ' + [...bySc].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${v}`).join(' | '));
console.log(`eligible non-live cells with n>=25: ${cand.length}; of them, expected excess > 0: ${cand.filter((r) => r.exp > 0).length}; raw R > 0 in the last 28 days: ${cand.filter((r) => r.r > 0).length}`);
