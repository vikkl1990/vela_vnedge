/**
 * Fit the exit policy per market, honestly.
 *
 *   MARKETS=BTCUSD,ETHUSD BARS=12000 npm run fitexits
 *
 * The reconstruction of live trades says 55% of them reach +0.5R and 30% of those still end at −1R,
 * because protection does not arm until +1R. How far a trade travels before it turns is a property of
 * the market, not of the fleet, so the arming point is a per-market question (decision 34).
 *
 * Every candidate policy is fitted on the first half of the history and scored on the second, and the
 * winner is only reported when it also beats the current policy out of sample. A policy that wins in
 * sample and loses out of sample is a curve fit, and it is printed as such.
 */
import fs from 'node:fs';
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS, type PaperConfig } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';

const cfg = new ConfigStore().get();
if (process.env.PAPER) Object.assign(cfg.paper, JSON.parse(fs.readFileSync(process.env.PAPER, 'utf8')));
const TF = process.env.TF ?? '15m';
const BARS = Number(process.env.BARS ?? 12000);
const CONC = Number(process.env.CONCURRENCY ?? 7);

/** The candidates: where protection arms, what it keeps, and how much of the peak the trail gives back. */
const GRID: Array<{ name: string; over: Partial<PaperConfig> }> = process.env.STOPS ? [
  // The stop is the unit everything else is measured in, and 1.5xATR has never been challenged:
  // 97% of trades use it, because scripts rarely publish a stop of their own.
  { name: 'stop 1.0 ATR', over: { fallbackAtrSl: 1.0 } },
  { name: 'stop 1.25 ATR', over: { fallbackAtrSl: 1.25 } },
  { name: 'stop 1.5 ATR (current)', over: {} },
  { name: 'stop 2.0 ATR', over: { fallbackAtrSl: 2.0 } },
  { name: 'stop 2.5 ATR', over: { fallbackAtrSl: 2.5 } },
  { name: 'stop 3.0 ATR', over: { fallbackAtrSl: 3.0 } },
  // a wider stop with the targets held at the same absolute distance, so R shrinks but reach does not
  { name: 'stop 2.0 ATR, targets 1.5/3/4.5R', over: { fallbackAtrSl: 2.0, fallbackRR: [1.5, 3, 4.5] } },
  { name: 'stop 1.0 ATR, targets 3/6/9R', over: { fallbackAtrSl: 1.0, fallbackRR: [3, 6, 9] } },
  // widen the fallback to the fee minimum instead of refusing the trade
  { name: '1.0 ATR, widened to fee', over: { fallbackAtrSl: 1.0, widenStopToFee: true } },
  { name: '1.5 ATR, widened to fee', over: { fallbackAtrSl: 1.5, widenStopToFee: true } },
  { name: '2.0 ATR, widened to fee', over: { fallbackAtrSl: 2.0, widenStopToFee: true } },
] : [
  { name: 'current', over: {} },
  { name: 'be@0.5', over: { floorAtR: 0.5, floorKeepR: 0 } },
  { name: 'be@0.75', over: { floorAtR: 0.75, floorKeepR: 0 } },
  { name: 'lock0.25@0.5', over: { floorAtR: 0.5, floorKeepR: 0.25 } },
  { name: 'lock0.5@0.75', over: { floorAtR: 0.75, floorKeepR: 0.5 } },
  { name: 'be@0.5+trail1', over: { floorAtR: 0.5, floorKeepR: 0, trailAfterR: 1 } },
  { name: 'be@0.5+tight', over: { floorAtR: 0.5, floorKeepR: 0, trailGiveBackPct: 25 } },
  { name: 'trail@1', over: { trailAfterR: 1 } },
  // the owner's question after decision 50: arm the trail below +1R so a +0.9R peak keeps more than the lock
  { name: 'trail@0.75', over: { trailAfterR: 0.75 } },
  { name: 'trail@0.5', over: { trailAfterR: 0.5 } },
  { name: 'trail@0.75 keep50', over: { trailAfterR: 0.75, trailGiveBackPct: 50 } },
  { name: 'trail@0.5 keep50', over: { trailAfterR: 0.5, trailGiveBackPct: 50 } },
  { name: 'trail@0.75 no steps', over: { trailAfterR: 0.75, trailSteps: [] } },
  // smarter trailing: tighten as the trade grows, and when it stops making highs
  { name: 'steps 2R/4R', over: { trailAfterR: 1, trailSteps: [[2, 30], [4, 20]] } },
  { name: 'steps 1.5R/3R', over: { trailAfterR: 1, trailSteps: [[1.5, 30], [3, 15]] } },
  { name: 'stall 30m', over: { trailAfterR: 1, trailStall: { minutes: 30, factor: 0.5 } } },
  { name: 'stall 60m', over: { trailAfterR: 1, trailStall: { minutes: 60, factor: 0.5 } } },
  { name: 'steps+stall', over: { trailAfterR: 1, trailSteps: [[2, 30], [4, 20]], trailStall: { minutes: 45, factor: 0.6 } } },
  { name: 'atr trail 2.5', over: { trailAfterR: 1, trailAtrMult: 2.5 } },
  // the sub-1R band, where nothing protects a trade today and the owner has been acting by hand
  { name: 'stall 0.3R/30m', over: { trailAfterR: 1, trailSteps: [[2, 30], [4, 20]], trailStall: { minutes: 45, factor: 0.6 }, earlyStall: { minR: 0.3, maxR: 1, minutes: 30 } } },
  { name: 'stall 0.3R/45m', over: { trailAfterR: 1, trailSteps: [[2, 30], [4, 20]], trailStall: { minutes: 45, factor: 0.6 }, earlyStall: { minR: 0.3, maxR: 1, minutes: 45 } } },
  { name: 'stall 0.5R/30m', over: { trailAfterR: 1, trailSteps: [[2, 30], [4, 20]], trailStall: { minutes: 45, factor: 0.6 }, earlyStall: { minR: 0.5, maxR: 1, minutes: 30 } } },
  { name: 'stall 0.5R/60m', over: { trailAfterR: 1, trailSteps: [[2, 30], [4, 20]], trailStall: { minutes: 45, factor: 0.6 }, earlyStall: { minR: 0.5, maxR: 1, minutes: 60 } } },
  { name: 'stall 0.2R/20m', over: { trailAfterR: 1, trailSteps: [[2, 30], [4, 20]], trailStall: { minutes: 45, factor: 0.6 }, earlyStall: { minR: 0.2, maxR: 1, minutes: 20 } } },
  { name: 'deployed (no early stall)', over: { trailAfterR: 1, trailSteps: [[2, 30], [4, 20]], trailStall: { minutes: 45, factor: 0.6 } } },
  // the ceiling on what finer data than 1m could be worth: the same policy read optimistically
  { name: 'deployed, target-first', over: { trailAfterR: 1, trailSteps: [[2, 30], [4, 20]], trailStall: { minutes: 45, factor: 0.6 }, barOrder: 'target-first' } },
];

