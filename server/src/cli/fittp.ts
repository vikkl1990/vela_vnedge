/**
 * Where should a position actually be taken off — and does that differ per scanner?
 *
 *   IDS=ids.txt MARKETS=… TFS=15m npm run fittp
 *
 * Today the whole position rides to TP3: `tpSplit [0, 0, 1]` with targets at 2/4/6R, so TP1 and TP2
 * are drawn but can never fill, and only the 10% of trades that reach 2R see a target at all.
 * Decision 9 tested partial profit at TP1 and decisions 24 and 26 tested closer targets — but never
 * the two together, which is the combination that would actually capture something.
 *
 * Each ladder is fitted on the first half of the history and scored on the second, per scanner,
 * because a breakout scanner that runs and a mean-reversion scanner that stalls at 1R should not be
 * assumed to want the same ladder (decision 38).
 */
import fs from 'node:fs';
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS, type ExitOverride } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';

const cfg = new ConfigStore().get();
if (process.env.PAPER) Object.assign(cfg.paper, JSON.parse(fs.readFileSync(process.env.PAPER, 'utf8')));
const ids = fs.readFileSync(process.env.IDS!, 'utf8').split(/\s+/).filter(Boolean);
const TF = process.env.TF ?? '15m';
const MARKETS = (process.env.MARKETS ?? 'BTCUSD,ETHUSD,SOLUSD').split(',');
const BARS = Number(process.env.BARS ?? 12000);

/** Ladders: where the targets sit, and how much of the position each one takes. */
const LADDERS: Array<{ name: string; over: ExitOverride }> = [
  { name: 'current 2/4/6 all at TP3', over: {} },
  { name: 'split 2/4/6 40/30/30', over: { fallbackRR: [2, 4, 6], tpSplit: [0.4, 0.3, 0.3] } },
  { name: 'close 1/2/4 40/30/30', over: { fallbackRR: [1, 2, 4], tpSplit: [0.4, 0.3, 0.3] } },
  { name: 'close 1/2/3 50/25/25', over: { fallbackRR: [1, 2, 3], tpSplit: [0.5, 0.25, 0.25] } },
  { name: 'half at 1R, run 1/3/6', over: { fallbackRR: [1, 3, 6], tpSplit: [0.5, 0.25, 0.25] } },
  { name: 'runner 1/3/6 30/20/50', over: { fallbackRR: [1, 3, 6], tpSplit: [0.3, 0.2, 0.5] } },
  { name: 'half at 1R, rest at 4R', over: { fallbackRR: [1, 2, 4], tpSplit: [0.5, 0, 0.5] } },
];

const registry = new ScannerRegistry();
const rest = new DeltaRest();
const pool = new PinePool(Number(process.env.CONCURRENCY ?? 7), 300_000);
const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));

type Score = { fit: number; test: number; trades: number; tpHits: number };
const scores = new Map<string, Map<string, Score>>();
const add = (scanner: string, ladder: string, half: 'fit' | 'test', r: number, n: number, hits: number) => {
  const m = scores.get(scanner) ?? new Map<string, Score>();
  const cur = m.get(ladder) ?? { fit: 0, test: 0, trades: 0, tpHits: 0 };
  cur[half] += r;
  if (half === 'test') { cur.trades += n; cur.tpHits += hits; }
  m.set(ladder, cur); scores.set(scanner, m);
};

for (const id of ids) {
  const s = registry.get(id);
  if (!s || s.status !== 'ok') { console.error(`  ${id}: not runnable`); continue; }
  for (const symbol of MARKETS) {
    try {
      const product = await rest.product(symbol);
      const market = { contractValue: Number(product?.contract_value ?? 0.001), tickSize: Number(product?.tick_size ?? 0.5) };
      const bars = toBars(await rest.recentCandles(symbol, TF, BARS, TF_SECONDS[TF]));
      if (bars.length < 500) continue;
      const sub = toBars(await rest.recentCandles(symbol, '1m', Math.min(20000, Math.ceil((bars.length + 2) * TF_SECONDS[TF] / 60)), 60));
      const res = await pool.run({ scannerId: s.id, source: s.patched, symbol, tf: TF, tickSize: market.tickSize, bars, tailBars: 'all', plotTail: bars.length });
      if (!res.ok) continue;
      const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: null, bars, mode: 'backtest' });
      const events = extractEvents(res.alerts, res.shapes, { derived });
      const split = bars[Math.floor(bars.length / 2)].time;
      for (const l of LADDERS) {
        const bt = runBacktest({ scannerId: s.id, scannerName: s.id, symbol, tf: TF, bars, events, cfg: cfg.paper, exitMode: 'both', contractValue: market.contractValue, tickSize: market.tickSize, subBars: sub, scannerExit: l.over });
        for (const half of ['fit', 'test'] as const) {
          const ts = (bt.trades as any[]).filter(t => (t.entryAt < split) === (half === 'fit'));
          const hits = ts.filter(t => String(t.exitReason ?? '').startsWith('tp')).length;
          add(id, l.name, half, ts.reduce((a, t) => a + (t.rMultiple ?? 0), 0), ts.length, hits);
        }
      }
    } catch (e: any) { console.error(`  ${id}/${symbol}: ${e?.message ?? e}`); }
  }
  console.error(`  fitted ${id}`);
}

const pooled = new Map<string, Score>();
for (const [scanner, m] of scores) {
  const cur = m.get('current 2/4/6 all at TP3')!;
  console.log(`\n${scanner}  (current: ${cur.test.toFixed(1)}R out of sample over ${cur.trades} trades, ${cur.tpHits} target exits)`);
  for (const [name, v] of [...m].sort((a, b) => b[1].test - a[1].test)) {
    const p = pooled.get(name) ?? { fit: 0, test: 0, trades: 0, tpHits: 0 };
    p.fit += v.fit; p.test += v.test; p.trades += v.trades; p.tpHits += v.tpHits; pooled.set(name, p);
    const mark = name === 'current 2/4/6 all at TP3' ? '·' : v.test > cur.test ? '↑' : ' ';
    console.log(`  ${mark} ${name.padEnd(26)} in ${v.fit.toFixed(1).padStart(7)}R   out ${v.test.toFixed(1).padStart(7)}R   ${(v.test - cur.test >= 0 ? '+' : '') + (v.test - cur.test).toFixed(1)}R   ${v.tpHits} target exits of ${v.trades}`);
  }
}
const cur = pooled.get('current 2/4/6 all at TP3')!;
console.log(`\nevery scanner pooled — one comparison per ladder\n`);
console.log(`${'ladder'.padEnd(28)} ${'in sample'.padStart(10)} ${'out of sample'.padStart(14)} ${'vs current'.padStart(11)} ${'target exits'.padStart(13)}`);
for (const [name, v] of [...pooled].sort((a, b) => b[1].test - a[1].test))
  console.log(`${name.padEnd(28)} ${v.fit.toFixed(1).padStart(9)}R ${v.test.toFixed(1).padStart(13)}R ${(v.test - cur.test).toFixed(1).padStart(10)}R ${`${v.tpHits}/${v.trades}`.padStart(13)}`);
await pool.stop();
process.exit(0);
