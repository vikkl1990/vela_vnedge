/**
 * Exit lab: replay candidate exit rules on the raw 1m price path after every entry.
 *
 *   IN=recon.json npm run exitlab -- [HORIZON_HOURS]
 *
 * IN is the output of `npm run reconstruct` (its entries only are used). For each entry the 1m path
 * is followed from the fill until the original stop or the horizon, independent of how the trade
 * actually ended, so every rule is judged on what the market offered rather than on a path already
 * cut short by the current exit. Script exits and reversals are not modelled: this compares price
 * rules on equal terms.
 *
 * Within a minute the stop is assumed to trade before any target (the conservative order), and a
 * stop raised from a minute's high only applies from the next minute, as in the live engine. Costs are
 * charged in R per trade: two taker fills with GST plus slippage, over the trade's own stop distance.
 *
 * A rule is chosen on the first half of the entries by time and reported on the second half, and on
 * eight consecutive windows, because with a dozen rules the best one on all the data is partly luck.
 */
import fs from 'node:fs';
import { DeltaRest } from '../delta/rest.ts';
import { ConfigStore } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';

const [hoursArg = '24'] = process.argv.slice(2);
const HORIZON = Number(hoursArg) * 3600_000;
const WINDOWS = 8;
const cfg = new ConfigStore().get().paper;
const rest = new DeltaRest();
const entries: any[] = JSON.parse(fs.readFileSync(process.env.IN!, 'utf8'));

/** One minute of the path in R: high/low are the favourable/adverse extremes. */
type Min = { hi: number; lo: number; close: number };
type Rule = { name: string; run: (path: Min[]) => number };

/**
 * Generic engine behind every rule: fixed stop at −1R, an optional take-profit, a stop that
 * ratchets up with the peak (`lock(peak)` returns the R to protect, or −1), and an optional time
 * stop (after `staleMin` minutes, leave at market unless the peak reached `staleR`).
 */
function engine(o: { tp?: number; lock?: (peak: number) => number; staleMin?: number; staleR?: number; partial?: { at: number; share: number } }) {
  return (path: Min[]) => {
    let stop = -1, peak = 0, banked = 0, left = 1;
    for (let i = 0; i < path.length; i++) {
      const m = path[i];
      if (m.lo <= stop) return banked + left * stop;
      if (o.partial && left === 1 && m.hi >= o.partial.at) { banked += o.partial.share * o.partial.at; left -= o.partial.share; }
      if (o.tp && m.hi >= o.tp) return banked + left * o.tp;
      // raise the stop last: like the live engine, a stop raised from this minute's high only
      // applies from the next minute, since the order of high and low inside a minute is unknown
      peak = Math.max(peak, m.hi);
      if (o.lock) stop = Math.max(stop, o.lock(peak));
      if (o.staleMin && i + 1 >= o.staleMin && peak < (o.staleR ?? 0)) return banked + left * m.close;
    }
    return banked + left * (path.at(-1)?.close ?? 0);   // horizon reached: leave at market
  };
}
const trail = (armAt: number, keep: number) => (pk: number) => (pk >= armAt ? pk * keep : -1);