/** The policy every other one is compared against, whichever grid is in play. */
const BASE = process.env.STOPS ? 'stop 1.5 ATR (current)' : 'current';

const fleet = Object.entries(cfg.scanners).filter(([, v]) => v.enabled && !v.hidden)
  .flatMap(([id, v]) => (v.symbols ?? cfg.symbols).map(symbol => ({ id, symbol })));
const markets = (process.env.MARKETS ?? [...new Set(fleet.map(f => f.symbol))].join(',')).split(',');
const registry = new ScannerRegistry();
const rest = new DeltaRest();
const pool = new PinePool(CONC, 300_000);
const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));

type Half = 'fit' | 'test';
// R is defined by the stop, so a wider stop redefines the unit: dollars on the same starting equity
// are the only figure comparable across stop widths.
const scores = new Map<string, Map<string, { fit: number; test: number; trades: number; usd: number }>>();
const note = (symbol: string, policy: string, half: Half, r: number, n: number, usd = 0) => {
  const m = scores.get(symbol) ?? new Map();
  const cur = m.get(policy) ?? { fit: 0, test: 0, trades: 0, usd: 0 };
  cur[half] += r; if (half === 'test') { cur.trades += n; cur.usd += usd; }
  m.set(policy, cur); scores.set(symbol, m);
};

