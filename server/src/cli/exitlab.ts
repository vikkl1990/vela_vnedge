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
 * Within a minute the stop is assumed to trade before any target (the conservative order). Costs are
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
      peak = Math.max(peak, m.hi);
      if (o.lock) stop = Math.max(stop, o.lock(peak));
      if (m.lo <= stop) return banked + left * stop;   // a pullback inside the same minute
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

const live = scores[0];
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
