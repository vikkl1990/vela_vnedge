/**
 * Do the lines a script draws make better stops than the ATR fallback?
 *
 *   PAIRS=pairs.json PAPER=vm.json npm run plotstops -- [BARS] [TF]
 *
 * 47 of 49 live signals arrive as chart shapes or alertcondition text, which cannot carry a stop, so
 * the engine falls back to 1.5 × ATR (decision 24). But most of those scripts *draw* their idea of
 * risk — a SuperTrend line, a channel edge, a band. `selectTrail` already identifies that series for
 * the trailing rules; here it sets the stop instead, with the targets recomputed from the new risk.
 *
 * Variants: the line itself, the line with a buffer (price wicks through a visible level), and the
 * line only when it sits within a sane distance, falling back to ATR otherwise.
 */
import fs from 'node:fs';
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents, type ScanEvent } from '../scanners/extractor.ts';
import { applyRules, selectTrail } from '../scanners/rules.ts';
import { runBacktest } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import { atrSeries } from '../data/indicators.ts';
import type { Bar } from '../data/candleStore.ts';

const [barsArg = '4000', tfArg = '15m'] = process.argv.slice(2);
const TF = tfArg, WINDOWS = 8;
const cfg = new ConfigStore().get();
if (process.env.PAPER) Object.assign(cfg.paper, JSON.parse(fs.readFileSync(process.env.PAPER, 'utf8')));
const pairs: any[] = JSON.parse(fs.readFileSync(process.env.PAIRS!, 'utf8'));
const registry = new ScannerRegistry();
const rest = new DeltaRest();
const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));

type Variant = { name: string; sl: (o: { line: number | null; price: number; atr: number; side: string }) => number | undefined };
const MIN_ATR = 0.3, MAX_ATR = 4;      // a stop nearer than this is all fees; further than this is not a stop
const variants: Variant[] = [
  { name: 'ATR fallback (live)', sl: () => undefined },
  { name: 'plotted line', sl: o => (o.line !== null && (o.side === 'long' ? o.line < o.price : o.line > o.price) ? o.line : undefined) },
  { name: 'plotted line + 0.25 ATR', sl: o => (o.line !== null && (o.side === 'long' ? o.line < o.price : o.line > o.price) ? o.line - (o.side === 'long' ? 1 : -1) * 0.25 * o.atr : undefined) },
  ...[[0.3, 4], [0.3, 3], [0.5, 2.5], [0.5, 2]].map(([lo, hi]) => ({
    name: `line if ${lo}–${hi} ATR away`,
    sl: (o: { line: number | null; price: number; atr: number; side: string }) => {
      if (o.line === null || !(o.atr > 0)) return undefined;
      const dist = (o.side === 'long' ? o.price - o.line : o.line - o.price) / o.atr;
      return dist >= lo && dist <= hi ? o.line : undefined;
    },
  })),
  {
    name: 'unused',
    sl: o => {
      if (o.line === null || !(o.atr > 0)) return undefined;
      const dist = (o.side === 'long' ? o.price - o.line : o.line - o.price) / o.atr;
      return dist >= MIN_ATR && dist <= MAX_ATR ? o.line : undefined;
    },
  },
];

interface Agg { trades: number; net: number; gp: number; gl: number; r: number; used: number; entries: number; dists: number[]; w: number[] }
const blank = (): Agg => ({ trades: 0, net: 0, gp: 0, gl: 0, r: 0, used: 0, entries: 0, dists: [], w: new Array(WINDOWS).fill(0) });
const totals = new Map<string, Agg>(variants.map(v => [v.name, blank()]));
const perPair = new Map<string, Map<string, Agg>>();
const pool = new PinePool(6, 300_000);