const rules: Rule[] = [
  { name: 'LIVE: keep 75% from 1R, TP 6R', run: engine({ tp: 6, lock: trail(1, 0.75) }) },
  { name: 'hold: stop or 6R only', run: engine({ tp: 6 }) },
  { name: 'TP 0.75R', run: engine({ tp: 0.75 }) },
  { name: 'TP 1R', run: engine({ tp: 1 }) },
  { name: 'TP 1.5R', run: engine({ tp: 1.5 }) },
  { name: 'TP 2R', run: engine({ tp: 2 }) },
  { name: 'break-even at 0.5R, then live', run: engine({ tp: 6, lock: pk => (pk >= 1 ? pk * 0.75 : pk >= 0.5 ? 0 : -1) }) },
  { name: 'break-even at 0.75R, then live', run: engine({ tp: 6, lock: pk => (pk >= 1 ? pk * 0.75 : pk >= 0.75 ? 0 : -1) }) },
  { name: 'lock 0.3R at 0.75R, then live', run: engine({ tp: 6, lock: pk => (pk >= 1 ? pk * 0.75 : pk >= 0.75 ? 0.3 : -1) }) },
  { name: 'half off at 1R, rest keep 75%', run: engine({ tp: 6, partial: { at: 1, share: 0.5 }, lock: trail(1, 0.75) }) },
  { name: 'half off at 1R, rest BE, TP 3R', run: engine({ tp: 3, partial: { at: 1, share: 0.5 }, lock: pk => (pk >= 1 ? 0 : -1) }) },
  { name: 'keep 50% from 1R', run: engine({ tp: 6, lock: trail(1, 0.5) }) },
  { name: 'keep 60% from 1.5R', run: engine({ tp: 6, lock: trail(1.5, 0.6) }) },
  { name: 'NEW: keep 60% from 1.5R', run: engine({ tp: 6, lock: trail(1.5, 0.6) }) },
  { name: 'NEW + break-even at 1R', run: engine({ tp: 6, lock: pk => (pk >= 1.5 ? pk * 0.6 : pk >= 1 ? 0 : -1) }) },
  { name: 'NEW + lock 0.25R at 1R', run: engine({ tp: 6, lock: pk => (pk >= 1.5 ? pk * 0.6 : pk >= 1 ? 0.25 : -1) }) },
  { name: 'NEW + lock 0.5R at 1R', run: engine({ tp: 6, lock: pk => (pk >= 1.5 ? pk * 0.6 : pk >= 1 ? 0.5 : -1) }) },
  { name: 'live + time stop 60m under 0.5R', run: engine({ tp: 6, lock: trail(1, 0.75), staleMin: 60, staleR: 0.5 }) },
  { name: 'live + time stop 120m under 0.5R', run: engine({ tp: 6, lock: trail(1, 0.75), staleMin: 120, staleR: 0.5 }) },
  { name: 'live + time stop 240m under 1R', run: engine({ tp: 6, lock: trail(1, 0.75), staleMin: 240, staleR: 1 }) },
];

// ---- 1m paths ----
const toBars = (c: any[]): Bar[] => c.map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
const bySymbol = new Map<string, Bar[]>();
for (const s of new Set(entries.map(e => e.symbol))) {
  const es = entries.filter(e => e.symbol === s);
  bySymbol.set(s, toBars(await rest.candles(s, '1m', Math.floor(Math.min(...es.map(e => e.fillAt)) / 1000) - 60, Math.floor((Math.max(...es.map(e => e.fillAt)) + HORIZON) / 1000), 120_000)));
}
const feeR = (e: any) => {
  const riskPct = Math.abs(e.entry - e.sl) / e.entry * 100;
  const costPct = 2 * cfg.feeRatePct * (1 + (cfg.feeTaxPct ?? 0) / 100) + 2 * cfg.slippageBps / 100;
  return costPct / riskPct;
};
const cases = entries.map(e => {
  const dir = e.side === 'long' ? 1 : -1, risk = Math.abs(e.entry - e.sl);
  const r = (x: number) => (x - e.entry) * dir / risk;
  const bars = bySymbol.get(e.symbol)!.filter(b => b.time >= e.fillAt && b.time < e.fillAt + HORIZON);
  const path: Min[] = bars.map(b => ({ hi: r(dir === 1 ? b.high : b.low), lo: r(dir === 1 ? b.low : b.high), close: r(b.close) }));
  return { e, path, cost: feeR(e) };
}).filter(c => c.path.length > 30).sort((a, b) => a.e.fillAt - b.e.fillAt);

const t0 = cases[0].e.fillAt, t1 = cases.at(-1)!.e.fillAt, span = (t1 - t0) / WINDOWS || 1;
const half = cases[Math.floor(cases.length / 2)].e.fillAt;
type Score = { name: string; n: number; total: number; train: number; test: number; win: number; w: number[]; pf: number };
const scores: Score[] = rules.map(rule => {
  const s: Score = { name: rule.name, n: 0, total: 0, train: 0, test: 0, win: 0, w: new Array(WINDOWS).fill(0), pf: 0 };
  let gp = 0, gl = 0;
  for (const c of cases) {
    const r = rule.run(c.path) - c.cost;
    s.n++; s.total += r; if (r > 0) { s.win++; gp += r; } else gl -= r;
    if (c.e.fillAt < half) s.train += r; else s.test += r;
    s.w[Math.min(WINDOWS - 1, Math.floor((c.e.fillAt - t0) / span))] += r;
  }
  s.pf = gl > 0 ? gp / gl : 99;
  return s;
});

