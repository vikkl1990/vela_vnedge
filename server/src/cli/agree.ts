/**
 * Agreement test (decision 89): the one use of a large script library that many separate traders cannot make.
 * For each (market, timeframe) cell, every scanner in IDS is run once; then, beside each scanner's own entries,
 * an "agreement" entry series is built: an entry on bar t, side s, when at least K distinct scanners raised an
 * entry of side s within the last WINDOW bars (taken at the bar of the K-th scanner, so nothing is known early).
 * Everything is replayed under the live settings (efficiency gate, 1.5×ATR stop from the paper config given).
 *
 *   IDS=ids.txt TFS=1h MARKETS=BTCUSD,ETHUSD K=2,3 WINDOW=2 PAPER=paper.json OUT=agree.tsv CONCURRENCY=2 npm run agree
 */
import fs from 'node:fs';
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents, type ScanEvent } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest, type BacktestInput } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';

const cfg = new ConfigStore().get();
if (process.env.PAPER) Object.assign(cfg.paper, JSON.parse(fs.readFileSync(process.env.PAPER, 'utf8')));
const ids = [...new Set(fs.readFileSync(process.env.IDS!, 'utf8').split(/\s+/).filter(Boolean))];
const TFS = (process.env.TFS ?? '1h').split(',');
const MARKETS = (process.env.MARKETS ?? 'BTCUSD,ETHUSD').split(',');
const KS = (process.env.K ?? '2,3').split(',').map(Number);
const WINDOW = Number(process.env.WINDOW ?? 2);
const MIN_ER = Number(process.env.MIN_ER ?? 0.25);
const BARS: Record<string, number> = { '5m': 4000, '15m': 8000, '1h': 4000, '4h': 2000 };
const rest = new DeltaRest();
const registry = new ScannerRegistry();
const pool = new PinePool(Number(process.env.CONCURRENCY ?? 2), 120_000);
const out = fs.createWriteStream(process.env.OUT ?? '/tmp/agree.tsv');
out.write(['tf', 'symbol', 'variant', 'scanners', 'trades', 'avgR', 'sumR', 'win', 't1', 'r1', 't2', 'r2', 'both', 'firstBarStops'].join('\t') + '\n');

const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
const market = new Map<string, { contractValue: number; tickSize: number }>();
for (const s of MARKETS) { const p = await rest.product(s); market.set(s, { contractValue: Number(p?.contract_value ?? 0.001), tickSize: Number(p?.tick_size ?? 0.5) }); }

type Stat = { trades: number; avgR: number; sumR: number; win: number; t1: number; r1: number; t2: number; r2: number; both: boolean; firstBar: number };
function stat(trades: any[], b: Bar[], tfMs: number): Stat {
  const R = (xs: any[]) => (xs.length ? xs.reduce((a, x) => a + (x.rMultiple ?? 0), 0) / xs.length : 0);
  const split = b[Math.floor(b.length / 2)].time;
  const h1 = trades.filter(x => x.entryAt < split), h2 = trades.filter(x => x.entryAt >= split);
  const fb = trades.filter(x => x.exitReason === 'sl' && x.exitAt - x.entryAt <= tfMs * 2).length;
  return { trades: trades.length, avgR: R(trades), sumR: R(trades) * trades.length, win: trades.length ? trades.filter(x => x.pnl > 0).length / trades.length : 0, t1: h1.length, r1: R(h1), t2: h2.length, r2: R(h2), both: h1.length >= 5 && h2.length >= 5 && R(h1) > 0 && R(h2) > 0, firstBar: trades.length ? fb / trades.length : 0 };
}
const row = (tf: string, sym: string, v: string, scanners: string, s: Stat) => out.write([tf, sym, v, scanners, s.trades, s.avgR.toFixed(3), s.sumR.toFixed(1), s.win.toFixed(2), s.t1, s.r1.toFixed(3), s.t2, s.r2.toFixed(3), s.both ? 1 : 0, s.firstBar.toFixed(2)].join('\t') + '\n');

/** Entries on bar t, side s, when at least k distinct scanners fired side s within the last `window` bars, dated at the k-th firing. */
function agreement(per: Map<string, ScanEvent[]>, bars: Bar[], k: number, window: number): ScanEvent[] {
  const idx = new Map<number, number>(); bars.forEach((b, i) => idx.set(b.time, i));
  const firings: Array<{ i: number; side: 'long' | 'short'; id: string; ev: ScanEvent }> = [];
  for (const [id, evs] of per) for (const e of evs) if (e.kind === 'entry' && e.side && idx.has(e.barTime)) firings.push({ i: idx.get(e.barTime)!, side: e.side, id, ev: e });
  firings.sort((a, b) => a.i - b.i);
  const outEvs: ScanEvent[] = []; const taken = new Set<string>();
  for (let n = 0; n < firings.length; n++) {
    const f = firings[n];
    const agreeing = new Set<string>();
    for (let m = n; m >= 0 && firings[m].i >= f.i - window; m--) if (firings[m].side === f.side) agreeing.add(firings[m].id);
    if (agreeing.size < k) continue;
    const key = `${f.i}:${f.side}`; if (taken.has(key)) continue; taken.add(key);
    outEvs.push({ ...f.ev, sl: undefined, tp: [], price: undefined, label: `agree${k}: ${[...agreeing].slice(0, 4).join(',')}` });
  }
  return outEvs;
}

for (const sym of MARKETS) for (const tf of TFS) {
  const b = toBars(await rest.recentCandles(sym, tf, BARS[tf], TF_SECONDS[tf]));
  const m = market.get(sym)!; const tfMs = TF_SECONDS[tf] * 1000;
  const per = new Map<string, ScanEvent[]>();
  for (const id of ids) {
    const s = registry.get(id); if (!s || s.status !== 'ok') continue;
    const sc = cfg.scanners[id] ?? {};
    const res = await pool.run({ scannerId: id, source: s.patched, symbol: sym, tf, tickSize: m.tickSize, bars: b, tailBars: 'all', plotTail: b.length, inputs: sc.inputs && Object.keys(sc.inputs).length ? sc.inputs : undefined, timezone: sc.timezone });
    if (!res.ok) { console.error(`${id} ${sym} ${tf}: ${res.error}`); continue; }
    const derived = applyRules({ scannerId: id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: sc.rule ?? null, bars: b, mode: 'backtest' });
    per.set(id, extractEvents(res.alerts, res.shapes, { derived, sources: sc.sources, edge: sc.edge, labels: sc.labels, invert: sc.invert }));
  }
  const run = (events: ScanEvent[], scannerId: string): any[] => runBacktest({ scannerId, scannerName: scannerId, symbol: sym, tf, bars: b, events, cfg: cfg.paper, exitMode: 'both', contractValue: m.contractValue, tickSize: m.tickSize, chopGate: MIN_ER > 0 ? { minEr: MIN_ER } : undefined } as BacktestInput).trades as any[];
  for (const [id, evs] of per) if (evs.some(e => e.kind === 'entry')) row(tf, sym, 'single', id, stat(run(evs, id), b, tfMs));
  const union = [...per.values()].flat().filter(e => e.kind === 'entry');
  row(tf, sym, 'any1', `${per.size} scanners`, stat(run(union, 'any'), b, tfMs));
  for (const k of KS) { const evs = agreement(per, b, k, WINDOW); row(tf, sym, `agree${k}`, `${per.size} scanners, window ${WINDOW}`, stat(run(evs, `agree${k}`), b, tfMs)); }
  console.error(`${sym} ${tf}: ${per.size} scanners read`);
}
out.end(); await pool.stop();
console.error(`done · ${process.env.OUT}`);
