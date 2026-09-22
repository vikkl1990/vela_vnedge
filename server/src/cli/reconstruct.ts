/**
 * Reconstruct trades minute by minute: where the profit peaked, when, and how it ended.
 *
 *   LIVE=positions.json npm run reconstruct            # live trades (a dump of the positions table)
 *   PAIRS=pairs.json npm run reconstruct -- [BARS]     # backtest trades of a fleet, exits on 1m
 *
 * For every trade, from the 1m candles after the fill:
 *   peak    best open result in R and in dollars at the trade's own size, and minutes to reach it
 *   dip     worst open result before that peak (how much heat it took to get there)
 *   exit    result, reason, minutes held, and minutes from the peak to the exit
 *
 * The summary answers the questions an exit rule has to answer: of the trades that were stopped,
 * how many had been in profit first and by how much, how quickly winners peak, and how much of the
 * peak the current exit keeps.
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

const [barsArg = '4000'] = process.argv.slice(2);
const TF = '15m';
const cfg = new ConfigStore().get();
const rest = new DeltaRest();
const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));

export interface Trade { id: string; scanner: string; symbol: string; side: 'long' | 'short'; entryAt: number; fillAt: number; exitAt: number; entry: number; sl: number; exit: number; reason: string; units: number; pnl: number }
export interface Recon extends Trade { peakR: number; peakUsd: number; peakMin: number; dipR: number; exitR: number; heldMin: number; peakToExitMin: number; path: number[] }

/** Walk the 1m candles of one trade. `path` is the open result in R at each minute's close. */
export function reconstruct(t: Trade, m1: Bar[]): Recon {
  const dir = t.side === 'long' ? 1 : -1, risk = Math.abs(t.entry - t.sl) || 1e-12;
  const r = (x: number) => (x - t.entry) * dir / risk;
  let peakR = 0, peakAt = t.fillAt, dipR = 0, dipBeforePeak = 0;
  const path: number[] = [];
  for (const b of m1) {
    if (b.time + 60_000 <= t.fillAt || b.time > t.exitAt) continue;
    // in the fill minute only the close is known to be after the fill
    const hi = b.time < t.fillAt ? r(b.close) : r(dir === 1 ? b.high : b.low);
    const lo = b.time < t.fillAt ? r(b.close) : r(dir === 1 ? b.low : b.high);
    dipR = Math.min(dipR, lo);
    if (hi > peakR) { peakR = hi; peakAt = b.time; dipBeforePeak = dipR; }
    path.push(Math.round(r(b.close) * 100) / 100);
  }
  const exitR = r(t.exit);
  return { ...t, peakR, peakUsd: peakR * risk * t.units, peakMin: (peakAt - t.fillAt) / 60_000, dipR: dipBeforePeak, exitR, heldMin: (t.exitAt - t.fillAt) / 60_000, peakToExitMin: (t.exitAt - peakAt) / 60_000, path };
}

async function m1For(symbol: string, from: number, to: number): Promise<Bar[]> {
  return toBars(await rest.candles(symbol, '1m', Math.floor(from / 1000) - 120, Math.floor(to / 1000) + 120, 80_000));
}

const trades: Trade[] = [];
const m1: Map<string, Bar[]> = new Map();
if (process.env.LIVE) {
  for (const p of JSON.parse(fs.readFileSync(process.env.LIVE, 'utf8'))) {
    if (!p.exit_at) continue;
    trades.push({ id: `live#${p.id}`, scanner: p.scanner_id, symbol: p.symbol, side: p.side, entryAt: p.entry_at, fillAt: p.entry_at, exitAt: p.exit_at, entry: p.entry_price, sl: p.sl_original ?? p.sl, exit: p.exit_price, reason: p.exit_reason, units: p.qty * p.contract_value, pnl: p.realized_pnl - p.fees });
  }
  for (const s of new Set(trades.map(t => t.symbol))) {
    const ts = trades.filter(t => t.symbol === s);
    m1.set(s, await m1For(s, Math.min(...ts.map(t => t.entryAt)), Math.max(...ts.map(t => t.exitAt))));
  }
} else {
  const registry = new ScannerRegistry();
  const pairs: any[] = process.env.PAIRS ? JSON.parse(fs.readFileSync(process.env.PAIRS, 'utf8'))
    : Object.entries(cfg.scanners).filter(([, v]) => v.enabled && !v.hidden).flatMap(([id, v]) => (v.symbols ?? cfg.symbols).map(symbol => ({ id, symbol, exitMode: v.exitMode, inputs: v.inputs, rule: v.rule })));
  const pool = new PinePool(4, 300_000);
  const tfMs = TF_SECONDS[TF] * 1000;
  for (const p of pairs) {
    const s = registry.get(p.id);
    if (!s || s.status !== 'ok') continue;
    const product = await rest.product(p.symbol);
    const market = { contractValue: Number(product?.contract_value ?? 0.001), tickSize: Number(product?.tick_size ?? 0.5) };
    const bars = toBars(await rest.recentCandles(p.symbol, TF, Number(barsArg), TF_SECONDS[TF]));
    if (bars.length < 300) continue;
    if (!m1.has(p.symbol)) m1.set(p.symbol, toBars(await rest.recentCandles(p.symbol, '1m', Math.ceil((bars.length + 2) * TF_SECONDS[TF] / 60), 60)));
    const res = await pool.run({ scannerId: s.id, source: s.patched, symbol: p.symbol, tf: TF, tickSize: market.tickSize, bars, tailBars: 'all', plotTail: bars.length, inputs: p.inputs });
    if (!res.ok) continue;
    const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: p.rule ?? null, bars, mode: 'backtest' });
    const bt = runBacktest({ scannerId: s.id, scannerName: s.id, symbol: p.symbol, tf: TF, bars, events: extractEvents(res.alerts, res.shapes, { derived }), cfg: cfg.paper, exitMode: p.exitMode ?? 'both', contractValue: market.contractValue, tickSize: market.tickSize, subBars: m1.get(p.symbol) });
    for (const t of bt.trades as any[]) {
      // the backtest stamps an entry with its signal bar's open; the fill is at that bar's close
      trades.push({ id: `bt#${s.id}/${p.symbol}/${t.id}`, scanner: s.id, symbol: p.symbol, side: t.side, entryAt: t.entryAt, fillAt: t.entryAt + tfMs, exitAt: t.exitAt, entry: t.entryPrice, sl: t.sl, exit: t.exitPrice, reason: t.exitReason, units: t.qty * market.contractValue, pnl: t.pnl });
    }
    console.error(`  ${s.id}/${p.symbol}: ${bt.trades.length} trades`);
  }
  await pool.stop();
}

