/**
 * Exit analysis: how much of each trade's available move the exit policy actually captured,
 * and what alternative policies would have captured on the same entries.
 *
 *   npm run exits -- [BARS] [TF]
 *
 * Runs every enabled scanner/symbol pair once through PineTS, then replays the same event
 * stream through the paper backtester under several exit policies. The script is the expensive
 * part, so it is run once per pair and the events are reused for every policy.
 *
 * Per trade it also measures, from the bars themselves:
 *   - MFE: the best unrealised R the trade ever showed before it closed
 *   - MAE: the worst
 *   - after: how far price continued in the trade's direction after the exit, in R, over a
 *     fixed horizon. Positive means the exit was early.
 */
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS, type PaperConfig } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';

const [barsArg = '1500', tfArg = '15m'] = process.argv.slice(2);
const HORIZON_BARS = 20;           // how far past the exit we look for continuation

const store = new ConfigStore();
const cfg = store.get();
const registry = new ScannerRegistry();
const rest = new DeltaRest();

/** The pairs the bot is actually trading. */
const pairs: Array<{ id: string; name: string; symbol: string; tf: string; exitMode: 'levels' | 'script' | 'both' }> = [];
for (const s of registry.all()) {
  const sc = cfg.scanners[s.id];
  if (!sc?.enabled || sc.hidden || s.status !== 'ok') continue;
  for (const symbol of sc.symbols ?? cfg.symbols) for (const tf of sc.timeframes ?? [tfArg]) {
    pairs.push({ id: s.id, name: s.name, symbol, tf, exitMode: sc.exitMode ?? 'both' });
  }
}
if (!pairs.length) { console.error('no enabled scanner/symbol pairs'); process.exit(1); }

type Policy = { name: string; cfg: (p: PaperConfig) => PaperConfig; exitMode?: 'levels' | 'script' | 'both' };
const policies: Policy[] = [
  { name: 'live (3 TP legs + BE)', cfg: p => p },
  { name: 'no break-even', cfg: p => ({ ...p, breakEvenAfterTp1: false }) },
  { name: 'single target at TP1', cfg: p => ({ ...p, tpSplit: [1, 0, 0] }) },
  { name: 'single target at TP3', cfg: p => ({ ...p, tpSplit: [0, 0, 1] }) },
  { name: 'back-loaded 20/30/50', cfg: p => ({ ...p, tpSplit: [0.2, 0.3, 0.5] }) },
  { name: 'back-loaded, no BE', cfg: p => ({ ...p, tpSplit: [0.2, 0.3, 0.5], breakEvenAfterTp1: false }) },
  { name: 'wider targets (RR 2/4/6)', cfg: p => ({ ...p, fallbackRR: [2, 4, 6] }) },
  { name: 'levels only (ignore script exits)', cfg: p => p, exitMode: 'levels' },
  // trailing replaces the break-even jump: stay in the runner instead of exiting it flat
  { name: 'trail after 1R, 1R behind', cfg: p => ({ ...p, breakEvenAfterTp1: false, trailAfterR: 1, trailDistanceR: 1 }) },
  { name: 'trail after 1R, 0.5R behind', cfg: p => ({ ...p, breakEvenAfterTp1: false, trailAfterR: 1, trailDistanceR: 0.5 }) },
  { name: 'trail after 1.5R, 1R behind', cfg: p => ({ ...p, breakEvenAfterTp1: false, trailAfterR: 1.5, trailDistanceR: 1 }) },
  { name: 'trail after 2R, 1R behind', cfg: p => ({ ...p, breakEvenAfterTp1: false, trailAfterR: 2, trailDistanceR: 1 }) },
  { name: 'back-loaded + trail 1R/1R', cfg: p => ({ ...p, tpSplit: [0.2, 0.3, 0.5], breakEvenAfterTp1: false, trailAfterR: 1, trailDistanceR: 1 }) },
  { name: 'TP3 only + trail 1R/1R', cfg: p => ({ ...p, tpSplit: [0, 0, 1], breakEvenAfterTp1: false, trailAfterR: 1, trailDistanceR: 1 }) },
];