const live = scores.find(s => s.name.startsWith(process.env.BASE ?? 'LIVE'))!;
const best = [...scores].sort((a, b) => b.train - a.train)[0];
console.log(`\nEXIT LAB · ${cases.length} entries · 1m paths up to ${hoursArg}h · costs in R per trade (fees + GST + slippage)\n`);
console.log(`  ${'rule'.padEnd(34)} ${'total R'.padStart(8)} ${'R/trade'.padStart(8)} ${'PF'.padStart(5)} ${'win%'.padStart(5)} ${'1st half'.padStart(9)} ${'2nd half'.padStart(9)} ${'windows'.padStart(8)} ${'beats live'.padStart(11)}`);
for (const s of scores) {
  const beats = s.w.filter((x, i) => x > live.w[i]).length;
  console.log(`  ${s.name.padEnd(34)} ${s.total.toFixed(1).padStart(8)} ${(s.total / s.n).toFixed(3).padStart(8)} ${s.pf.toFixed(2).padStart(5)} ${(s.win / s.n * 100).toFixed(0).padStart(4)}% ${s.train.toFixed(1).padStart(9)} ${s.test.toFixed(1).padStart(9)} ${(s.w.filter(x => x > 0).length + '/' + WINDOWS).padStart(8)} ${(s === live ? '-' : beats + '/' + WINDOWS).padStart(11)}`);
}
console.log(`\n  chosen on the 1st half: "${best.name}" (${best.train.toFixed(1)}R) → 2nd half ${best.test.toFixed(1)}R vs live ${live.test.toFixed(1)}R`);
console.log('  per window, R:');
for (const s of scores) console.log(`  ${s.name.padEnd(34)} ${s.w.map(x => x.toFixed(1).padStart(7)).join('')}`);

