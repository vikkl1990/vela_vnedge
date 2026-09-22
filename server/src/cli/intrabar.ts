/**
 * Bar-level exits versus 1-minute exits, same signals, same history.
 *
 *   npm run intrabar -- [DAYS] [TF]
 *
 * The live engine checks stops, targets and the trail on every 1m candle; the backtest normally
 * checks them once per signal bar. This runs the enabled fleet both ways and reports the gap, so
 * backtest numbers can be read against what live execution would actually have done.
 *
 * Only the exit path changes. Entries, script events and sizing are identical in both runs.
 */
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';

const [daysArg = '40', tfArg = '15m', onlyArg = ''] = process.argv.slice(2);
const DAYS = Number(daysArg);
const TF = tfArg;
const WINDOWS = 8;

const cfg = new ConfigStore().get();
const registry = new ScannerRegistry();
const rest = new DeltaRest();

const pairs: Array<{ id: string; symbol: string; exitMode: 'levels' | 'script' | 'both' }> = [];
for (const s of registry.all()) {
  const sc = cfg.scanners[s.id];
  if (s.status !== 'ok') continue;
  if (onlyArg ? !onlyArg.split(',').includes(s.id) : (!sc?.enabled || sc.hidden)) continue;
  for (const symbol of (onlyArg ? null : sc?.symbols) ?? cfg.symbols) pairs.push({ id: s.id, symbol, exitMode: sc?.exitMode ?? 'both' });
}
if (!pairs.length) { console.error('no scanner/symbol pairs'); process.exit(1); }

const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));

interface Agg { trades: number; pnl: number; gp: number; gl: number; wins: number; r: number; reasons: Record<string, [number, number]>; w: number[] }
const blank = (): Agg => ({ trades: 0, pnl: 0, gp: 0, gl: 0, wins: 0, r: 0, reasons: {}, w: new Array(WINDOWS).fill(0) });
const modes = { bar: blank(), '1m': blank() };
let flipped = 0, compared = 0;

const pool = new PinePool(4, 300_000);
const m1Cache = new Map<string, Bar[]>();
const nBars = Math.min(5000, Math.floor((DAYS * 86400) / TF_SECONDS[TF]));
let done = 0;
for (const p of pairs) {
  try {
    const product = await rest.product(p.symbol);
    const market = { contractValue: Number(product?.contract_value ?? 0.001), tickSize: Number(product?.tick_size ?? 0.5) };
    const bars = toBars(await rest.recentCandles(p.symbol, TF, nBars, TF_SECONDS[TF]));
    if (bars.length < 300) continue;
    if (!m1Cache.has(p.symbol)) m1Cache.set(p.symbol, toBars(await rest.recentCandles(p.symbol, '1m', Math.ceil((bars.length + 2) * TF_SECONDS[TF] / 60), 60)));
    const m1 = m1Cache.get(p.symbol)!;

    const s = registry.get(p.id)!;
    const res = await pool.run({ scannerId: s.id, source: s.patched, symbol: p.symbol, tf: TF, tickSize: market.tickSize, bars, tailBars: 'all', plotTail: bars.length, inputs: cfg.scanners[p.id]?.inputs });
    if (!res.ok) continue;
    const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: cfg.scanners[p.id]?.rule ?? null, bars, mode: 'backtest' });
    const events = extractEvents(res.alerts, res.shapes, { derived });
    const input = { scannerId: s.id, scannerName: s.id, symbol: p.symbol, tf: TF, bars, events, cfg: cfg.paper, exitMode: p.exitMode, contractValue: market.contractValue, tickSize: market.tickSize };

    const runs = { bar: runBacktest(input), '1m': runBacktest({ ...input, subBars: m1 }) };
    const size = (bars.at(-1)!.time - bars[0].time) / WINDOWS;
    for (const [k, bt] of Object.entries(runs) as Array<[keyof typeof modes, ReturnType<typeof runBacktest>]>) {
      const a = modes[k];
      for (const t of bt.trades as any[]) {
        a.trades++; a.pnl += t.pnl; a.r += t.rMultiple ?? 0;
        if (t.pnl > 0) { a.gp += t.pnl; a.wins++; } else a.gl -= t.pnl;
        const why = t.exitReason ?? '?';
        const rr = a.reasons[why] ??= [0, 0]; rr[0]++; rr[1] += t.pnl;
        a.w[Math.min(WINDOWS - 1, Math.floor((t.entryAt - bars[0].time) / size))] += t.pnl;
      }
    }
    // same entry, opposite outcome: how often the bar-level model got the sign of a trade wrong
    const byEntry = new Map((runs['1m'].trades as any[]).map(t => [t.entryAt, t]));
    for (const t of runs.bar.trades as any[]) {
      const u = byEntry.get(t.entryAt);
      if (!u) continue;
      compared++;
      if (Math.sign(t.pnl) !== Math.sign(u.pnl)) flipped++;
    }
  } catch (e: any) { console.error(`  ${p.id}/${p.symbol}: ${e?.message ?? e}`); }
  if (++done % 5 === 0) console.error(`  ${done}/${pairs.length} pairs`);
}
await pool.stop();

const pf = (a: Agg) => (a.gl > 0 ? a.gp / a.gl : a.gp > 0 ? Infinity : 0);
console.log(`\nINTRABAR: exits on the ${TF} bar versus on 1m candles · ${pairs.length} pairs · ${DAYS} days\n`);
console.log(`  ${'exits on'.padEnd(10)} ${'trades'.padStart(7)} ${'net'.padStart(8)} ${'PF'.padStart(6)} ${'win%'.padStart(5)} ${'avgR'.padStart(6)}  windows up`);
for (const [k, a] of Object.entries(modes)) {
  if (!a.trades) continue;
  console.log(`  ${k.padEnd(10)} ${String(a.trades).padStart(7)} ${a.pnl.toFixed(0).padStart(8)} ${pf(a).toFixed(2).padStart(6)} ${(a.wins / a.trades * 100).toFixed(0).padStart(4)}% ${(a.r / a.trades).toFixed(2).padStart(6)}  ${a.w.filter(x => x > 0).length}/${WINDOWS}`);
}
console.log('\n  exit reasons (trades, net):');
const reasons = [...new Set(Object.values(modes).flatMap(a => Object.keys(a.reasons)))];
for (const why of reasons) console.log(`  ${why.padEnd(12)} ${Object.entries(modes).map(([k, a]) => `${k} ${String(a.reasons[why]?.[0] ?? 0).padStart(5)}t ${(a.reasons[why]?.[1] ?? 0).toFixed(0).padStart(7)}`).join('   ')}`);
console.log('\n  per window, net:');
for (const [k, a] of Object.entries(modes)) console.log(`  ${k.padEnd(10)} ${a.w.map(x => x.toFixed(0).padStart(7)).join('')}`);
console.log(`\n  same entry, different sign of result: ${flipped} of ${compared} trades (${compared ? (flipped / compared * 100).toFixed(1) : 0}%)`);
