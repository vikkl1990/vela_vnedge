/**
 * Tune a Pine script's inputs — honestly.
 *
 *   npm run tune -- <SCANNERS|@file> [SYMBOLS] [TF] [BARS]
 *
 * For each scanner, its numeric inputs are varied one at a time around their defaults. Every
 * variant runs the script once over the full history, so indicators warm up properly, and the
 * resulting trades are then split by entry time: the first 70% of the span is TRAIN, the last 30%
 * is TEST, and the two never mix.
 *
 * The variant is chosen on TRAIN only. It is then judged on TEST, against the untouched default on
 * the same TEST period. A tuning is kept only if it beats the default *out of sample*.
 *
 * That last rule is the whole point. Choosing the best of dozens of variants on one stretch of
 * history always produces an improvement on that stretch; the question is whether it survives the
 * next one. This reports how often it does, which is also a direct measure of how much of any
 * apparent improvement was fitted noise.
 *
 * One-at-a-time rather than a full grid is deliberate: a grid multiplies the comparisons, and so
 * the overfitting, and it hides which single input actually mattered.
 */
import fs from 'node:fs';
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest } from '../paper/backtest.ts';
import { parseInputs, type PineInputDecl, type InputValue } from '../pine/inputs.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';

const [scannerArg, symArg = 'BTCUSD,SOLUSD', tfArg = '15m', barsArg = '3000'] = process.argv.slice(2);
if (!scannerArg) { console.error('usage: npm run tune -- <id,id,…|@file> [SYMBOLS] [TF] [BARS]'); process.exit(1); }
const IDS = scannerArg.startsWith('@') ? fs.readFileSync(scannerArg.slice(1), 'utf8').split(/\s+/).filter(Boolean) : scannerArg.split(',');
const SYMBOLS = symArg.split(',');
const TF = tfArg;
const BARS = Number(barsArg);
const TRAIN_SHARE = 0.7;
const MIN_TRAIN_TRADES = 8;
const MULTIPLIERS = [0.5, 0.75, 1.5, 2];
/** NO_TUNE=1 evaluates each script at its defaults only: a cheap pass that finds what trades at all. */
const NO_TUNE = process.env.NO_TUNE === '1';
/** Cap per scanner, so a script with forty inputs cannot turn one test into four hundred. */
const MAX_VARIANTS = Number(process.env.MAX_VARIANTS ?? 24);

const cfg = new ConfigStore().get();
const registry = new ScannerRegistry();
const rest = new DeltaRest();
const pool = new PinePool(6, 120_000);

/** Candidate values for one numeric input, respecting its declared bounds and type. */
function candidates(d: PineInputDecl): InputValue[] {
  if (d.type === 'bool') return typeof d.default === 'boolean' ? [!d.default] : [];
  if ((d.type !== 'int' && d.type !== 'float') || typeof d.default !== 'number' || d.default === 0) return [];
  const out = new Set<number>();
  const base = d.default;
  for (const m of MULTIPLIERS) {
    let v: number = base * m;
    if (d.min !== undefined) v = Math.max(d.min, v);
    if (d.max !== undefined) v = Math.min(d.max, v);
    v = d.type === 'int' ? Math.round(v) : Math.round(v * 1000) / 1000;
    if (v !== base && Number.isFinite(v) && (d.type !== 'int' || v >= 1)) out.add(v);
  }
  return [...out];
}

interface Split { trades: number; pnl: number; gp: number; gl: number }
const pf = (s: Split) => (s.gl > 0 ? s.gp / s.gl : s.gp > 0 ? 99 : 0);

/** Run a scanner with some inputs over every symbol and split its trades into train and test. */
async function evaluate(s: any, inputs: Record<string, InputValue> | undefined, data: Map<string, { bars: Bar[]; market: any; cut: number }>) {
  const train: Split = { trades: 0, pnl: 0, gp: 0, gl: 0 }, test: Split = { trades: 0, pnl: 0, gp: 0, gl: 0 };
  for (const [symbol, d] of data) {
    const res = await pool.run({ scannerId: s.id, source: s.patched, symbol, tf: TF, tickSize: d.market.tickSize, bars: d.bars, tailBars: 'all', plotTail: d.bars.length, inputs });
    if (!res.ok) return null;
    const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: cfg.scanners[s.id]?.rule ?? null, bars: d.bars, mode: 'backtest' });
    const bt = runBacktest({ scannerId: s.id, scannerName: s.id, symbol, tf: TF, bars: d.bars, events: extractEvents(res.alerts, res.shapes, { derived }), cfg: cfg.paper, exitMode: cfg.scanners[s.id]?.exitMode ?? 'both', contractValue: d.market.contractValue, tickSize: d.market.tickSize });
    for (const t of bt.trades as any[]) {
      const side = t.entryAt < d.cut ? train : test;
      side.trades++; side.pnl += t.pnl;
      if (t.pnl > 0) side.gp += t.pnl; else side.gl -= t.pnl;
    }
  }
  return { train, test };
}