interface TradeRow { pair: string; side: 'long' | 'short'; reason: string; r: number; pnl: number; mfeR: number; maeR: number; afterR: number }

function excursions(bars: Bar[], t: any): { mfeR: number; maeR: number; afterR: number } {
  const risk = Math.abs(t.entryPrice - (t.sl ?? t.slOriginal ?? t.entryPrice));
  if (!(risk > 0)) return { mfeR: 0, maeR: 0, afterR: 0 };
  const dir = t.side === 'long' ? 1 : -1;
  let mfe = 0, mae = 0, after = 0;
  let exitIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.time < t.entryAt) continue;
    if (b.time <= (t.exitAt ?? Infinity)) {
      mfe = Math.max(mfe, ((t.side === 'long' ? b.high : b.low) - t.entryPrice) * dir / risk);
      mae = Math.min(mae, ((t.side === 'long' ? b.low : b.high) - t.entryPrice) * dir / risk);
      exitIdx = i;
    } else break;
  }
  if (exitIdx >= 0 && t.exitPrice) {
    for (let i = exitIdx + 1; i <= Math.min(bars.length - 1, exitIdx + HORIZON_BARS); i++) {
      const b = bars[i];
      after = Math.max(after, ((t.side === 'long' ? b.high : b.low) - t.exitPrice) * dir / risk);
    }
  }
  return { mfeR: mfe, maeR: mae, afterR: after };
}

const pool = new PinePool(4, 180_000);
const totals = new Map<string, { trades: number; pnl: number; gp: number; gl: number; wins: number; r: number }>();
const rows: TradeRow[] = [];
let done = 0;

for (const p of pairs) {
  try {
    const product = await rest.product(p.symbol);
    const market = { contractValue: Number(product?.contract_value ?? 0.001), tickSize: Number(product?.tick_size ?? 0.5) };
    const candles = await rest.recentCandles(p.symbol, p.tf, Number(barsArg), TF_SECONDS[p.tf]);
    const bars: Bar[] = candles.slice(0, -1).map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    if (bars.length < 100) { console.error(`skip ${p.id} ${p.symbol}: only ${bars.length} bars`); continue; }
    const s = registry.get(p.id)!;
    const res = await pool.run({ scannerId: s.id, source: s.patched, symbol: p.symbol, tf: p.tf, tickSize: market.tickSize, bars, tailBars: 'all', plotTail: bars.length, inputs: cfg.scanners[p.id]?.inputs });
    if (!res.ok) { console.error(`skip ${p.id} ${p.symbol}: ${res.error}`); continue; }
    const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: cfg.scanners[p.id]?.rule ?? null, bars, mode: 'backtest' });
    const events = extractEvents(res.alerts, res.shapes, { derived });

    for (const pol of policies) {
      const bt = runBacktest({ scannerId: s.id, scannerName: s.name, symbol: p.symbol, tf: p.tf, bars, events, cfg: pol.cfg(cfg.paper), exitMode: pol.exitMode ?? p.exitMode, contractValue: market.contractValue, tickSize: market.tickSize });
      const acc = totals.get(pol.name) ?? { trades: 0, pnl: 0, gp: 0, gl: 0, wins: 0, r: 0 };
      acc.trades += bt.stats.trades; acc.pnl += bt.stats.pnl; acc.gp += bt.stats.grossProfit; acc.gl += bt.stats.grossLoss;
      acc.wins += bt.trades.filter((t: any) => t.pnl > 0).length;
      acc.r += bt.trades.reduce((a: number, t: any) => a + (t.rMultiple ?? 0), 0);
      totals.set(pol.name, acc);
      if (pol.name === policies[0].name) {
        for (const t of bt.trades as any[]) {
          const e = excursions(bars, t);
          rows.push({ pair: `${p.id}:${p.symbol}`, side: t.side, reason: String(t.exitReason ?? '?'), r: t.rMultiple ?? 0, pnl: t.pnl, ...e });
        }
      }
    }
  } catch (e: any) {
    console.error(`skip ${p.id} ${p.symbol}: ${e?.message ?? e}`);
  }
  if (++done % 5 === 0) console.error(`… ${done}/${pairs.length} pairs`);
}
await pool.stop();

