/**
 * How much history each script actually needs.
 *
 *   SCRIPTS=40 MARKETS=BTCUSD,ETHUSD LENGTHS=1000,600,400,250 npm run history
 *
 * Pine has no incremental state: every run recomputes the whole series, so the bar count is a direct
 * multiplier on the cost of every live scan — 1000 bars to 400 nearly doubles throughput. But a
 * script with a 200-period average or a session anchor needs its warm-up, and cutting history
 * silently changes what it signals.
 *
 * So this measures instead of assuming: each script is run at full history and again at each shorter
 * length, and the entry signals over the shared tail are compared. A length "passes" when it
 * reproduces every signal the full run produced, at the same bar and side.
 */
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { ScriptHealth } from '../scanners/health.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { Db } from '../db.ts';
import { TF_SECONDS } from '../config.ts';

const N = Number(process.env.SCRIPTS ?? 40);
const MARKETS = (process.env.MARKETS ?? 'BTCUSD,ETHUSD').split(',');
const LENGTHS = (process.env.LENGTHS ?? '1000,600,400,250').split(',').map(Number).sort((a, b) => b - a);
const TF = process.env.TF ?? '15m';
const FULL = LENGTHS[0];
/** Signals are only compared where both runs can see the bar: the shortest run's own window. */
const tailOf = (evts: any[], from: number) => evts.filter(e => e.kind === 'entry' && e.barTime >= from).map(e => `${e.barTime}:${e.side}`).join(',');

const health = new ScriptHealth(new Db());
const registry = new ScannerRegistry();
const scripts = registry.runnable().filter(s => !health.isQuarantined(s.id)).slice(0, N);
const pool = new PinePool(Number(process.env.WORKERS) || 8, 120_000);
const rest = new DeltaRest();
const bars = new Map<string, any[]>();
for (const m of MARKETS) {
  const c = await rest.recentCandles(m, TF, FULL + 5, TF_SECONDS[TF]);
  bars.set(m, c.slice(0, -1).map((x: any) => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume })));
}

const run = async (s: any, m: string, n: number) => {
  const b = bars.get(m)!.slice(-n);
  const r = await pool.run({ scannerId: s.id, source: s.patched, symbol: m, tf: TF, tickSize: 0.5, bars: b, tailBars: 'all', plotTail: b.length });
  return r.ok ? extractEvents(r.alerts, r.shapes, {}) : null;
};

const shortest = new Map<string, number>();
const agree: Record<number, { same: number; diff: number }> = Object.fromEntries(LENGTHS.slice(1).map(n => [n, { same: 0, diff: 0 }]));
for (const s of scripts) {
  let best = FULL;
  for (const m of MARKETS) {
    const full = await run(s, m, FULL);
    if (!full) { best = NaN; break; }
    for (const n of LENGTHS.slice(1)) {
      const from = bars.get(m)!.slice(-n)[0].time;
      const short = await run(s, m, n);
      const ok = short !== null && tailOf(short, from) === tailOf(full, from);
      agree[n][ok ? 'same' : 'diff']++;
      if (!ok) break;
      best = Math.min(best, n);
    }
  }
  if (!Number.isNaN(best)) shortest.set(s.id, best);
}

console.log(`\n${shortest.size} scripts × ${MARKETS.length} markets on ${TF}\n`);
console.log(`${'history'.padStart(7)}  ${'reproduces the full run'.padStart(23)}  share`);
for (const n of LENGTHS.slice(1)) {
  const a = agree[n], tot = a.same + a.diff;
  console.log(`${String(n).padStart(7)}  ${`${a.same}/${tot}`.padStart(23)}  ${tot ? Math.round(a.same / tot * 100) : 0}%`);
}
const hist: Record<number, number> = {};
for (const n of shortest.values()) hist[n] = (hist[n] ?? 0) + 1;
console.log(`\nshortest safe history per script:`);
for (const n of LENGTHS) if (hist[n]) console.log(`${String(n).padStart(7)}  ${hist[n]} scripts`);
const weighted = [...shortest.values()].reduce((a, b) => a + b, 0) / Math.max(1, shortest.size);
console.log(`\naverage ${Math.round(weighted)} bars against ${FULL} today → about ${(FULL / weighted).toFixed(1)}× the scans for the same CPU`);
await pool.stop();
process.exit(0);