// fetch candles once; every scanner and every variant reuses them
const data = new Map<string, { bars: Bar[]; market: any; cut: number }>();
for (const symbol of SYMBOLS) {
  const p = await rest.product(symbol);
  const market = { contractValue: Number(p?.contract_value ?? 0.001), tickSize: Number(p?.tick_size ?? 0.5) };
  const c = await rest.recentCandles(symbol, TF, BARS, TF_SECONDS[TF]);
  const bars: Bar[] = c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
  data.set(symbol, { bars, market, cut: bars[Math.floor(bars.length * TRAIN_SHARE)].time });
}
const firstBars = [...data.values()][0].bars;
console.error(`tune: ${IDS.length} scanners · ${SYMBOLS.join(',')} ${TF} · ${firstBars.length} bars · train ${Math.round(TRAIN_SHARE * 100)}% / test ${Math.round((1 - TRAIN_SHARE) * 100)}%`);

interface Result { id: string; inputs: number; variants: number; def: { train: Split; test: Split }; best?: { change: string; train: Split; test: Split }; verdict: string }
const results: Result[] = [];

for (const id of IDS) {
  const s = registry.get(id);
  if (!s || s.status !== 'ok') { console.error(`  ${id}: not runnable, skipped`); continue; }
  const decls = parseInputs(s.source).filter(d => d.type === 'int' || d.type === 'float' || d.type === 'bool');
  const def = await evaluate(s, undefined, data);
  if (!def) { console.error(`  ${id}: default run failed`); continue; }

  let best: Result['best'];
  let variants = 0;
  for (const d of NO_TUNE ? [] : decls) {
    for (const v of candidates(d)) {
      if (variants >= MAX_VARIANTS) break;
      variants++;
      const r = await evaluate(s, { [d.name]: v }, data);
      if (!r || r.train.trades < MIN_TRAIN_TRADES) continue;
      // chosen on TRAIN only
      if (!best || r.train.pnl > best.train.pnl) best = { change: `${d.name}: ${d.default} → ${v}`, train: r.train, test: r.test };
    }
  }

  let verdict: string;
  if (def.train.trades < MIN_TRAIN_TRADES) verdict = 'too few trades to tune';
  else if (NO_TUNE) verdict = def.test.trades >= 5 && def.test.pnl > 0 && pf(def.test) >= 1.1 ? 'default PASSES out of sample' : def.test.pnl > 0 ? 'default positive OOS, weak' : 'default loses out of sample';
  else if (!best || best.train.pnl <= def.train.pnl) verdict = 'default already best in-sample';
  else if (best.test.pnl > def.test.pnl && best.test.pnl > 0) verdict = 'IMPROVED out of sample';
  else if (best.test.pnl > def.test.pnl) verdict = 'better OOS but still losing';
  else verdict = 'in-sample gain did not survive';
  results.push({ id, inputs: decls.length, variants, def, best, verdict });
  console.error(`  ${id}: ${verdict}`);
}
await pool.stop();

const pad = (x: string, n: number) => x.padEnd(n).slice(0, n);
const f = (s: Split) => `${String(s.trades).padStart(4)}t ${s.pnl.toFixed(0).padStart(6)} PF ${pf(s).toFixed(2).padStart(5)}`;
console.log(`\nTUNING · ${results.length} scanners · ${SYMBOLS.join(',')} ${TF}\n`);
console.log(`  ${pad('scanner', 38)} ${pad('default TEST', 24)} ${pad('tuned TEST', 24)} change / verdict`);
for (const r of results.sort((a, b) => ((b.best?.test.pnl ?? -1e9) - b.def.test.pnl) - ((a.best?.test.pnl ?? -1e9) - a.def.test.pnl))) {
  console.log(`  ${pad(r.id, 38)} ${pad(f(r.def.test), 24)} ${pad(r.best ? f(r.best.test) : '-', 24)} ${r.best ? r.best.change + '  ' : ''}[${r.verdict}]`);
}
const tally = (v: string) => results.filter(r => r.verdict === v).length;
const tuned = results.filter(r => r.best && r.best.train.pnl > r.def.train.pnl);
console.log(`\n  found an in-sample improvement:        ${tuned.length} of ${results.length}`);
console.log(`  of those, survived out of sample:       ${tally('IMPROVED out of sample')}`);
console.log(`  better OOS but still a losing scanner:  ${tally('better OOS but still losing')}`);
console.log(`  in-sample gain collapsed out of sample: ${tally('in-sample gain did not survive')}`);
console.log(`  default already best in-sample:         ${tally('default already best in-sample')}`);
console.log(`  too few trades to tune:                 ${tally('too few trades to tune')}`);
fs.writeFileSync('/tmp/tune-results.json', JSON.stringify(results, null, 1));
