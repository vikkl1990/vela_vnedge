// Does a scanner's (or cell's) record in one window predict the next? Walk-forward on shadow trades, 35 days, net R.
// Rank units on a training window, look at how the same units did in the NEXT window. Drift-neutral score where both sides exist.
import fs from 'node:fs';
const D = new URL('.', import.meta.url).pathname;
const all = JSON.parse(fs.readFileSync(D + (process.env.FILE || 'trades.json'), 'utf8')).filter((t) => t.bt === 2 && Number.isFinite(t.r));
const t0 = Math.min(...all.map((t) => t.at)), t1 = Math.max(...all.map((t) => t.at)), DAY = 864e5;
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const f = (x, d = 3) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(d) : '–');
const neutral = (rs) => { const L = rs.filter((r) => r.side === 'long'), S = rs.filter((r) => r.side === 'short'); return L.length && S.length ? (avg(L.map((r) => r.r)) + avg(S.map((r) => r.r))) / 2 : avg(rs.map((r) => r.r)); };
const units = { 'scanner': (t) => t.sc, 'scanner x tf': (t) => `${t.sc}|${t.tf}`, 'scanner x symbol x tf (cell)': (t) => `${t.sc}|${t.sym}|${t.tf}` };
const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); idx.forEach(([, i], k) => (r[i] = k)); return r; };
const spearman = (x, y) => { const rx = rank(x), ry = rank(y), n = x.length, mx = avg(rx), my = avg(ry); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) ** 2; syy += (ry[i] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
let seed = 11; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
function permP(x, y, B = 2000) { const obs = spearman(x, y); let c = 0; const yy = [...y]; for (let b = 0; b < B; b++) { for (let i = yy.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [yy[i], yy[j]] = [yy[j], yy[i]]; } if (spearman(x, yy) >= obs) c++; } return (c + 1) / (B + 1); }
// windows: train 14 days then test the next 7; slide by 7 days
const splits = [];
for (let s = t0; s + 21 * DAY <= t1 + 1; s += 7 * DAY) splits.push([s, s + 14 * DAY, s + 21 * DAY]);
console.log(`shadow trades ${all.length}, ${new Date(t0).toISOString().slice(0, 10)}..${new Date(t1).toISOString().slice(0, 10)}, ${splits.length} walk-forward splits (train 14d -> test next 7d)`);
for (const [name, key] of Object.entries(units)) {
  const minTrain = name.startsWith('scanner x symbol') ? 12 : 30, minTest = name.startsWith('scanner x symbol') ? 6 : 15;
  console.log(`\n=== ${name} (train n>=${minTrain}, test n>=${minTest}) ===`);
  const pooledTop = [], pooledAll = [], pooledBot = [];
  let rhos = [], ps = [];
  for (const [a, b, c] of splits) {
    const tr = new Map(), te = new Map();
    for (const t of all) { const k = key(t); if (t.at >= a && t.at < b) (tr.get(k) ?? tr.set(k, []).get(k)).push(t); else if (t.at >= b && t.at < c) (te.get(k) ?? te.set(k, []).get(k)).push(t); }
    const U = [...tr].filter(([k, v]) => v.length >= minTrain && (te.get(k)?.length ?? 0) >= minTest).map(([k, v]) => ({ k, train: neutral(v), test: neutral(te.get(k)), testRows: te.get(k) }));
    if (U.length < 12) { console.log(`  split ${new Date(a).toISOString().slice(5, 10)}: only ${U.length} units, skipped`); continue; }
    const x = U.map((u) => u.train), y = U.map((u) => u.test);
    const rho = spearman(x, y), p = permP(x, y, 1000);
    U.sort((p1, p2) => p2.train - p1.train);
    const q = Math.max(3, Math.floor(U.length / 5));
    const top = U.slice(0, q), bot = U.slice(-q);
    const testOf = (L) => avg(L.flatMap((u) => u.testRows.map((r) => r.r)));
    console.log(`  split ${new Date(a).toISOString().slice(5, 10)}: ${String(U.length).padStart(3)} units | rank corr train->test ${f(rho, 2)} (p=${p.toFixed(2)}) | top fifth: train ${f(avg(top.map((u) => u.train)))} -> test ${f(testOf(top))} | bottom fifth: train ${f(avg(bot.map((u) => u.train)))} -> test ${f(testOf(bot))} | all units test ${f(testOf(U))}`);
    rhos.push(rho); ps.push(p);
    pooledTop.push(...top.flatMap((u) => u.testRows.map((r) => r.r))); pooledBot.push(...bot.flatMap((u) => u.testRows.map((r) => r.r))); pooledAll.push(...U.flatMap((u) => u.testRows.map((r) => r.r)));
  }
  if (rhos.length) console.log(`  mean rank corr ${f(avg(rhos), 2)} over ${rhos.length} splits | pooled next-window R: top fifth ${f(avg(pooledTop))} (n${pooledTop.length}), bottom fifth ${f(avg(pooledBot))} (n${pooledBot.length}), all ${f(avg(pooledAll))}`);
}
