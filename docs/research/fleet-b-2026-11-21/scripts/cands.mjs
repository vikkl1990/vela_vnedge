// Emit the ranked non-live candidate cells (ids included) as JSON for the VM check and the frozen list.
import fs from 'node:fs';
const D = new URL('.', import.meta.url).pathname;
const all = JSON.parse(fs.readFileSync(D + 'trades120.json', 'utf8')).filter((t) => Number.isFinite(t.r) && (t.bt === 2 || t.bt === 0));
const L = JSON.parse(fs.readFileSync(D + 'live.json', 'utf8'));
const NOW = Math.max(...all.map((t) => t.at)), DAY = 864e5, SLOPE = 0.13;
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const base = new Map();
for (const t of all.filter((x) => x.bt === 2 && x.at >= NOW - 28 * DAY)) { const k = `${t.side}|${t.tf}`; (base.get(k) ?? base.set(k, []).get(k)).push(t.r); }
const m = new Map([...base].map(([k, v]) => [k, avg(v)]));
const win = all.filter((t) => t.at >= NOW - 28 * DAY).map((t) => ({ ...t, x: t.r - (m.get(`${t.side}|${t.tf}`) ?? 0) }));
const by = new Map();
for (const t of win) { const k = `${t.sc}|${t.sym}|${t.tf}`; (by.get(k) ?? by.set(k, []).get(k)).push(t); }
const live = new Set(L.live.map((p) => `${p.sc}|${p.sym}|${p.tf}`)), q = new Set(L.quarantined);
const out = [...by].filter(([k, v]) => !live.has(k) && !q.has(v[0].sc) && v.length >= 25)
  .map(([k, v]) => ({ scannerId: v[0].sc, name: L.names[v[0].sc] ?? v[0].sc, symbol: v[0].sym, tf: v[0].tf, n28: v.length, rawR: +avg(v.map((t) => t.r)).toFixed(3), excess: +avg(v.map((t) => t.x)).toFixed(3), expected: +(SLOPE * avg(v.map((t) => t.x))).toFixed(3), longShare: +(v.filter((t) => t.side === 'long').length / v.length).toFixed(2) }))
  .sort((a, b) => b.expected - a.expected).slice(0, 30);
console.log(JSON.stringify(out));
