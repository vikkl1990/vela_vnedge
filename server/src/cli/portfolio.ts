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
import { trendSide } from '../paper/logic.ts';
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

/** Per-symbol trend of the signal timeframe, indexed by bar time, for the engine's trend exit. */
const trendBySymbol = new Map<string, Array<{ at: number; side: 1 | -1 }>>();
function buildTrends(len: number) {
  trendBySymbol.clear();
  for (const s2 of signals) {
    if (trendBySymbol.has(s2.pair.symbol)) continue;
    const closes = s2.bars.map(b => b.close);
    const series: Array<{ at: number; side: 1 | -1 }> = [];
    const k = 2 / (len + 1);
    let ema = closes[0] ?? 0;
    s2.bars.forEach((b, i) => { ema = i ? b.close * k + ema * (1 - k) : b.close; series.push({ at: b.time + tfMs, side: b.close >= ema ? 1 : -1 }); });
    trendBySymbol.set(s2.pair.symbol, series);
  }
}

function run(name: string, paper: PaperConfig, perPair = false, from = 0) {
  const db = new Db(':memory:' as any);
  const cfg: AppConfig = { ...base, paper };
  const engine = new PaperEngine(db, () => cfg);
  engine.atrFor = () => undefined;
  let nowMs = 0;
  engine.trendFor = (symbol: string) => {
    const series = trendBySymbol.get(symbol);
    if (!series?.length) return undefined;
    let lo = 0, hi = series.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (series[mid].at <= nowMs) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    return found >= 0 ? series[found].side : undefined;
  };
  let si = 0, rejected = 0, opened = 0;
  const equity: number[] = [];
  for (const m of minutes) {
    while (si < signals.length && signals[si].at <= m.at) {
      const s = signals[si++];
      const refPrice = engine.mark(s.pair.symbol) ?? s.ev.price ?? 0;
      if (s.at < from) continue;
      if (s.ev.kind === 'entry' && s.ev.side) {
        const ev = perPair ? perPairEvent(s) : s.ev;
        const d = engine.onEntry(ev, { scannerId: s.pair.id, scannerName: s.pair.id, symbol: s.pair.symbol, tf: TF, market: s.market, atr: s.atr, refPrice: refPrice || (s.ev.price ?? 0), at: s.at, signalId: null, exitMode: s.pair.exitMode ?? 'both' });
        if (d.action === 'opened' || d.action === 'reversed') opened++; else rejected++;
      } else if (s.ev.kind === 'exit') {
        engine.onScriptExit(s.pair.id, s.pair.symbol, TF, s.ev.exitType ?? 'close', s.ev.price, s.at, s.pair.exitMode ?? 'both', s.ev.side);
      }
    }
    nowMs = m.at;
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

// ---- per-pair targets, learned on the first half of the span only ----
// "Realistic" cannot be one number: one pair reaches 6R on a third of its entries, another never
// passes 1R. For each pair the ceiling is set to the level its own past reaches 60% of the time,
// learned on the first half of the data and applied to the second, so it is not fitted to itself.
const half = signals.length ? signals[Math.floor(signals.length / 2)].at : 0;
const reach = new Map<string, number[]>();
for (const s2 of signals) {
  if (s2.ev.kind !== 'entry' || !s2.ev.side || s2.at >= half) continue;
  const bars1 = m1.get(s2.pair.symbol) ?? [];
  const dir = s2.ev.side === 'long' ? 1 : -1;
  const price = s2.ev.price && s2.ev.price > 0 ? s2.ev.price : s2.bars.find(b => b.time === s2.barTime)?.close ?? 0;
  const sl = s2.ev.sl && s2.ev.sl > 0 ? s2.ev.sl : price - dir * (base.paper.fallbackAtrSl ?? 1.5) * (s2.atr ?? 0);
  const risk = Math.abs(price - sl);
  if (!(risk > 0) || !(price > 0)) continue;
  let peak = 0;
  for (const b of bars1) {
    if (b.time < s2.at || b.time > s2.at + 24 * 3600_000) continue;
    if (((dir === 1 ? b.low : b.high) - price) * dir / risk <= -1) break;
    peak = Math.max(peak, ((dir === 1 ? b.high : b.low) - price) * dir / risk);
  }
  const k = `${s2.pair.id}|${s2.pair.symbol}`;
  reach.set(k, [...(reach.get(k) ?? []), peak]);
}
const pairTarget = new Map<string, number>();
for (const [k, peaks] of reach) {
  if (peaks.length < 10) continue;
  const sorted = [...peaks].sort((a, b) => a - b);
  const p60 = sorted[Math.floor(sorted.length * 0.4)];        // reached by 60% of entries
  pairTarget.set(k, Math.min(6, Math.max(1.5, Math.round(p60 * 2) / 2)));
}
console.error(`  per-pair ceilings from the first half: ${[...pairTarget].map(([k, v]) => `${k.split('|')[0].slice(0, 12)} ${k.split('|')[1]} ${v}R`).join(' · ') || 'not enough history'}`);

const variants: Array<[string, Partial<PaperConfig>]> = [
  ['live: targets 2/4/6 R', {}],
  ['targets 1/2/3 R', { fallbackRR: [1, 2, 3] }],
  ['targets 1.5/3/4.5 R', { fallbackRR: [1.5, 3, 4.5] }],
  ['targets 2/3/4 R', { fallbackRR: [2, 3, 4] }],
  ['live targets, half off at TP1', { tpSplit: [0.5, 0, 0.5] }],
  ['targets 1/2/3 R, half at TP1', { fallbackRR: [1, 2, 3], tpSplit: [0.5, 0, 0.5] }],
  ['targets 2/3/4 R, thirds', { fallbackRR: [2, 3, 4], tpSplit: [0.34, 0.33, 0.33] }],
];
/** Rewrite an entry's targets to this pair's learned ceiling (halves/whole of it), leaving the stop alone. */
function perPairEvent(s2: Signal): ScanEvent {
  const t = pairTarget.get(`${s2.pair.id}|${s2.pair.symbol}`);
  if (!t || s2.ev.kind !== 'entry' || !s2.ev.side || (s2.ev.tp?.length ?? 0) > 0) return s2.ev;
  const dir = s2.ev.side === 'long' ? 1 : -1;
  const price = s2.ev.price && s2.ev.price > 0 ? s2.ev.price : s2.bars.find(b => b.time === s2.barTime)?.close ?? 0;
  const sl = s2.ev.sl && s2.ev.sl > 0 ? s2.ev.sl : price - dir * (base.paper.fallbackAtrSl ?? 1.5) * (s2.atr ?? 0);
  const risk = Math.abs(price - sl);
  if (!(risk > 0)) return s2.ev;
  return { ...s2.ev, tp: [t / 2, t * 0.75, t].map(r => price + dir * r * risk) };
}
console.log(`\nPORTFOLIO REPLAY · one account, ${pairs.length} pairs · ${TF} · ${signals.length} signals · $${base.paper.initialEquity} start, max ${base.paper.maxOpenPositions} open\n`);
console.log(`  ${'target policy'.padEnd(30)} ${'entries'.padStart(8)} ${'blocked'.padStart(8)} ${'trades'.padStart(7)} ${'win%'.padStart(5)} ${'net $'.padStart(9)} ${'PF'.padStart(6)} ${'max DD'.padStart(7)} ${'end equity'.padStart(11)}`);
for (const [name, patch] of variants) {
  const r = run(name, { ...base.paper, ...patch });
  console.log(`  ${name.padEnd(30)} ${String(r.opened).padStart(8)} ${String(r.rejected).padStart(8)} ${String(r.trades).padStart(7)} ${r.winRate.toFixed(0).padStart(4)}% ${r.pnl.toFixed(0).padStart(9)} ${(r.pf ?? 0).toFixed(2).padStart(6)} ${r.maxDd.toFixed(1).padStart(6)}% ${r.equity.toFixed(0).padStart(11)}`);
}
{
  const r = run('per-pair ceiling (learned)', base.paper, true);
  console.log(`  ${'per-pair ceiling (learned)'.padEnd(30)} ${String(r.opened).padStart(8)} ${String(r.rejected).padStart(8)} ${String(r.trades).padStart(7)} ${r.winRate.toFixed(0).padStart(4)}% ${r.pnl.toFixed(0).padStart(9)} ${(r.pf ?? 0).toFixed(2).padStart(6)} ${r.maxDd.toFixed(1).padStart(6)}% ${r.equity.toFixed(0).padStart(11)}`);
}
buildTrends(20);
for (const [label, patch] of [
  ['+ trend exit above 1R (EMA 20)', { trendExit: { enabled: true, emaLen: 20, minR: 1 } }],
  ['+ trend exit above 1.25R', { trendExit: { enabled: true, emaLen: 20, minR: 1.25 } }],
] as Array<[string, Partial<PaperConfig>]>) {
  const r = run(label, { ...base.paper, ...patch });
  console.log(`  ${label.padEnd(30)} ${String(r.opened).padStart(8)} ${String(r.rejected).padStart(8)} ${String(r.trades).padStart(7)} ${r.winRate.toFixed(0).padStart(4)}% ${r.pnl.toFixed(0).padStart(9)} ${(r.pf ?? 0).toFixed(2).padStart(6)} ${r.maxDd.toFixed(1).padStart(6)}% ${r.equity.toFixed(0).padStart(11)}`);
}
buildTrends(10);
{
  const r = run('+ trend exit above 1R (EMA 10)', { ...base.paper, trendExit: { enabled: true, emaLen: 10, minR: 1 } });
  console.log(`  ${'+ trend exit above 1R (EMA 10)'.padEnd(30)} ${String(r.opened).padStart(8)} ${String(r.rejected).padStart(8)} ${String(r.trades).padStart(7)} ${r.winRate.toFixed(0).padStart(4)}% ${r.pnl.toFixed(0).padStart(9)} ${(r.pf ?? 0).toFixed(2).padStart(6)} ${r.maxDd.toFixed(1).padStart(6)}% ${r.equity.toFixed(0).padStart(11)}`);
}
buildTrends(20);
console.log('\n  second half only (the per-pair ceilings were learned on the first half):');
for (const [name, patch] of [...variants, ['per-pair ceiling (learned)', {}] as [string, Partial<PaperConfig>]]) {
  const isPer = name.startsWith('per-pair');
  const r = run(name, { ...base.paper, ...patch }, isPer, half);
  console.log(`  ${name.padEnd(30)} ${String(r.trades).padStart(7)} trades ${r.pnl.toFixed(0).padStart(9)} net $ ${(r.pf ?? 0).toFixed(2).padStart(6)} PF`);
}
console.log('\n  "blocked" counts signals the account could not take: margin already committed, or the position cap.');