for (const p of pairs) {
  const s = registry.get(p.id);
  if (!s || s.status !== 'ok') continue;
  try {
    const product = await rest.product(p.symbol);
    const market = { contractValue: Number(product?.contract_value ?? 0.001), tickSize: Number(product?.tick_size ?? 0.5) };
    const bars = toBars(await rest.recentCandles(p.symbol, TF, Number(barsArg), TF_SECONDS[TF]));
    if (bars.length < 300) continue;
    const m1 = toBars(await rest.recentCandles(p.symbol, '1m', Math.ceil((bars.length + 2) * TF_SECONDS[TF] / 60), 60));
    const res = await pool.run({ scannerId: s.id, source: s.patched, symbol: p.symbol, tf: TF, tickSize: market.tickSize, bars, tailBars: 'all', plotTail: bars.length, inputs: p.inputs });
    if (!res.ok) { console.error(`  ${p.id}/${p.symbol}: ${res.error}`); continue; }
    const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: p.rule ?? null, bars, mode: 'backtest' });
    const events = extractEvents(res.alerts, res.shapes, { derived });
    const trail = selectTrail(res.plots, bars);
    const atr = atrSeries(bars, 14);
    const idx = new Map(bars.map((b, i) => [b.time, i]));
    const key = `${p.id} ${p.symbol}`;
    if (!perPair.has(key)) perPair.set(key, new Map(variants.map(v => [v.name, blank()])));

    for (const v of variants) {
      const agg = totals.get(v.name)!, pa = perPair.get(key)!.get(v.name)!;
      const evs: ScanEvent[] = events.map(e => {
        if (e.kind !== 'entry' || e.side === undefined || (e.sl && e.sl > 0)) return e;
        const i = idx.get(e.barTime); if (i === undefined) return e;
        const price = e.price && e.price > 0 ? e.price : bars[i].close;
        const line = trail?.values[i] ?? null;
        const sl = v.sl({ line, price, atr: atr[i] ?? 0, side: e.side });
        if (v.name !== variants[0].name) { pa.entries++; agg.entries++; if (sl !== undefined) { pa.used++; agg.used++; const d = Math.abs(price - sl) / (atr[i] || 1); pa.dists.push(d); agg.dists.push(d); } }
        return sl === undefined ? e : { ...e, sl };
      });
      const bt = runBacktest({ scannerId: s.id, scannerName: s.id, symbol: p.symbol, tf: TF, bars, events: evs, cfg: cfg.paper, exitMode: p.exitMode ?? 'both', contractValue: market.contractValue, tickSize: market.tickSize, subBars: m1 });
      const span = (bars.at(-1)!.time - bars[0].time) / WINDOWS;
      for (const t of bt.trades as any[]) {
        for (const a of [agg, pa]) {
          a.trades++; a.net += t.pnl; a.r += t.rMultiple ?? 0;
          if (t.pnl > 0) a.gp += t.pnl; else a.gl -= t.pnl;
          a.w[Math.min(WINDOWS - 1, Math.floor((t.entryAt - bars[0].time) / span))] += t.pnl;
        }
      }
    }
    console.error(`  ${key}: ${trail ? `trail line "${trail.title}"` : 'no usable line'}`);
  } catch (e: any) { console.error(`  ${p.id}/${p.symbol}: ${e?.message ?? e}`); }
}
await pool.stop();

const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(2) : '-');
const pf = (a: Agg) => (a.gl > 0 ? a.gp / a.gl : a.gp > 0 ? 99 : 0);
console.log(`\nSTOPS FROM PLOTTED LINES · ${pairs.length} pairs · ${TF} · exits on 1m · live costs\n`);
console.log(`  ${'variant'.padEnd(28)} ${'trades'.padStart(7)} ${'net'.padStart(9)} ${'PF'.padStart(6)} ${'avgR'.padStart(6)} ${'windows'.padStart(8)} ${'line used'.padStart(10)} ${'median stop'.padStart(12)}`);
for (const v of variants) {
  const a = totals.get(v.name)!;
  console.log(`  ${v.name.padEnd(28)} ${String(a.trades).padStart(7)} ${a.net.toFixed(0).padStart(9)} ${pf(a).toFixed(2).padStart(6)} ${(a.trades ? a.r / a.trades : 0).toFixed(3).padStart(6)} ${(a.w.filter(x => x > 0).length + '/' + WINDOWS).padStart(8)} ${(a.entries ? `${Math.round(a.used / a.entries * 100)}%` : '-').padStart(10)} ${(a.dists.length ? `${med(a.dists)} ATR` : '-').padStart(12)}`);
}
console.log('\n  per pair, net:');
console.log(`  ${'pair'.padEnd(44)} ${variants.map(v => v.name.slice(0, 13).padStart(14)).join('')}`);
for (const [k, m] of perPair) console.log(`  ${k.slice(0, 44).padEnd(44)} ${variants.map(v => m.get(v.name)!.net.toFixed(0).padStart(14)).join('')}`);