// ---------------------------------------------------------------------------------------------
// GRID=1: retrospective search over where protection starts, how much it keeps, and which candle
// the trailing stop watches. On 1m the trail fires on any touch; on 5m/15m it fires only when a
// candle of that size closes beyond it (wicks inside the candle are ignored). The −1R hard stop
// and the 6R target are always checked on every minute.
if (process.env.GRID === '1') {
  const closeTrail = (arm: number, keep: number, tfMin: number, lockAt = 0, lockR = 0) => (path: Min[]) => {
    let peak = 0, trailLvl = -Infinity;
    for (let i = 0; i < path.length; i++) {
      const m = path[i];
      if (m.lo <= -1) return -1;
      if (m.hi >= 6) return 6;
      // a lock is a hard floor, checked intrabar like the stop
      if (lockAt > 0 && peak >= lockAt && m.lo <= lockR) return lockR;
      if (tfMin === 1 && m.lo <= trailLvl) return trailLvl;
      peak = Math.max(peak, m.hi);
      if (peak >= arm) trailLvl = Math.max(trailLvl, peak * keep);
      if (tfMin > 1 && (i + 1) % tfMin === 0 && m.close <= trailLvl) return m.close;
    }
    return path.at(-1)?.close ?? 0;
  };
  type G = { arm: number; keep: number; tf: number; lock: number; total: number; h1: number; h2: number; w: number[]; win: number };
  const grid: G[] = [];
  for (const tf of [1, 5, 15]) for (const arm of [0.5, 0.75, 1, 1.25, 1.5, 2]) for (const keep of [0.4, 0.5, 0.6, 0.75]) for (const lock of [0, 0.5]) {
    if (lock && arm <= 1) continue;   // a lock at 1R only means something when the trail arms later
    const run = closeTrail(arm, keep, tf, lock ? 1 : 0, lock);
    const g: G = { arm, keep, tf, lock, total: 0, h1: 0, h2: 0, w: new Array(WINDOWS).fill(0), win: 0 };
    for (const c of cases) {
      const r = run(c.path) - c.cost;
      g.total += r; if (r > 0) g.win++;
      if (c.e.fillAt < half) g.h1 += r; else g.h2 += r;
      g.w[Math.min(WINDOWS - 1, Math.floor((c.e.fillAt - t0) / span))] += r;
    }
    grid.push(g);
  }
  const label = (g: G) => `${g.tf}m close · from ${g.arm}R keep ${g.keep * 100}%${g.lock ? ' · lock 0.5R at 1R' : ''}`;
  const ref = grid.find(g => g.tf === 1 && g.arm === 1 && g.keep === 0.75 && !g.lock)!;
  const now = grid.find(g => g.tf === 1 && g.arm === 1.5 && g.keep === 0.6 && !g.lock)!;
  const byH1 = [...grid].sort((a, b) => b.h1 - a.h1);
  const rankH2 = (g: G) => [...grid].sort((a, b) => b.h2 - a.h2).indexOf(g) + 1;
  console.log(`\nGRID · ${grid.length} exit rules · ${cases.length} entries · chosen on the 1st half, judged on the 2nd\n`);
  console.log(`  ${'rule'.padEnd(44)} ${'1st half'.padStart(9)} ${'2nd half'.padStart(9)} ${'rank 2nd'.padStart(9)} ${'total'.padStart(7)} ${'win%'.padStart(5)} ${'windows'.padStart(8)}`);
  const show = (g: G, tag = '') => console.log(`  ${(label(g) + tag).padEnd(44)} ${g.h1.toFixed(1).padStart(9)} ${g.h2.toFixed(1).padStart(9)} ${(rankH2(g) + '/' + grid.length).padStart(9)} ${g.total.toFixed(1).padStart(7)} ${(g.win / cases.length * 100).toFixed(0).padStart(4)}% ${(g.w.filter(x => x > 0).length + '/' + WINDOWS).padStart(8)}`);
  for (const g of byH1.slice(0, 10)) show(g);
  console.log('  ...'); show(ref, '  [OLD]'); show(now, '  [LIVE NOW]');
  // does a good first half predict a good second half at all?
  const n = grid.length, mh1 = grid.reduce((a, g) => a + g.h1, 0) / n, mh2 = grid.reduce((a, g) => a + g.h2, 0) / n;
  const cov = grid.reduce((a, g) => a + (g.h1 - mh1) * (g.h2 - mh2), 0), v1 = grid.reduce((a, g) => a + (g.h1 - mh1) ** 2, 0), v2 = grid.reduce((a, g) => a + (g.h2 - mh2) ** 2, 0);
  console.log(`\n  correlation of 1st-half and 2nd-half results across all rules: ${(cov / Math.sqrt(v1 * v2)).toFixed(2)}  (near 1 = the ranking is stable, near 0 = it is noise)`);
  // marginal effect of each dimension, averaged over the others: robust to picking one lucky cell
  const avg = (f: (g: G) => boolean) => { const s = grid.filter(f); return (s.reduce((a, g) => a + g.total, 0) / s.length).toFixed(1).padStart(7) + ` (${(s.reduce((a, g) => a + g.w.filter(x => x > 0).length, 0) / s.length).toFixed(1)}/8)`; };
  console.log('\n  average total R (and windows up) by one dimension, averaged over all the others:');
  console.log('    exit timeframe   ' + [1, 5, 15].map(tf => `${tf}m ${avg(g => g.tf === tf)}`).join('   '));
  console.log('    protect from     ' + [0.5, 0.75, 1, 1.25, 1.5, 2].map(a => `${a}R ${avg(g => g.arm === a)}`).join('  '));
  console.log('    keep of peak     ' + [0.4, 0.5, 0.6, 0.75].map(k => `${k * 100}% ${avg(g => g.keep === k)}`).join('   '));
  console.log('    lock 0.5R at 1R  ' + `no ${avg(g => !g.lock && g.arm > 1)}   yes ${avg(g => g.lock > 0)}`);
}
