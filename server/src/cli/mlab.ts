/**
 * Does the model earn its place as an entry filter?
 *
 *   IDS=ids.txt TFS=15m,1h,4h MARKETS=… npm run mlab
 *
 * Trains a per-scanner model on the first half of the history and applies it as a filter to the
 * second half — the same halves discipline decisions 33 and 34 used. A model fitted and judged on the
 * same trades will always look good; this asks whether the probability it gives a trade it has never
 * seen is worth anything.
 *
 * For each threshold it reports what the filter keeps, what that does to R per trade, and what it
 * does to total R — because a filter that doubles R per trade while dropping 90% of trades has not
 * made money, it has just traded less.
 */
import fs from 'node:fs';
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import { trainLogReg, predict, type Sample } from '../ml/model.ts';
import type { Bar } from '../data/candleStore.ts';

const cfg = new ConfigStore().get();
if (process.env.PAPER) Object.assign(cfg.paper, JSON.parse(fs.readFileSync(process.env.PAPER, 'utf8')));
const ids = fs.readFileSync(process.env.IDS!, 'utf8').split(/\s+/).filter(Boolean);
const TFS = (process.env.TFS ?? '15m').split(',');
const MARKETS = (process.env.MARKETS ?? 'BTCUSD,ETHUSD').split(',');
const BARS: Record<string, number> = { '15m': 12000, '1h': 6000, '4h': 4000 };
const THRESHOLDS = (process.env.THRESHOLDS ?? '0.45,0.5,0.55,0.6,0.65').split(',').map(Number);

const registry = new ScannerRegistry();
const rest = new DeltaRest();
const pool = new PinePool(Number(process.env.CONCURRENCY ?? 7), 300_000);
const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));

/** Every backtest trade of one scanner on one timeframe, with the features it was opened on. */
const collected = new Map<string, Array<Sample & { rMultiple: number }>>();
for (const tf of TFS) {
  for (const id of ids) {
    const s = registry.get(id);
    if (!s || s.status !== 'ok') continue;
    for (const symbol of MARKETS) {
      try {
        const product = await rest.product(symbol);
        const market = { contractValue: Number(product?.contract_value ?? 0.001), tickSize: Number(product?.tick_size ?? 0.5) };
        const bars = toBars(await rest.recentCandles(symbol, tf, BARS[tf] ?? 4000, TF_SECONDS[tf]));
        if (bars.length < 500) continue;
        const res = await pool.run({ scannerId: s.id, source: s.patched, symbol, tf, tickSize: market.tickSize, bars, tailBars: 'all', plotTail: bars.length });
        if (!res.ok) continue;
        const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: null, bars, mode: 'backtest' });
        const events = extractEvents(res.alerts, res.shapes, { derived });
        const bt = runBacktest({ scannerId: s.id, scannerName: s.id, symbol, tf, bars, events, cfg: cfg.paper, exitMode: 'both', contractValue: market.contractValue, tickSize: market.tickSize });
        const key = `${id}|${tf}`;
        const list = collected.get(key) ?? [];
        for (const t of bt.trades as any[]) {
          if (!t.features) continue;
          list.push({ scannerId: id, symbol, tf, at: t.entryAt, features: t.features, win: t.pnl > 0 ? 1 : 0, r: t.rMultiple ?? 0, pnl: t.pnl, exitReason: String(t.exitReason ?? ''), bt: true, rMultiple: t.rMultiple ?? 0 });
        }
        collected.set(key, list);
      } catch (e: any) { console.error(`  ${id}/${symbol}/${tf}: ${e?.message ?? e}`); }
    }
    console.error(`  collected ${id} ${tf}: ${collected.get(`${id}|${tf}`)?.length ?? 0} trades`);
  }
}

console.log(`\n${'scanner × tf'.padEnd(46)} ${'train'.padStart(6)} ${'test'.padStart(6)} ${'test R/trade'.padStart(12)}   filter results (kept · R/trade · total R)`);
for (const [key, all] of collected) {
  if (all.length < 120) { console.log(`${key.padEnd(46)} ${String(all.length).padStart(6)}   too few trades to train`); continue; }
  const sorted = [...all].sort((a, b) => a.at - b.at);
  const cut = Math.floor(sorted.length / 2);
  const train = sorted.slice(0, cut), test = sorted.slice(cut);
  const model = trainLogReg(train, {});
  if (!model) { console.log(`${key.padEnd(46)} ${String(train.length).padStart(6)}   model did not fit`); continue; }
  const baseR = test.reduce((a, t) => a + t.rMultiple, 0) / test.length;
  const parts: string[] = [];
  for (const th of THRESHOLDS) {
    const kept = test.filter(t => predict(model, t.features) >= th);
    const r = kept.length ? kept.reduce((a, t) => a + t.rMultiple, 0) / kept.length : 0;
    parts.push(`${th}: ${Math.round(kept.length / test.length * 100)}% ${r >= 0 ? '+' : ''}${r.toFixed(3)}R ${(r * kept.length).toFixed(0)}R`);
  }
  console.log(`${key.padEnd(46)} ${String(train.length).padStart(6)} ${String(test.length).padStart(6)} ${baseR >= 0 ? '+' : ''}${baseR.toFixed(3)}R (${(baseR * test.length).toFixed(0)}R)   ${parts.join(' | ')}`);
}
await pool.stop();
process.exit(0);