const jobs = fleet.filter(f => markets.includes(f.symbol));
console.error(`fitting ${GRID.length} exit policies on ${jobs.length} scanner×market pairs, ${BARS} bars of ${TF}`);
let done = 0;
for (const f of jobs) {
  try {
    const s = registry.get(f.id);
    if (!s || s.status !== 'ok') continue;
    const product = await rest.product(f.symbol);
    const market = { contractValue: Number(product?.contract_value ?? 0.001), tickSize: Number(product?.tick_size ?? 0.5) };
    const bars = toBars(await rest.recentCandles(f.symbol, TF, BARS, TF_SECONDS[TF]));
    if (bars.length < 500) continue;
    const sub = toBars(await rest.recentCandles(f.symbol, '1m', Math.min(20000, Math.ceil((bars.length + 2) * TF_SECONDS[TF] / 60)), 60));
    const res = await pool.run({ scannerId: s.id, source: s.patched, symbol: f.symbol, tf: TF, tickSize: market.tickSize, bars, tailBars: 'all', plotTail: bars.length });
    if (!res.ok) continue;
    const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: null, bars, mode: 'backtest' });
    const events = extractEvents(res.alerts, res.shapes, { derived });
    const split = bars[Math.floor(bars.length / 2)].time;
    for (const g of GRID) {
      const bt = runBacktest({ scannerId: s.id, scannerName: s.id, symbol: f.symbol, tf: TF, bars, events, cfg: { ...cfg.paper, ...g.over }, exitMode: 'both', contractValue: market.contractValue, tickSize: market.tickSize, subBars: sub });
      const trades = bt.trades as any[];
      const half = (t: any): Half => (t.entryAt < split ? 'fit' : 'test');
      for (const h of ['fit', 'test'] as Half[]) {
        const ts = trades.filter(t => half(t) === h);
        note(f.symbol, g.name, h, ts.reduce((a, t) => a + (t.rMultiple ?? 0), 0), ts.length, ts.reduce((a, t) => a + (t.pnl ?? 0), 0));
      }
    }
    done++;
    if (done % 5 === 0) console.error(`  ${done}/${jobs.length}`);
  } catch (e: any) { console.error(`  ${f.id}/${f.symbol}: ${e?.message ?? e}`); }
}

console.log(`\n${'market'.padEnd(12)} ${'best in sample'.padStart(16)} ${'its out-of-sample'.padStart(18)} ${'current out'.padStart(12)} ${'trades'.padStart(7)}   verdict`);
let adopt: Record<string, any> = {};
for (const [symbol, m] of [...scores].sort()) {
  const cur = m.get(BASE)!;
  const ranked = [...m].filter(([n]) => n !== BASE).sort((a, b) => b[1].fit - a[1].fit);
  const [name, v] = ranked[0];
  const better = v.test > cur.test + 0.5;
  console.log(`${symbol.padEnd(12)} ${(name + ' ' + v.fit.toFixed(1) + 'R').padStart(16)} ${v.test.toFixed(1).padStart(17)}R ${cur.test.toFixed(1).padStart(11)}R ${String(cur.trades).padStart(7)}   ${better ? 'ADOPT ' + name : v.test < cur.test ? 'curve fit — rejected' : 'no better'}`);
  if (better) adopt[symbol] = GRID.find(g => g.name === name)!.over;
}
console.log(`\nexitBySymbol to adopt:\n${JSON.stringify(adopt, null, 2)}`);

// The decisive test: one comparison per policy, across every market, out of sample. Per-market
// winners are eight chances per market to beat noise; this is one.
const pooled = new Map<string, { fit: number; test: number; trades: number; usd: number }>();
for (const m of scores.values()) for (const [name, v] of m) {
  const p = pooled.get(name) ?? { fit: 0, test: 0, trades: 0, usd: 0 };
  p.fit += v.fit; p.test += v.test; p.trades += v.trades; p.usd += v.usd; pooled.set(name, p);
}
const cur = pooled.get(BASE)!;
console.log(`\nevery market pooled — the honest comparison\n`);
// breadth: a policy that wins the pool from one market is a curve fit wearing a total (decision 43)
const breadth = (name: string) => { let b = 0, w = 0; for (const [, m] of scores) { const v = m.get(name), c = m.get(BASE); if (!v || !c) continue; if (v.test > c.test + 0.5) b++; else if (v.test < c.test - 0.5) w++; } return `${b}/${w}`; };
console.log(`${'policy'.padEnd(30)} ${'in sample'.padStart(11)} ${'out of sample'.padStart(14)} ${'vs current'.padStart(11)} ${'out $'.padStart(10)} ${'trades'.padStart(7)}   markets better/worse`);
for (const [name, v] of [...pooled].sort((a, b) => b[1].usd - a[1].usd))
  console.log(`${name.padEnd(30)} ${v.fit.toFixed(1).padStart(10)}R ${v.test.toFixed(1).padStart(13)}R ${(v.test - cur.test).toFixed(1).padStart(10)}R ${v.usd.toFixed(0).padStart(10)} ${String(v.trades).padStart(7)}   ${breadth(name)}`);
fs.writeFileSync(process.env.OUT ?? '/tmp/fitexits.json', JSON.stringify([...scores].map(([sym, m]) => ({ symbol: sym, policies: Object.fromEntries(m) })), null, 1));
await pool.stop();
process.exit(0);
