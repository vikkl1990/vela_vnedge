/**
 * Per-pair deep dive of a scanner fleet, on the execution model live actually uses.
 *
 *   PAIRS=pairs.json LIVE=positions.json npm run deepdive -- [BARS] [TF]
 *
 * PAIRS is a JSON list of { id, symbol, exitMode?, inputs?, rule? } (default: the enabled pairs in
 * the local config). LIVE is an optional JSON dump of live positions to set beside the backtest.
 *
 * Every pair is backtested with exits resolved on 1m candles (decision 13), then examined for:
 *   - result and profit factor, and the same result at 10 bps of cost (decision 5: costs matter)
 *   - how many of 8 consecutive windows it made money in (a real edge shows up in most of them)
 *   - how many trades never went in the money at all: a direct measure of entry quality
 *   - exit mix, and the gap between bar-level and 1m exits (how much the old model flattered it)
 */
import fs from 'node:fs';
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';

const [barsArg = '4000', tfArg = '15m'] = process.argv.slice(2);
const TF = tfArg;
const WINDOWS = 8;
const cfg = new ConfigStore().get();
const registry = new ScannerRegistry();
const rest = new DeltaRest();

type Pair = { id: string; symbol: string; exitMode?: 'levels' | 'script' | 'both'; inputs?: any; rule?: any };
const pairs: Pair[] = process.env.PAIRS ? JSON.parse(fs.readFileSync(process.env.PAIRS, 'utf8'))
  : Object.entries(cfg.scanners).filter(([, v]) => v.enabled && !v.hidden).flatMap(([id, v]) => (v.symbols ?? cfg.symbols).map(symbol => ({ id, symbol, exitMode: v.exitMode, inputs: v.inputs, rule: v.rule })));
const live: any[] = process.env.LIVE ? JSON.parse(fs.readFileSync(process.env.LIVE, 'utf8')) : [];

const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
const pf = (t: any[]) => { const gp = t.filter(x => x.pnl > 0).reduce((a, x) => a + x.pnl, 0), gl = -t.filter(x => x.pnl <= 0).reduce((a, x) => a + x.pnl, 0); return gl > 0 ? gp / gl : gp > 0 ? 99 : 0; };
const sum = (t: any[]) => t.reduce((a, x) => a + x.pnl, 0);

interface Row { id: string; symbol: string; trades: number; win: number; net: number; pf: number; avgR: number; net10: number; barNet: number; windowsUp: number; windowsWith: number; never: number; perTrade: number; reasons: Record<string, number>; live?: { n: number; r: number; usd: number }; verdict: string }
const rows: Row[] = [];
const pool = new PinePool(4, 300_000);
const m1Cache = new Map<string, Bar[]>();

