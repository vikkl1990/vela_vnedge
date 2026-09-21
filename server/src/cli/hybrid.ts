/**
 * Hybrid test: enter on 15m, let a higher timeframe decide when to leave.
 *
 *   npm run hybrid -- [ENTRY_TF] [DAYS]
 *
 * The fleet's edge is specific to 15m (decision 10), so this does not trade other timeframes. It
 * asks a narrower question: does a higher timeframe know when a 15m trade is finished?
 *
 * For each pair the entry scanner runs on 15m as usual. A 1h and a 4h trend are computed from
 * their own candles, and wherever that trend flips against an open position a synthetic exit event
 * is injected at the corresponding 15m bar. The paper engine then treats it exactly like a script
 * exit, so stops, targets and the trail all still apply — the higher timeframe only gets to end a
 * trade early, never to hold one past its stop.
 *
 * Trend is deliberately plain: close against an EMA of the same candles. A rule that only works
 * with a clever definition is a rule that is being fitted.
 */
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents, type ScanEvent } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';

const [entryTf = '15m', daysArg = '40'] = process.argv.slice(2);
const DAYS = Number(daysArg);
const WINDOWS = 8;

const cfg = new ConfigStore().get();
const registry = new ScannerRegistry();
const rest = new DeltaRest();

const pairs: Array<{ id: string; symbol: string; exitMode: 'levels' | 'script' | 'both' }> = [];
for (const s of registry.all()) {
  const sc = cfg.scanners[s.id];
  if (!sc?.enabled || sc.hidden || s.status !== 'ok') continue;
  for (const symbol of sc.symbols ?? cfg.symbols) pairs.push({ id: s.id, symbol, exitMode: sc.exitMode ?? 'both' });
}
if (!pairs.length) { console.error('no enabled scanner/symbol pairs'); process.exit(1); }

function ema(values: number[], len: number): number[] {
  const k = 2 / (len + 1);
  const out: number[] = [];
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) { prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k); out.push(prev); }
  return out;
}

/** +1 when the higher timeframe is above its EMA at that moment, −1 below, 0 before it is warm. */
function trendAt(htf: Bar[], len: number): Array<{ time: number; dir: number }> {
  const e = ema(htf.map(b => b.close), len);
  return htf.map((b, i) => ({ time: b.time, dir: i < len ? 0 : b.close > e[i] ? 1 : -1 }));
}

/**
 * Exit events for a 15m series, emitted at the first 15m bar that closes after a higher-timeframe
 * flip. Using the bar *after* the flip matters: the higher-timeframe candle has to finish before
 * its direction is known, and acting inside it would be reading the future.
 */
function htfExits(entryBars: Bar[], htf: Bar[], len: number, tfSec: number): ScanEvent[] {
  const trend = trendAt(htf, len);
  const out: ScanEvent[] = [];
  for (let i = 1; i < trend.length; i++) {
    if (trend[i].dir === 0 || trend[i].dir === trend[i - 1].dir) continue;
    const knownAt = trend[i].time + tfSec * 1000;               // the htf candle has closed
    const bar = entryBars.find(b => b.time >= knownAt);
    if (!bar) continue;
    // a flip down ends longs, a flip up ends shorts
    out.push({
      kind: 'exit', side: trend[i].dir === -1 ? 'long' : 'short', exitType: 'close', tp: [],
      label: 'htf-flip', message: `higher timeframe turned ${trend[i].dir === -1 ? 'down' : 'up'}`,
      source: 'derived', barTime: bar.time, barIndex: 0,
    } as ScanEvent);
  }
  return out;
}

interface Agg { trades: number; pnl: number; gp: number; gl: number; wins: number; r: number; bars: number; htfExits: number }
const blank = (): Agg => ({ trades: 0, pnl: 0, gp: 0, gl: 0, wins: 0, r: 0, bars: 0, htfExits: 0 });
const pf = (a: Agg) => (a.gl > 0 ? a.gp / a.gl : a.gp > 0 ? Infinity : 0);

type Variant = { name: string; htf?: string; len?: number };
const variants: Variant[] = [
  { name: 'live: 15m only' },
  { name: '+ 1h trend exit (EMA 20)', htf: '1h', len: 20 },
  { name: '+ 1h trend exit (EMA 50)', htf: '1h', len: 50 },
  { name: '+ 4h trend exit (EMA 20)', htf: '4h', len: 20 },
  { name: '+ 4h trend exit (EMA 50)', htf: '4h', len: 50 },
];

const pool = new PinePool(4, 300_000);
const totals = new Map<string, Agg>();
const windows = new Map<string, number[]>();
for (const v of variants) { totals.set(v.name, blank()); windows.set(v.name, new Array(WINDOWS).fill(0)); }