const recs = trades.map(t => reconstruct(t, m1.get(t.symbol) ?? [])).sort((a, b) => a.entryAt - b.entryAt);
const hhmm = (x: number) => new Date(x).toISOString().slice(5, 16).replace('T', ' ');
const f = (x: number, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);

if (process.env.LIVE) {
  console.log(`\nLIVE TRADES RECONSTRUCTED · ${recs.length} trades · times UTC\n`);
  console.log(`  ${'trade'.padEnd(8)} ${'scanner'.padEnd(24)} ${'symbol'.padEnd(8)} side  ${'entry'.padEnd(11)} ${'peak'.padStart(6)} ${'peak $'.padStart(7)} ${'at'.padStart(6)} ${'dip first'.padStart(9)}  ${'exit'.padStart(6)} ${'reason'.padEnd(8)} ${'held'.padStart(6)} ${'peak→exit'.padStart(9)}  realised`);
  for (const t of recs) console.log(`  ${t.id.padEnd(8)} ${t.scanner.slice(0, 24).padEnd(24)} ${t.symbol.padEnd(8)} ${t.side.padEnd(5)} ${hhmm(t.fillAt).padEnd(11)} ${f(t.peakR).padStart(6)} ${('$' + t.peakUsd.toFixed(2)).padStart(7)} ${(t.peakMin.toFixed(0) + 'm').padStart(6)} ${f(t.dipR).padStart(9)}  ${f(t.exitR).padStart(6)} ${t.reason.padEnd(8)} ${(t.heldMin.toFixed(0) + 'm').padStart(6)} ${(t.peakToExitMin.toFixed(0) + 'm').padStart(9)}  $${t.pnl.toFixed(2)}`);
}

// ---- summary: what an exit rule has to work with ----
const stopped = recs.filter(t => t.reason === 'sl');
const winners = recs.filter(t => t.exitR > 0);
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
console.log(`\nSUMMARY · ${recs.length} trades · ${stopped.length} stopped at the original stop · ${winners.length} closed in profit\n`);
console.log('  stopped trades, by how far they had been in profit first:');
for (const [lo, hi] of [[-1, 0.001], [0.001, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1], [1, 99]] as const) {
  const g = stopped.filter(t => t.peakR >= lo && t.peakR < hi);
  if (!g.length) continue;
  console.log(`    peak ${lo <= 0 ? 'never above entry' : `${lo}–${hi === 99 ? '∞' : hi}R`.padEnd(17)}  ${String(g.length).padStart(4)} (${(g.length / stopped.length * 100).toFixed(0).padStart(3)}%)  median minutes to peak ${q(g.map(t => t.peakMin), 0.5).toFixed(0).padStart(4)}, peak to stop ${q(g.map(t => t.peakToExitMin), 0.5).toFixed(0).padStart(4)}`);
}
console.log('\n  all trades, peak reached:');
for (const lvl of [0.25, 0.5, 0.75, 1, 1.5, 2, 3]) {
  const g = recs.filter(t => t.peakR >= lvl);
  const stoppedAfter = g.filter(t => t.reason === 'sl').length;
  console.log(`    ≥ ${String(lvl).padEnd(4)}R  ${String(g.length).padStart(4)} (${(g.length / recs.length * 100).toFixed(0).padStart(3)}%)   of which later stopped at −1R: ${String(stoppedAfter).padStart(4)} (${g.length ? (stoppedAfter / g.length * 100).toFixed(0) : 0}%)`);
}
const peakMins = recs.filter(t => t.peakR >= 0.5).map(t => t.peakMin);
console.log(`\n  minutes from fill to peak (trades that reached +0.5R): p25 ${q(peakMins, 0.25).toFixed(0)}, median ${q(peakMins, 0.5).toFixed(0)}, p75 ${q(peakMins, 0.75).toFixed(0)}`);
const kept = winners.map(t => t.exitR / Math.max(t.peakR, 1e-9));
console.log(`  share of the peak kept by winners: median ${(q(kept, 0.5) * 100).toFixed(0)}%`);
console.log(`  total peak available ${recs.reduce((a, t) => a + t.peakR, 0).toFixed(1)}R · realised ${recs.reduce((a, t) => a + t.exitR, 0).toFixed(1)}R`);
fs.writeFileSync(process.env.OUT ?? '/tmp/reconstruct.json', JSON.stringify(recs));