// ---- report ----
const n = rows.length;
console.log(`\n${pairs.length} live pairs · ${Number(barsArg)} bars of ${tfArg} · ${n} trades under the live exit policy\n`);

console.log('EXIT REASONS — what each one captured, and what price did afterwards');
console.log('reason        trades    pnl   avgR   avg MFE   capture   avg move after exit (R)');
const byReason = new Map<string, TradeRow[]>();
for (const r of rows) (byReason.get(r.reason) ?? byReason.set(r.reason, []).get(r.reason)!).push(r);
for (const [reason, list] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const avg = (f: (r: TradeRow) => number) => list.reduce((a, r) => a + f(r), 0) / list.length;
  const mfe = avg(r => r.mfeR), r = avg(t => t.r);
  console.log(`${reason.padEnd(12)} ${String(list.length).padStart(6)} ${list.reduce((a, t) => a + t.pnl, 0).toFixed(0).padStart(6)} ${r.toFixed(2).padStart(6)} ${mfe.toFixed(2).padStart(9)} ${(mfe > 0 ? (r / mfe * 100).toFixed(0) + '%' : '-').padStart(9)} ${avg(t => t.afterR).toFixed(2).padStart(12)}`);
}

const winners = rows.filter(r => r.r > 0), losers = rows.filter(r => r.r <= 0);
const sum = (l: TradeRow[], f: (r: TradeRow) => number) => l.reduce((a, r) => a + f(r), 0);
console.log(`\nwinners ${winners.length}: avg captured ${(sum(winners, r => r.r) / Math.max(1, winners.length)).toFixed(2)}R of ${(sum(winners, r => r.mfeR) / Math.max(1, winners.length)).toFixed(2)}R shown`);
console.log(`losers  ${losers.length}: avg ${(sum(losers, r => r.r) / Math.max(1, losers.length)).toFixed(2)}R, but showed ${(sum(losers, r => r.mfeR) / Math.max(1, losers.length)).toFixed(2)}R in profit first`);
const gaveBack = rows.filter(r => r.mfeR >= 1 && r.r <= 0);
console.log(`round trips: ${gaveBack.length} trades reached +1R or better and still closed at a loss (${(gaveBack.length / Math.max(1, n) * 100).toFixed(0)}% of all trades)`);
const early = rows.filter(r => r.afterR >= 1);
console.log(`early exits: ${early.length} trades ran another +1R or more within ${HORIZON_BARS} bars of the exit (${(early.length / Math.max(1, n) * 100).toFixed(0)}%)`);

console.log('\nEXIT POLICIES — same entries, same bars, different exits');
console.log('policy                              trades    pnl     PF   win%   avgR');
const base = totals.get(policies[0].name)!;
for (const pol of policies) {
  const a = totals.get(pol.name);
  if (!a) continue;
  const pf = a.gl > 0 ? a.gp / a.gl : a.gp > 0 ? Infinity : 0;
  const delta = pol.name === policies[0].name ? '' : `  (${a.pnl - base.pnl >= 0 ? '+' : ''}${(a.pnl - base.pnl).toFixed(0)})`;
  console.log(`${pol.name.padEnd(36)} ${String(a.trades).padStart(5)} ${a.pnl.toFixed(0).padStart(6)} ${(Number.isFinite(pf) ? pf.toFixed(2) : '∞').padStart(6)} ${(a.wins / Math.max(1, a.trades) * 100).toFixed(0).padStart(5)}% ${(a.r / Math.max(1, a.trades)).toFixed(2).padStart(6)}${delta}`);
}