let done = 0;
for (const p of pairs) {
  try {
    const product = await rest.product(p.symbol);
    const market = { contractValue: Number(product?.contract_value ?? 0.001), tickSize: Number(product?.tick_size ?? 0.5) };
    const nBars = Math.min(5000, Math.floor((DAYS * 86400) / TF_SECONDS[entryTf]));
    const c = await rest.recentCandles(p.symbol, entryTf, nBars, TF_SECONDS[entryTf]);
    const bars: Bar[] = c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
    if (bars.length < 300) continue;

    const s = registry.get(p.id)!;
    const res = await pool.run({ scannerId: s.id, source: s.patched, symbol: p.symbol, tf: entryTf, tickSize: market.tickSize, bars, tailBars: 'all', plotTail: bars.length, inputs: cfg.scanners[p.id]?.inputs });
    if (!res.ok) continue;
    const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: cfg.scanners[p.id]?.rule ?? null, bars, mode: 'backtest' });
    const own = extractEvents(res.alerts, res.shapes, { derived });

    const htfCache = new Map<string, Bar[]>();
    for (const v of variants) {
      let events = own;
      if (v.htf) {
        if (!htfCache.has(v.htf)) {
          const hc = await rest.recentCandles(p.symbol, v.htf, Math.min(5000, Math.floor((DAYS * 86400) / TF_SECONDS[v.htf])), TF_SECONDS[v.htf]);
          htfCache.set(v.htf, hc.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume })));
        }
        const htf = htfCache.get(v.htf)!;
        if (htf.length < (v.len ?? 20) + 5) continue;
        const ex = htfExits(bars, htf, v.len ?? 20, TF_SECONDS[v.htf]);
        totals.get(v.name)!.htfExits += ex.length;
        events = [...own, ...ex].sort((a, b) => a.barTime - b.barTime);
      }
      // 'both' so the injected exits are honoured alongside stops, targets and the trail
      const bt = runBacktest({ scannerId: s.id, scannerName: s.id, symbol: p.symbol, tf: entryTf, bars, events, cfg: cfg.paper, exitMode: v.htf ? 'both' : p.exitMode, contractValue: market.contractValue, tickSize: market.tickSize });
      const a = totals.get(v.name)!;
      a.trades += bt.stats.trades; a.pnl += bt.stats.pnl; a.gp += bt.stats.grossProfit; a.gl += bt.stats.grossLoss;
      a.wins += (bt.trades as any[]).filter(t => t.pnl > 0).length;
      a.r += (bt.trades as any[]).reduce((x, t) => x + (t.rMultiple ?? 0), 0);
      a.bars += (bt.trades as any[]).reduce((x, t) => x + ((t.exitAt ?? t.entryAt) - t.entryAt) / (TF_SECONDS[entryTf] * 1000), 0);
      const size = Math.floor(bars.length / WINDOWS);
      const w = windows.get(v.name)!;
      for (let i = 0; i < WINDOWS; i++) {
        const from = bars[i * size]?.time ?? 0;
        const to = bars[Math.min(bars.length - 1, (i + 1) * size)]?.time ?? Infinity;
        w[i] += (bt.trades as any[]).filter(t => t.entryAt >= from && t.entryAt < to).reduce((x, t) => x + t.pnl, 0);
      }
    }
  } catch { /* skipped pair */ }
  if (++done % 5 === 0) console.error(`  ${done}/${pairs.length} pairs`);
}
await pool.stop();

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
console.log(`\nHYBRID: entries on ${entryTf}, exits helped by a higher timeframe · ${pairs.length} pairs · ${DAYS} days\n`);
console.log(`  ${pad('variant', 28)} ${'trades'.padStart(7)} ${'net'.padStart(8)} ${'PF'.padStart(6)} ${'win%'.padStart(5)} ${'avgR'.padStart(6)} ${'held'.padStart(6)} ${'htf exits'.padStart(10)}  windows up`);
for (const v of variants) {
  const a = totals.get(v.name)!;
  if (!a.trades) continue;
  const up = (windows.get(v.name) ?? []).filter(x => x > 0).length;
  console.log(`  ${pad(v.name, 28)} ${String(a.trades).padStart(7)} ${a.pnl.toFixed(0).padStart(8)} ${(Number.isFinite(pf(a)) ? pf(a).toFixed(2) : '∞').padStart(6)} ${(a.wins / a.trades * 100).toFixed(0).padStart(4)}% ${(a.r / a.trades).toFixed(2).padStart(6)} ${(a.bars / a.trades).toFixed(1).padStart(6)} ${String(a.htfExits).padStart(10)}  ${up}/${WINDOWS}`);
}
const base = totals.get(variants[0].name)!;
console.log('\n  per window, net:');
console.log(`  ${pad('variant', 28)} ${Array.from({ length: WINDOWS }, (_, i) => `w${i + 1}`.padStart(8)).join('')}`);
for (const v of variants) {
  const w = windows.get(v.name)!;
  if (!totals.get(v.name)!.trades) continue;
  console.log(`  ${pad(v.name, 28)} ${w.map(x => x.toFixed(0).padStart(8)).join('')}`);
}
console.log(`\n  baseline net ${base.pnl.toFixed(0)}; a variant is only interesting if it beats that in most windows, not in total.`);