for (const p of pairs) {
  try {
    const s = registry.get(p.id);
    if (!s || s.status !== 'ok') { console.error(`  ${p.id}: not runnable`); continue; }
    const product = await rest.product(p.symbol);
    const market = { contractValue: Number(product?.contract_value ?? 0.001), tickSize: Number(product?.tick_size ?? 0.5) };
    const bars = toBars(await rest.recentCandles(p.symbol, TF, Number(barsArg), TF_SECONDS[TF]));
    if (bars.length < 300) { console.error(`  ${p.id}/${p.symbol}: only ${bars.length} bars`); continue; }
    if (!m1Cache.has(p.symbol)) m1Cache.set(p.symbol, toBars(await rest.recentCandles(p.symbol, '1m', Math.ceil((bars.length + 2) * TF_SECONDS[TF] / 60), 60)));
    const m1 = m1Cache.get(p.symbol)!;
    const res = await pool.run({ scannerId: s.id, source: s.patched, symbol: p.symbol, tf: TF, tickSize: market.tickSize, bars, tailBars: 'all', plotTail: bars.length, inputs: p.inputs });
    if (!res.ok) { console.error(`  ${p.id}/${p.symbol}: ${res.error}`); continue; }
    const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: p.rule ?? null, bars, mode: 'backtest' });
    const events = extractEvents(res.alerts, res.shapes, { derived });
    const base = { scannerId: s.id, scannerName: s.id, symbol: p.symbol, tf: TF, bars, events, cfg: cfg.paper, exitMode: p.exitMode ?? 'both', contractValue: market.contractValue, tickSize: market.tickSize };
    const t = runBacktest({ ...base, subBars: m1 }).trades as any[];
    const t10 = runBacktest({ ...base, cfg: { ...cfg.paper, slippageBps: 10 }, subBars: m1 }).trades as any[];
    const tBar = runBacktest(base).trades as any[];

    const tfMs = TF_SECONDS[TF] * 1000;
    const size = (bars.at(-1)!.time - bars[0].time) / WINDOWS;
    const w = new Array(WINDOWS).fill(0), wn = new Array(WINDOWS).fill(0);
    let never = 0;
    const reasons: Record<string, number> = {};
    for (const x of t) {
      const k = Math.min(WINDOWS - 1, Math.floor((x.entryAt - bars[0].time) / size)); w[k] += x.pnl; wn[k]++;
      reasons[x.exitReason] = (reasons[x.exitReason] ?? 0) + 1;
      // best price after the fill (the signal bar's close) up to the exit
      const dir = x.side === 'long' ? 1 : -1;
      const path = m1.filter(b => b.time >= x.entryAt + tfMs && b.time <= (x.exitAt ?? x.entryAt));
      const best = path.length ? Math.max(...path.map(b => (dir === 1 ? b.high : b.low) * dir)) * dir : x.entryPrice;
      if ((best - x.entryPrice) * dir <= 0) never++;
    }
    const lv = live.filter(q => q.scanner_id === p.id && q.symbol === p.symbol);
    const lr = lv.reduce((a, q) => a + (q.exit_price - q.entry_price) * (q.side === 'long' ? 1 : -1) / Math.abs(q.entry_price - q.sl_original), 0);
    const row: Row = {
      id: p.id, symbol: p.symbol, trades: t.length, win: t.filter(x => x.pnl > 0).length, net: sum(t), pf: pf(t),
      avgR: t.length ? t.reduce((a, x) => a + (x.rMultiple ?? 0), 0) / t.length : 0, net10: sum(t10), barNet: sum(tBar),
      windowsUp: w.filter(x => x > 0).length, windowsWith: wn.filter(x => x > 0).length, never, perTrade: t.length ? sum(t) / t.length : 0, reasons,
      live: lv.length ? { n: lv.length, r: lr, usd: lv.reduce((a, q) => a + q.realized_pnl - q.fees, 0) } : undefined, verdict: '',
    };
    row.verdict = row.trades < 20 ? 'too few trades'
      : row.net > 0 && row.pf >= 1.15 && row.windowsUp >= 5 && row.net10 > 0 ? 'KEEP'
      : row.net > 0 && row.windowsUp >= 4 ? 'WEAK'
      : 'DROP';
    rows.push(row);
    console.error(`  ${p.id}/${p.symbol}: ${row.verdict}`);
  } catch (e: any) { console.error(`  ${p.id}/${p.symbol}: ${e?.message ?? e}`); }
}
await pool.stop();

const pad = (x: string, n: number) => x.padEnd(n).slice(0, n);
console.log(`\nDEEP DIVE · ${rows.length} pairs · ${barsArg} × ${TF} · exits on 1m candles\n`);
console.log(`  ${pad('scanner', 34)} ${pad('symbol', 11)} ${'trd'.padStart(4)} ${'win%'.padStart(5)} ${'net'.padStart(7)} ${'PF'.padStart(5)} ${'avgR'.padStart(6)} ${'@10bp'.padStart(7)} ${'bar-lvl'.padStart(8)} ${'wins'.padStart(5)} ${'never+'.padStart(7)}  ${'live'.padEnd(16)} verdict`);
for (const r of rows.sort((a, b) => b.net - a.net)) {
  console.log(`  ${pad(r.id, 34)} ${pad(r.symbol, 11)} ${String(r.trades).padStart(4)} ${(r.trades ? r.win / r.trades * 100 : 0).toFixed(0).padStart(4)}% ${r.net.toFixed(0).padStart(7)} ${r.pf.toFixed(2).padStart(5)} ${r.avgR.toFixed(2).padStart(6)} ${r.net10.toFixed(0).padStart(7)} ${r.barNet.toFixed(0).padStart(8)} ${(r.windowsUp + '/' + WINDOWS).padStart(5)} ${(r.trades ? r.never / r.trades * 100 : 0).toFixed(0).padStart(6)}%  ${pad(r.live ? `${r.live.n}t ${r.live.r >= 0 ? '+' : ''}${r.live.r.toFixed(1)}R $${r.live.usd.toFixed(0)}` : '-', 16)} ${r.verdict}`);
}
const tot = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
console.log(`\n  fleet: ${tot(r => r.trades)} trades · net ${tot(r => r.net).toFixed(0)} · at 10bps ${tot(r => r.net10).toFixed(0)} · bar-level model said ${tot(r => r.barNet).toFixed(0)}`);
for (const v of ['KEEP', 'WEAK', 'DROP', 'too few trades']) {
  const g = rows.filter(r => r.verdict === v);
  if (g.length) console.log(`  ${pad(v, 15)} ${String(g.length).padStart(2)} pairs · net ${g.reduce((a, r) => a + r.net, 0).toFixed(0)}`);
}
console.log('\n  never+ = share of trades that never traded above entry after the fill (entry quality)');
console.log('  wins   = windows out of 8 with a positive result');
fs.writeFileSync('/tmp/deepdive.json', JSON.stringify(rows, null, 1));
