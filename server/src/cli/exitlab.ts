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
  bySymbol.set(s, toBars(await rest.candles(s, '1m', Math.floor(Math.min(...es.map(e => e.fillAt)) / 1000) - (process.env.TP === '1' ? 2 * 86400 : 60), Math.floor((Math.max(...es.map(e => e.fillAt)) + HORIZON) / 1000), 120_000)));
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

// ---------------------------------------------------------------------------------------------
// TP=1: smart take-profit candidates against the live exit (trail 60% from 1.5R, +0.5R locked at
// 1R, 6R cap). Every rule keeps the same stop logic; only how profit is banked changes.
if (process.env.TP === '1') {
  type Opt = { tp?: number; partial?: { at: number; share: number }; decay?: Array<[number, number]> };
  /** The live stop logic plus a take-profit policy. `tpOf(i)` may give a per-trade target in R. */
  const live = (o: Opt) => (path: Min[]) => {
    let stop = -1, peak = 0, banked = 0, left = 1;
    for (let i = 0; i < path.length; i++) {
      const m = path[i];
      if (m.lo <= stop) return banked + left * stop;
      if (o.partial && left === 1 && m.hi >= o.partial.at) { banked += o.partial.share * o.partial.at; left -= o.partial.share; }
      // a time-decaying target: [[minutes, R], …] — the target in force is the last step already reached
      let tp = o.tp ?? 6;
      if (o.decay) for (const [min, r] of o.decay) if (i >= min) tp = r;
      if (m.hi >= tp) return banked + left * tp;
      peak = Math.max(peak, m.hi);
      stop = Math.max(stop, peak >= 1.5 ? peak * 0.6 : peak >= 1 ? 0.5 : -1);
    }
    return banked + left * (path.at(-1)?.close ?? 0);
  };
  // structure: the prior 24h extreme in the trade's direction, in R (the nearest obvious level)
  const structR = cases.map(c => {
    const d = c.e.side === 'long' ? 1 : -1, risk = Math.abs(c.e.entry - c.e.sl);
    const prior = bySymbol.get(c.e.symbol)!.filter(b => b.time < c.e.fillAt && b.time >= c.e.fillAt - 86400_000);
    if (!prior.length) return null;
    const lvl = d === 1 ? Math.max(...prior.map(b => b.high)) : Math.min(...prior.map(b => b.low));
    const r = (lvl - c.e.entry) * d / risk;
    return r >= 0.75 ? r : null;   // a level already under price is no target
  });
  // learned: the scanner's median raw peak over its own EARLIER trades (walk-forward, ≥ 15 of them)
  const rawPeak = cases.map(c => { let pk = 0; for (const m of c.path) { if (m.lo <= -1) break; pk = Math.max(pk, m.hi); } return pk; });
  const learned = cases.map((c, i) => {
    const prior = cases.slice(0, i).map((x, j) => [x, rawPeak[j]] as const).filter(([x]) => x.e.scanner === c.e.scanner && x.e.fillAt + 86400_000 <= c.e.fillAt).map(([, p]) => p);
    if (prior.length < 15) return null;
    const s = prior.sort((a, b) => a - b); return Math.max(1, s[Math.floor(s.length * 0.5)]);
  });
  const rules: Array<{ name: string; run: (path: Min[], i: number) => number }> = [
    { name: 'LIVE NOW (trail + lock, TP 6R)', run: p => live({})(p) },
    { name: 'no TP cap (trail + lock only)', run: p => live({ tp: 999 })(p) },
    { name: 'scale out 1/3 at 1.5R', run: p => live({ partial: { at: 1.5, share: 1 / 3 } })(p) },
    { name: 'scale out 1/2 at 2R', run: p => live({ partial: { at: 2, share: 0.5 } })(p) },
    { name: 'scale out 1/3 at 3R', run: p => live({ partial: { at: 3, share: 1 / 3 } })(p) },
    { name: 'structure: prior-24h extreme', run: (p, i) => live({ tp: structR[i] ?? 6 })(p) },
    { name: 'structure: half off there, trail rest', run: (p, i) => structR[i] ? live({ partial: { at: structR[i]!, share: 0.5 } })(p) : live({})(p) },
    { name: 'learned: scanner median peak', run: (p, i) => live({ tp: learned[i] ?? 6 })(p) },
    { name: 'learned: half off there, trail rest', run: (p, i) => learned[i] ? live({ partial: { at: learned[i]!, share: 0.5 } })(p) : live({})(p) },
    { name: 'time-decay 6R → 3R@4h → 2R@8h', run: p => live({ decay: [[0, 6], [240, 3], [480, 2]] })(p) },
    { name: 'time-decay 4R → 2R@2h → 1.5R@6h', run: p => live({ decay: [[0, 4], [120, 2], [360, 1.5]] })(p) },
  ];
  type G = { name: string; total: number; h1: number; h2: number; w: number[]; win: number };
  const out: G[] = rules.map(r => {
    const g: G = { name: r.name, total: 0, h1: 0, h2: 0, w: new Array(WINDOWS).fill(0), win: 0 };
    cases.forEach((c, i) => {
      const x = r.run(c.path, i) - c.cost;
      g.total += x; if (x > 0) g.win++;
      if (c.e.fillAt < half) g.h1 += x; else g.h2 += x;
      g.w[Math.min(WINDOWS - 1, Math.floor((c.e.fillAt - t0) / span))] += x;
    });
    return g;
  });
  const base = out[0];
  console.log(`\nSMART TP · ${cases.length} entries · stops identical to live, only the profit-taking differs`);
  console.log(`  structure level found for ${structR.filter(Boolean).length}, learned target for ${learned.filter(Boolean).length} of ${cases.length}\n`);
  console.log(`  ${'rule'.padEnd(40)} ${'total R'.padStart(8)} ${'win%'.padStart(5)} ${'1st half'.padStart(9)} ${'2nd half'.padStart(9)} ${'windows'.padStart(8)} ${'beats live'.padStart(11)} ${'w/o best'.padStart(9)}`);
  for (const g of out) {
    const d = g.w.map((x, i) => x - base.w[i]);
    console.log(`  ${g.name.padEnd(40)} ${g.total.toFixed(1).padStart(8)} ${(g.win / cases.length * 100).toFixed(0).padStart(4)}% ${g.h1.toFixed(1).padStart(9)} ${g.h2.toFixed(1).padStart(9)} ${(g.w.filter(x => x > 0).length + '/' + WINDOWS).padStart(8)} ${(g === base ? '-' : d.filter(x => x > 0).length + '/' + WINDOWS).padStart(11)} ${(g === base ? '-' : (d.reduce((a, b) => a + b, 0) - Math.max(...d)).toFixed(1)).padStart(9)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// SPIKE=1: does an early move deserve to be captured? The window is 30 minutes for BTC/ETH and
// 15 for everything else (the owner's observation). First the premise: after an early peak of
// k R, how often does the trade go on to double it, and how often does it fall back to entry
// first? Then capture rules against the live exit.
if (process.env.SPIKE === '1') {
  const W = (sym: string) => (/^(BTC|ETH)USD$/.test(sym) ? 30 : 15);
  const major = (c: typeof cases[number]) => /^(BTC|ETH)USD$/.test(c.e.symbol);
  const earlyPeak = cases.map(c => { let pk = 0; for (let i = 0; i < Math.min(W(c.e.symbol), c.path.length); i++) { if (c.path[i].lo <= -1) break; pk = Math.max(pk, c.path[i].hi); } return pk; });
  console.log(`\nEARLY MOVES · window 30m BTC/ETH (${cases.filter(major).length} entries), 15m others (${cases.filter(c => !major(c)).length})\n`);
  console.log(`  ${'early peak'.padEnd(14)} ${'group'.padEnd(8)} ${'trades'.padStart(6)} ${'then doubled'.padStart(13)} ${'fell to entry first'.padStart(20)} ${'median final raw peak'.padStart(22)}`);
  for (const k of [0.5, 1, 1.5]) for (const grp of ['BTC/ETH', 'others'] as const) {
    const idx = cases.map((c, i) => i).filter(i => earlyPeak[i] >= k && (grp === 'BTC/ETH') === major(cases[i]));
    if (!idx.length) continue;
    let doubled = 0, back = 0; const finals: number[] = [];
    for (const i of idx) {
      const c = cases[i], w = W(c.e.symbol); let pk = 0, res = '';
      for (let j = 0; j < c.path.length; j++) { const m = c.path[j]; if (m.lo <= -1) break; pk = Math.max(pk, m.hi);
        if (!res && j >= w) { if (m.hi >= 2 * k) res = 'up'; else if (m.lo <= 0) res = 'back'; } }
      if (res === 'up') doubled++; else if (res === 'back') back++;
      finals.push(pk);
    }
    finals.sort((a, b) => a - b);
    console.log(`  ≥ ${String(k).padEnd(4)}R in window ${grp.padEnd(8)} ${String(idx.length).padStart(6)} ${((doubled / idx.length) * 100).toFixed(0).padStart(12)}% ${((back / idx.length) * 100).toFixed(0).padStart(19)}% ${finals[Math.floor(finals.length / 2)].toFixed(2).padStart(21)}R`);
  }

  // the live exit, plus an optional early-capture policy
  type Cap = { k: number; share?: number; tighten?: number; spike?: { r: number; win: number } };
  const run = (c: typeof cases[number], cap?: Cap) => {
    const w = W(c.e.symbol);
    let stop = -1, peak = 0, banked = 0, left = 1, tight = false;
    for (let i = 0; i < c.path.length; i++) {
      const m = c.path[i];
      if (m.lo <= stop) return banked + left * stop;
      if (cap && !cap.spike && i < w && left === 1 && m.hi >= cap.k) {
        if (cap.tighten) tight = true;
        else { const sh = cap.share ?? 1; banked += sh * cap.k; left -= sh; if (left <= 1e-9) return banked; }
      }
      // spike anywhere: a gain of r R within `win` minutes, taken at this minute's close
      if (cap?.spike && i >= cap.spike.win && m.close > 0 && m.close - c.path[i - cap.spike.win].close >= cap.spike.r) return banked + left * m.close;
      if (m.hi >= 6) return banked + left * 6;
      peak = Math.max(peak, m.hi);
      const trail = tight ? Math.max(peak * (cap!.tighten!), cap!.k * 0.5) : peak >= 1.5 ? peak * 0.6 : peak >= 1 ? 0.5 : -1;
      stop = Math.max(stop, trail);
    }
    return banked + left * (c.path.at(-1)?.close ?? 0);
  };
  const policies: Array<{ name: string; cap?: Cap }> = [
    { name: 'LIVE NOW' },
    ...[0.5, 0.75, 1, 1.5].map(k => ({ name: `early: take all at ${k}R`, cap: { k } })),
    ...[0.75, 1, 1.5].map(k => ({ name: `early: half at ${k}R, trail rest`, cap: { k, share: 0.5 } })),
    ...[0.75, 1].map(k => ({ name: `early: ${k}R → keep 80% of peak`, cap: { k, tighten: 0.8 } })),
    { name: 'spike: +1R inside 15m, take it', cap: { k: 0, spike: { r: 1, win: 15 } } },
    { name: 'spike: +1.5R inside 30m, take it', cap: { k: 0, spike: { r: 1.5, win: 30 } } },
  ];
  const score = (sel: (c: typeof cases[number]) => boolean, cap?: Cap) => {
    const w = new Array(WINDOWS).fill(0); let tot = 0, h1 = 0, h2 = 0, win = 0, n = 0;
    for (const c of cases) { if (!sel(c)) continue; const x = run(c, cap) - c.cost; n++; tot += x; if (x > 0) win++; if (c.e.fillAt < half) h1 += x; else h2 += x; w[Math.min(WINDOWS - 1, Math.floor((c.e.fillAt - t0) / span))] += x; }
    return { tot, h1, h2, w, win, n };
  };
  for (const [label, sel] of [['ALL', () => true], ['BTC/ETH', major], ['OTHERS', (c: any) => !major(c)]] as const) {
    const base = score(sel as any);
    console.log(`\n  ${label} (${base.n} entries)`);
    console.log(`  ${'rule'.padEnd(36)} ${'total R'.padStart(8)} ${'win%'.padStart(5)} ${'1st half'.padStart(9)} ${'2nd half'.padStart(9)} ${'beats live'.padStart(11)} ${'w/o best'.padStart(9)}`);
    for (const p of policies) {
      const g = score(sel as any, p.cap); const d = g.w.map((x, i) => x - base.w[i]);
      console.log(`  ${p.name.padEnd(36)} ${g.tot.toFixed(1).padStart(8)} ${(g.win / Math.max(1, g.n) * 100).toFixed(0).padStart(4)}% ${g.h1.toFixed(1).padStart(9)} ${g.h2.toFixed(1).padStart(9)} ${(p.cap ? d.filter(x => x > 0).length + '/' + WINDOWS : '-').padStart(11)} ${(p.cap ? (d.reduce((a, b) => a + b, 0) - Math.max(...d)).toFixed(1) : '-').padStart(9)}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// SCALP=1: the same early-capture question priced with Delta's Scalper Offer: a close inside the
// window (30 min BTC/ETH, 15 min others) pays no closing fee. Costs are charged per exited portion:
// the opening fee and slippage always, the closing fee only outside the window.
if (process.env.SCALP === '1') {
  const W = (sym: string) => (/^(BTC|ETH)USD$/.test(sym) ? 30 : 15);
  const major = (c: typeof cases[number]) => /^(BTC|ETH)USD$/.test(c.e.symbol);
  const legR = (c: typeof cases[number]) => {
    const riskPct = Math.abs(c.e.entry - c.e.sl) / c.e.entry * 100;
    const fee = cfg.feeRatePct * (1 + (cfg.feeTaxPct ?? 0) / 100) / riskPct;   // one taker leg, in R
    return { entry: fee + cfg.slippageBps / 100 / riskPct, exit: fee, exitSlip: cfg.slippageBps / 100 / riskPct };
  };
  type Cap = { k?: number; share?: number; scratch?: number; tighten?: number };
  /** Net R of one trade: live stops, an optional early capture, fees charged by exit time. */
  const run = (c: typeof cases[number], cap: Cap = {}, waiver = true) => {
    const w = W(c.e.symbol), L = legR(c);
    const exitCost = (i: number) => L.exitSlip + (waiver && i + 1 <= w ? 0 : L.exit);
    let stop = -1, peak = 0, net = -L.entry, left = 1, tight = false;
    const take = (i: number, share: number, r: number) => { net += share * (r - exitCost(i)); left -= share; };
    for (let i = 0; i < c.path.length; i++) {
      const m = c.path[i];
      if (m.lo <= stop) { take(i, left, stop); return net; }
      if (cap.k !== undefined && i + 1 <= w && left === 1 && m.hi >= cap.k) {
        if (cap.tighten) tight = true;
        else { take(i, cap.share ?? 1, cap.k); if (left <= 1e-9) return net; }
      }
      if (m.hi >= 6) { take(i, left, 6); return net; }
      // the last free minute: leave a trade that is not working while the exit still costs nothing
      if (cap.scratch !== undefined && i + 1 === w && m.close < cap.scratch) { take(i, left, m.close); return net; }
      peak = Math.max(peak, m.hi);
      stop = Math.max(stop, tight ? Math.max(peak * cap.tighten!, cap.k! * 0.5) : peak >= 1.5 ? peak * 0.6 : peak >= 1 ? 0.5 : -1);
    }
    take(c.path.length - 1, left, c.path.at(-1)?.close ?? 0);
    return net;
  };
  const policies: Array<{ name: string; cap: Cap; waiver?: boolean }> = [
    { name: 'LIVE, full fees (no offer)', cap: {}, waiver: false },
    { name: 'LIVE, with the offer', cap: {} },
    ...[0.5, 0.75, 1, 1.5].map(k => ({ name: `take all at ${k}R in window`, cap: { k } })),
    ...[0.75, 1].map(k => ({ name: `half at ${k}R in window, trail rest`, cap: { k, share: 0.5 } })),
    { name: '1R in window → keep 80% of peak', cap: { k: 1, tighten: 0.8 } },
    ...[0, 0.25, 0.5].map(t => ({ name: `scratch at window end if < ${t}R`, cap: { scratch: t } })),
    { name: 'scratch < 0R + take all at 1R', cap: { scratch: 0, k: 1 } },
  ];
  for (const [label, sel] of [['ALL', () => true], ['BTC/ETH', major], ['OTHERS', (c: any) => !major(c)]] as const) {
    const sub = cases.filter(sel as any);
    if (!sub.length) continue;
    const score = (p: typeof policies[number]) => {
      const w = new Array(WINDOWS).fill(0); let tot = 0, win = 0, h1 = 0, h2 = 0;
      for (const c of sub) { const x = run(c, p.cap, p.waiver ?? true); tot += x; if (x > 0) win++; if (c.e.fillAt < half) h1 += x; else h2 += x; w[Math.min(WINDOWS - 1, Math.floor((c.e.fillAt - t0) / span))] += x; }
      return { tot, win, h1, h2, w };
    };
    const base = score(policies[1]);
    console.log(`\n  ${label} (${sub.length} entries) · closing fee waived inside ${label === 'OTHERS' ? '15' : label === 'BTC/ETH' ? '30' : '30/15'} min`);
    console.log(`  ${'rule'.padEnd(36)} ${'total R'.padStart(8)} ${'win%'.padStart(5)} ${'1st half'.padStart(9)} ${'2nd half'.padStart(9)} ${'beats live'.padStart(11)} ${'w/o best'.padStart(9)}`);
    for (const p of policies) {
      const g = score(p); const d = g.w.map((x, i) => x - base.w[i]);
      const cmp = p === policies[1] ? '-' : `${d.filter(x => x > 0).length}/${WINDOWS}`;
      console.log(`  ${p.name.padEnd(36)} ${g.tot.toFixed(1).padStart(8)} ${(g.win / sub.length * 100).toFixed(0).padStart(4)}% ${g.h1.toFixed(1).padStart(9)} ${g.h2.toFixed(1).padStart(9)} ${cmp.padStart(11)} ${(p === policies[1] ? '-' : (d.reduce((a, b) => a + b, 0) - Math.max(...d)).toFixed(1)).padStart(9)}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// PAIRS=1: the same take-profit question asked per scanner/market, because reachability differs.
// One pair reaches 6R on a third of its entries; another almost never gets past 1R, so a single
// fixed target cannot be right for both. Rules keep the live stop logic (lock +0.5R at 1R, trail
// 60% of the peak from 1.5R) and change only where profit is banked.
if (process.env.PAIRS === '1') {
  const live = (tp: number, partial?: { at: number; share: number }) => (path: Min[]) => {
    let stop = -1, peak = 0, banked = 0, left = 1;
    for (const m of path) {
      if (m.lo <= stop) return banked + left * stop;
      if (partial && left === 1 && m.hi >= partial.at) { banked += partial.share * partial.at; left -= partial.share; }
      if (m.hi >= tp) return banked + left * tp;
      peak = Math.max(peak, m.hi);
      stop = Math.max(stop, peak >= 1.5 ? peak * 0.6 : peak >= 1 ? 0.5 : -1);
    }
    return banked + left * (path.at(-1)?.close ?? 0);
  };
  const rules: Array<{ name: string; run: (p: Min[]) => number }> = [
    { name: 'live (TP 6R)', run: live(6) },
    { name: 'TP 2R', run: live(2) },
    { name: 'TP 3R', run: live(3) },
    { name: 'TP 4R', run: live(4) },
    { name: 'half at 1R', run: live(6, { at: 1, share: 0.5 }) },
    { name: 'half at 2R', run: live(6, { at: 2, share: 0.5 }) },
    { name: 'half at 3R', run: live(6, { at: 3, share: 0.5 }) },
  ];
  const groups = new Map<string, typeof cases>();
  for (const c of cases) {
    const k = `${c.e.scanner} ${c.e.symbol}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  console.log(`\nTARGETS PER PAIR · net R after costs, live stop logic throughout\n`);
  console.log(`  ${'pair'.padEnd(46)} ${'n'.padStart(4)} ${rules.map(r => r.name.padStart(12)).join('')}   best`);
  const totals = rules.map(() => 0);
  for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (g.length < 20) continue;
    const scores = rules.map(r => g.reduce((a, c) => a + r.run(c.path) - c.cost, 0));
    scores.forEach((v, i) => { totals[i] += v; });
    const best = scores.indexOf(Math.max(...scores));
    console.log(`  ${k.slice(0, 46).padEnd(46)} ${String(g.length).padStart(4)} ${scores.map(v => v.toFixed(1).padStart(12)).join('')}   ${rules[best].name}${best === 0 ? '' : ` (+${(scores[best] - scores[0]).toFixed(1)}R)`}`);
  }
  console.log(`  ${'ALL PAIRS'.padEnd(46)} ${String(cases.length).padStart(4)} ${totals.map(v => v.toFixed(1).padStart(12)).join('')}   ${rules[totals.indexOf(Math.max(...totals))].name}`);
  console.log('\n  a per-pair target only pays if the same pair keeps choosing it out of sample; the column to trust is ALL PAIRS.');
}
