/**
 * One-off paper screen: backtest every runnable scanner on the given markets under the account's
 * own policy (fees, stops, sizing at the configured purse), read exactly as the live path reads it
 * (decisions 85 and 195: same reading, rules and extraction as ValidationService.runPair).
 *
 *   node src/cli/paperScreen.ts SYMBOLS TF BARS OUT.jsonl [WORKERS]
 *
 * Results are appended per cell, so an interrupted run resumes where it stopped. Concurrency is
 * bounded: holding every job's bars at once is what exhausted the server's heap at warm-up.
 * Pass rule (per cell): >= 20 trades, profit factor >= 1.2 after fees, and positive net P&L in
 * each of three segments: the first and second half of the earliest 70% and the final 30%
 * holdout (>= 5 trades there). Diagnostic: it changes no configuration.
 */
import fs from 'node:fs';
import { DeltaRest, marketSpec } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { readingOf } from '../scanners/reading.ts';
import { runBacktest } from '../paper/backtest.ts';
import { backtestPolicy } from '../paper/policy.ts';
import { candleReplayBlock } from '../paper/basket.ts';
import { ConfigStore, TF_SECONDS, type ScannerConfig } from '../config.ts';

const [symArg, tf = '15m', barsArg = '4000', out = 'paper-screen.jsonl', workersArg] = process.argv.slice(2);
if (!symArg) { console.error('usage: paperScreen.ts SYMBOLS TF BARS OUT.jsonl [WORKERS]'); process.exit(2); }
const symbols = symArg.split(',');
const cfg = new ConfigStore().get();
const registry = new ScannerRegistry();
const rest = new DeltaRest();
const workers = Number(workersArg ?? 6);
const pool = new PinePool(workers, 180_000);
const tfMs = (TF_SECONDS[tf] ?? 0) * 1000;

const done = new Set<string>();
if (fs.existsSync(out)) for (const line of fs.readFileSync(out, 'utf8').split('\n')) { try { const r = JSON.parse(line); done.add(`${r.scannerId}|${r.symbol}`); } catch { /* partial line */ } }

const markets: Record<string, { info: ReturnType<typeof marketSpec>; bars: any[] }> = {};
for (const symbol of symbols) {
  const info = marketSpec(await rest.product(symbol));
  const candles = await rest.recentCandles(symbol, tf, Number(barsArg), TF_SECONDS[tf]);
  const bars = candles.slice(0, -1).map((c: any) => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
  markets[symbol] = { info, bars };
  console.log(`${symbol}: ${bars.length} bars from ${new Date(bars[0]?.time).toISOString()}`);
}

const limit = Number(process.env.LIMIT ?? 0);   // LIMIT=n: a quick trial on the first n scanners
const scanners = registry.runnable().filter(s => !candleReplayBlock(s.id)).slice(0, limit > 0 ? limit : undefined);
const jobs = symbols.flatMap(symbol => scanners.map(s => ({ s, symbol }))).filter(j => !done.has(`${j.s.id}|${j.symbol}`));
console.log(`${scanners.length} scanners × ${symbols.length} markets; ${done.size} cells already screened, ${jobs.length} to go, ${workers} workers`);

const stats = (ts: any[]) => {
  let pnl = 0, gp = 0, gl = 0, r = 0;
  for (const t of ts) { pnl += t.pnl; if (t.pnl > 0) gp += t.pnl; else gl -= t.pnl; r += t.rMultiple ?? 0; }
  return { trades: ts.length, pnl, pf: gl > 0 ? gp / gl : gp > 0 ? 99 : 0, avgR: ts.length ? r / ts.length : 0 };
};

let finished = 0, passed = 0;
const started = Date.now();
async function screen(s: ReturnType<ScannerRegistry['runnable']>[number], symbol: string) {
  const m = markets[symbol];
  const row: any = { scannerId: s.id, name: s.name, symbol, tf, bars: m.bars.length };
  try {
    const sc: ScannerConfig = cfg.scanners[s.id] ?? { enabled: false, symbols: null, timeframes: null, exitMode: 'both' };
    const rule = sc.rule ?? null;
    const res = await pool.run({ scannerId: s.id, source: s.patched, symbol, tf, tickSize: m.info.tickSize, bars: m.bars, tailBars: 'all', plotTail: rule ? m.bars.length : 10,
      inputs: sc.inputs && Object.keys(sc.inputs).length ? sc.inputs : undefined, timezone: sc.timezone }, { priority: 'background' });
    if (!res.ok) { row.error = String(res.error ?? 'script error').slice(0, 160); return row; }
    const READ = readingOf(sc, s.id, tfMs, s.patched, s.variantOf);
    const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule, bars: m.bars, mode: 'backtest', ...READ.rule });
    const events = extractEvents(res.alerts, res.shapes, { barMs: tfMs, drawn: res.labels, scannerId: s.id, derived, ...READ.extract });
    row.entries = events.filter(e => e.kind === 'entry').length;
    if (!row.entries) { row.silent = true; return row; }
    const policy = backtestPolicy(cfg, s.id, tf, 'account', { executor: false, productFees: m.info.productFees });
    const bt = runBacktest({ scannerId: s.id, scannerName: s.name, symbol, tf, bars: m.bars, events, ...policy, exitMode: sc.exitMode, contractValue: m.info.contractValue, tickSize: m.info.tickSize });
    const t0 = m.bars[0].time, span = m.bars.at(-1).time - t0, trainEnd = t0 + span * 0.7, mid = t0 + span * 0.35;
    const all = stats(bt.trades), seg = [stats(bt.trades.filter(t => t.entryAt < mid)), stats(bt.trades.filter(t => t.entryAt >= mid && t.entryAt < trainEnd)), stats(bt.trades.filter(t => t.entryAt >= trainEnd))];
    Object.assign(row, { trades: all.trades, pnl: all.pnl, pf: all.pf, avgR: all.avgR, maxDd: bt.stats.maxDrawdownPct, early: seg[0], middle: seg[1], holdout: seg[2], rejected: bt.rejected });
    row.pass = all.trades >= 20 && all.pf >= 1.2 && seg.every(x => x.pnl > 0) && seg[2].trades >= 5;
    return row;
  } catch (e: any) { row.error = String(e?.message ?? e).slice(0, 160); return row; }
}

// bounded: a few jobs per worker in flight, never the whole list at once
let next = 0;
await Promise.all(Array.from({ length: workers * 2 }, async () => {
  while (next < jobs.length) {
    const j = jobs[next++];
    const row = await screen(j.s, j.symbol);
    fs.appendFileSync(out, JSON.stringify(row) + '\n');
    finished++; if (row.pass) passed++;
    if (finished % 100 === 0) {
      const rate = finished / ((Date.now() - started) / 1000);
      console.log(`${finished}/${jobs.length} cells · ${passed} pass · ${rate.toFixed(1)} cells/s · ~${Math.round((jobs.length - finished) / rate / 60)} min left`);
    }
  }
}));
await pool.stop();
console.log(`done: ${finished} cells screened this run, ${passed} pass`);
