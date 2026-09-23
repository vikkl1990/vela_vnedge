/**
 * Replay the whole fleet on ONE account, the way the live bot trades it.
 *
 *   PAIRS=pairs.json PAPER=vm.json npm run portfolio -- [BARS] [TF]
 *
 * Every other test here measures a pair on its own purse and reports R, which hides what a shared
 * account feels: margin held by one trade is margin another signal cannot use, and `maxOpenPositions`
 * is a queue. A distant target keeps capital committed for hours, so a target that looks harmless in
 * R can still cost money in dollars. This runs the real paper engine — same sizing, margin,
 * liquidation, fees, Scalper Offer and exit rules — over every pair's signals in one timeline, and
 * compares target policies by what the account ends with.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Db } from '../db.ts';
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents, type ScanEvent } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { PaperEngine } from '../paper/engine.ts';
import { ConfigStore, TF_SECONDS, type AppConfig, type PaperConfig } from '../config.ts';
import { lastAtr } from '../data/indicators.ts';
import type { Bar } from '../data/candleStore.ts';

const [barsArg = '4000', tfArg = '15m'] = process.argv.slice(2);
const TF = tfArg, tfMs = TF_SECONDS[TF] * 1000;
const base = new ConfigStore().get();
if (process.env.PAPER) Object.assign(base.paper, JSON.parse(fs.readFileSync(process.env.PAPER, 'utf8')));
const pairs: any[] = JSON.parse(fs.readFileSync(process.env.PAIRS!, 'utf8'));
const registry = new ScannerRegistry();
const rest = new DeltaRest();
const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));

// ---- collect every pair's signals once ----
interface Signal { at: number; barTime: number; pair: any; ev: ScanEvent; bars: Bar[]; atr: number | undefined; market: { contractValue: number; tickSize: number } }
const signals: Signal[] = [];
const m1 = new Map<string, Bar[]>();
const markets = new Map<string, { contractValue: number; tickSize: number }>();
const pool = new PinePool(6, 300_000);
for (const p of pairs) {
  const s = registry.get(p.id);
  if (!s || s.status !== 'ok') continue;
  const product = await rest.product(p.symbol);
  const market = { contractValue: Number(product?.contract_value ?? 0.001), tickSize: Number(product?.tick_size ?? 0.5) };
  markets.set(p.symbol, market);
  const bars = toBars(await rest.recentCandles(p.symbol, TF, Number(barsArg), TF_SECONDS[TF]));
  if (bars.length < 300) continue;
  if (!m1.has(p.symbol)) m1.set(p.symbol, toBars(await rest.recentCandles(p.symbol, '1m', Math.ceil((bars.length + 2) * tfMs / 60_000), 60)));
  const res = await pool.run({ scannerId: s.id, source: s.patched, symbol: p.symbol, tf: TF, tickSize: market.tickSize, bars, tailBars: 'all', plotTail: bars.length, inputs: p.inputs });
  if (!res.ok) { console.error(`  ${p.id}/${p.symbol}: ${res.error}`); continue; }
  const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: p.rule ?? null, bars, mode: 'backtest' });
  const idx = new Map(bars.map((b, i) => [b.time, i]));
  for (const ev of extractEvents(res.alerts, res.shapes, { derived })) {
    const i = idx.get(ev.barTime);
    if (i === undefined) continue;
    // a signal is actionable at its bar's close, like live
    signals.push({ at: ev.barTime + tfMs, barTime: ev.barTime, pair: p, ev, bars, atr: lastAtr(bars.slice(0, i + 1), 14), market });
  }
  console.error(`  ${p.id}/${p.symbol}: ${bars.length} bars`);
}
await pool.stop();
signals.sort((a, b) => a.at - b.at);

// ---- one timeline: 1m bars for exits, signals at their bar close ----
const minutes: Array<{ at: number; symbol: string; bar: Bar }> = [];
for (const [symbol, bars] of m1) for (const b of bars) minutes.push({ at: b.time + 60_000, symbol, bar: b });
minutes.sort((a, b) => a.at - b.at);

function run(name: string, paper: PaperConfig) {
  const db = new Db(':memory:' as any);
  const cfg: AppConfig = { ...base, paper };
  const engine = new PaperEngine(db, () => cfg);
  engine.atrFor = () => undefined;
  let si = 0, rejected = 0, opened = 0;
  const equity: number[] = [];
  for (const m of minutes) {
    while (si < signals.length && signals[si].at <= m.at) {
      const s = signals[si++];
      const refPrice = engine.mark(s.pair.symbol) ?? s.ev.price ?? 0;
      if (s.ev.kind === 'entry' && s.ev.side) {
        const d = engine.onEntry(s.ev, { scannerId: s.pair.id, scannerName: s.pair.id, symbol: s.pair.symbol, tf: TF, market: s.market, atr: s.atr, refPrice: refPrice || (s.ev.price ?? 0), at: s.at, signalId: null, exitMode: s.pair.exitMode ?? 'both' });
        if (d.action === 'opened' || d.action === 'reversed') opened++; else rejected++;
      } else if (s.ev.kind === 'exit') {
        engine.onScriptExit(s.pair.id, s.pair.symbol, TF, s.ev.exitType ?? 'close', s.ev.price, s.at, s.pair.exitMode ?? 'both', s.ev.side);
      }
    }
    engine.onBar(m.symbol, m.bar, m.at, { historical: false });
    equity.push(engine.equity());
  }
  const stats = engine.stats();
  let peak = -Infinity, dd = 0;
  for (const e of equity) { peak = Math.max(peak, e); dd = Math.max(dd, (peak - e) / peak * 100); }
  const out = { name, opened, rejected, trades: stats.trades, winRate: stats.winRatePct, pnl: stats.realizedPnl, pf: stats.profitFactor, maxDd: dd, equity: engine.equity() };
  (db as any).db?.close?.();
  return out;
}

const variants: Array<[string, Partial<PaperConfig>]> = [
  ['live: targets 2/4/6 R', {}],
  ['targets 1/2/3 R', { fallbackRR: [1, 2, 3] }],
  ['targets 1.5/3/4.5 R', { fallbackRR: [1.5, 3, 4.5] }],
  ['targets 2/3/4 R', { fallbackRR: [2, 3, 4] }],
  ['live targets, half off at TP1', { tpSplit: [0.5, 0, 0.5] }],
  ['targets 1/2/3 R, half at TP1', { fallbackRR: [1, 2, 3], tpSplit: [0.5, 0, 0.5] }],
  ['targets 2/3/4 R, thirds', { fallbackRR: [2, 3, 4], tpSplit: [0.34, 0.33, 0.33] }],
];
console.log(`\nPORTFOLIO REPLAY · one account, ${pairs.length} pairs · ${TF} · ${signals.length} signals · $${base.paper.initialEquity} start, max ${base.paper.maxOpenPositions} open\n`);
console.log(`  ${'target policy'.padEnd(30)} ${'entries'.padStart(8)} ${'blocked'.padStart(8)} ${'trades'.padStart(7)} ${'win%'.padStart(5)} ${'net $'.padStart(9)} ${'PF'.padStart(6)} ${'max DD'.padStart(7)} ${'end equity'.padStart(11)}`);
for (const [name, patch] of variants) {
  const r = run(name, { ...base.paper, ...patch });
  console.log(`  ${name.padEnd(30)} ${String(r.opened).padStart(8)} ${String(r.rejected).padStart(8)} ${String(r.trades).padStart(7)} ${r.winRate.toFixed(0).padStart(4)}% ${r.pnl.toFixed(0).padStart(9)} ${(r.pf ?? 0).toFixed(2).padStart(6)} ${r.maxDd.toFixed(1).padStart(6)}% ${r.equity.toFixed(0).padStart(11)}`);
}
console.log('\n  "blocked" counts signals the account could not take: margin already committed, or the position cap.');
