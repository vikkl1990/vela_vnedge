/**
 * Does the fleet's edge exist on other timeframes?
 *
 *   npm run timeframes -- [TFS] [DAYS]
 *
 * Every enabled scanner/symbol pair is run at each timeframe over the same calendar span, so the
 * comparison is like for like rather than like-for-bar-count. Bars are derived from the span, and
 * each timeframe reports the fleet total the way the walk-forward does.
 *
 * This only measures; it changes no configuration. Timeframes other than the live one have never
 * been through the out-of-sample gate, so a good number here is a candidate, not a decision.
 */
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';

const [tfArg = '5m,15m,1h,4h', daysArg = '40'] = process.argv.slice(2);
const TFS = tfArg.split(',').map(s => s.trim()).filter(t => t in TF_SECONDS);
const DAYS = Number(daysArg);
const WINDOWS = 8;

const cfg = new ConfigStore().get();
const registry = new ScannerRegistry();
const rest = new DeltaRest();

/** The scanner/symbol pairs the bot actually trades, regardless of their configured timeframe. */
const pairs: Array<{ id: string; symbol: string; exitMode: 'levels' | 'script' | 'both' }> = [];
for (const s of registry.all()) {
  const sc = cfg.scanners[s.id];
  if (!sc?.enabled || sc.hidden || s.status !== 'ok') continue;
  for (const symbol of sc.symbols ?? cfg.symbols) pairs.push({ id: s.id, symbol, exitMode: sc.exitMode ?? 'both' });
}
if (!pairs.length) { console.error('no enabled scanner/symbol pairs'); process.exit(1); }

interface Agg { trades: number; pnl: number; gp: number; gl: number; wins: number; r: number; bars: number; pairs: number; errors: number }
const blank = (): Agg => ({ trades: 0, pnl: 0, gp: 0, gl: 0, wins: 0, r: 0, bars: 0, pairs: 0, errors: 0 });
const pf = (a: Agg) => (a.gl > 0 ? a.gp / a.gl : a.gp > 0 ? Infinity : 0);

const pool = new PinePool(4, 300_000);
const totals = new Map<string, Agg>();
const perWindow = new Map<string, number[]>();
const perPair = new Map<string, Map<string, number>>();

for (const tf of TFS) {
  const bars = Math.min(5000, Math.floor((DAYS * 86400) / TF_SECONDS[tf]));
  const acc = blank();
  const wins = new Array(WINDOWS).fill(0);
  let done = 0;
  for (const p of pairs) {
    try {
      const product = await rest.product(p.symbol);
      const market = { contractValue: Number(product?.contract_value ?? 0.001), tickSize: Number(product?.tick_size ?? 0.5) };
      const candles = await rest.recentCandles(p.symbol, tf, bars, TF_SECONDS[tf]);
      const series: Bar[] = candles.slice(0, -1).map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
      if (series.length < 200) { acc.errors++; continue; }
      const s = registry.get(p.id)!;
      const res = await pool.run({ scannerId: s.id, source: s.patched, symbol: p.symbol, tf, tickSize: market.tickSize, bars: series, tailBars: 'all', plotTail: series.length, inputs: cfg.scanners[p.id]?.inputs });
      if (!res.ok) { acc.errors++; continue; }
      const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: cfg.scanners[p.id]?.rule ?? null, bars: series, mode: 'backtest' });
      const events = extractEvents(res.alerts, res.shapes, { derived });
      const bt = runBacktest({ scannerId: s.id, scannerName: s.id, symbol: p.symbol, tf, bars: series, events, cfg: cfg.paper, exitMode: p.exitMode, contractValue: market.contractValue, tickSize: market.tickSize });
      acc.trades += bt.stats.trades; acc.pnl += bt.stats.pnl; acc.gp += bt.stats.grossProfit; acc.gl += bt.stats.grossLoss;
      acc.wins += (bt.trades as any[]).filter(t => t.pnl > 0).length;
      acc.r += (bt.trades as any[]).reduce((x, t) => x + (t.rMultiple ?? 0), 0);
      acc.bars += series.length; acc.pairs++;
      const key = `${p.id}:${p.symbol}`;
      if (!perPair.has(key)) perPair.set(key, new Map());
      perPair.get(key)!.set(tf, bt.stats.pnl);
      // window split for consistency, same idea as the exits harness
      const size = Math.floor(series.length / WINDOWS);
      for (let w = 0; w < WINDOWS; w++) {
        const from = series[w * size]?.time ?? 0;
        const to = series[Math.min(series.length - 1, (w + 1) * size)]?.time ?? Infinity;
        wins[w] += (bt.trades as any[]).filter(t => t.entryAt >= from && t.entryAt < to).reduce((x, t) => x + t.pnl, 0);
      }
    } catch { acc.errors++; }
    if (++done % 5 === 0) console.error(`  ${tf}: ${done}/${pairs.length}`);
  }
  totals.set(tf, acc);
  perWindow.set(tf, wins);
  console.error(`${tf} done`);
}
await pool.stop();

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
console.log(`\n${pairs.length} live scanner/symbol pairs · ${DAYS} days of history · ${WINDOWS} windows\n`);
console.log('TIMEFRAME COMPARISON — the same pairs, the same span, the same exit policy');
console.log(`  ${pad('tf', 6)} ${'pairs'.padStart(5)} ${'trades'.padStart(7)} ${'net'.padStart(8)} ${'PF'.padStart(6)} ${'win%'.padStart(5)} ${'avgR'.padStart(6)} ${'trades/day'.padStart(11)}  windows up`);
for (const tf of TFS) {
  const a = totals.get(tf); if (!a) continue;
  const up = (perWindow.get(tf) ?? []).filter(v => v > 0).length;
  const perDay = DAYS > 0 ? a.trades / DAYS : 0;
  console.log(`  ${pad(tf, 6)} ${String(a.pairs).padStart(5)} ${String(a.trades).padStart(7)} ${a.pnl.toFixed(0).padStart(8)} ${(Number.isFinite(pf(a)) ? pf(a).toFixed(2) : '∞').padStart(6)} ${(a.trades ? a.wins / a.trades * 100 : 0).toFixed(0).padStart(4)}% ${(a.trades ? a.r / a.trades : 0).toFixed(2).padStart(6)} ${perDay.toFixed(1).padStart(11)}  ${up}/${WINDOWS}${a.errors ? `   (${a.errors} pairs failed)` : ''}`);
}

console.log('\nPER PAIR — net by timeframe, worst live-timeframe pairs first');
const rows = [...perPair.entries()].map(([k, m]) => ({ k, m, live: m.get('15m') ?? 0 })).sort((a, b) => a.live - b.live);
console.log(`  ${pad('pair', 46)} ${TFS.map(t => t.padStart(9)).join('')}`);
for (const r of rows.slice(0, 20)) {
  console.log(`  ${pad(r.k, 46)} ${TFS.map(t => (r.m.has(t) ? r.m.get(t)!.toFixed(0) : '-').padStart(9)).join('')}`);
}
console.log('\nA timeframe other than the live one has never been through the out-of-sample gate.');
console.log('Read a good number here as a candidate for the review, not as a decision.');
