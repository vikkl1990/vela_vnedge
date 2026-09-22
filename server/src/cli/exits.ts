/**
 * Exit analysis and walk-forward comparison of exit policies.
 *
 *   npm run exits -- [BARS] [TF] [WINDOWS]
 *
 * Every enabled scanner/symbol pair is run through PineTS once over the whole span; the event
 * stream is then replayed through the paper backtester under each policy, both pooled over the
 * full span and separately over `WINDOWS` consecutive, non-overlapping windows.
 *
 * An exit policy is a fixed rule, so evaluating the same rule on disjoint windows is the honest
 * out-of-sample test: a policy that only wins on one window is fitted to it. The report also runs
 * the realistic version of the choice, picking the best policy on each window and applying it to
 * the next one, which is what a tuner could actually have done.
 *
 * Per trade it measures, from the bars themselves:
 *   - MFE:   the best unrealised R the trade showed before it closed
 *   - after: how far price continued in the trade's direction over a fixed horizon past the exit
 *            (a maximum over that horizon, so an upper bound on what a better exit could reach)
 *   - bars held, and bars to the first profit-taking fill
 *
 * EXIT_1M=1 resolves every exit on 1-minute candles inside each bar, which is how the live engine
 * executes. Exit policies must be compared that way: on bar-level fills a trail can only tighten
 * once per bar, which flatters every trailing rule relative to live.
 */
import fs from 'node:fs';
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS, type PaperConfig } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';

const [barsArg = '4000', tfArg = '15m', windowsArg = '8'] = process.argv.slice(2);
const HORIZON_BARS = 20;
const WINDOWS = Math.max(2, Number(windowsArg));
const EXIT_1M = process.env.EXIT_1M === '1';

const cfg = new ConfigStore().get();
// PAPER=file.json: take the paper settings from a file (e.g. the VM's), not whatever the local config holds
if (process.env.PAPER) Object.assign(cfg.paper, JSON.parse(fs.readFileSync(process.env.PAPER, 'utf8')));
const registry = new ScannerRegistry();
const rest = new DeltaRest();

const pairs: Array<{ id: string; symbol: string; tf: string; exitMode: 'levels' | 'script' | 'both'; inputs?: any }> = [];
// PAIRS=file.json runs an explicit list of { id, symbol, exitMode?, inputs? } (e.g. the VM's fleet)
if (process.env.PAIRS) for (const p of JSON.parse(fs.readFileSync(process.env.PAIRS, 'utf8'))) pairs.push({ id: p.id, symbol: p.symbol, tf: tfArg, exitMode: p.exitMode ?? 'both', inputs: p.inputs });
else for (const s of registry.all()) {
  const sc = cfg.scanners[s.id];
  if (!sc?.enabled || sc.hidden || s.status !== 'ok') continue;
  for (const symbol of sc.symbols ?? cfg.symbols) for (const tf of sc.timeframes ?? [tfArg]) {
    pairs.push({ id: s.id, symbol, tf, exitMode: sc.exitMode ?? 'both' });
  }
}
if (!pairs.length) { console.error('no enabled scanner/symbol pairs'); process.exit(1); }

type Policy = { name: string; cfg: (p: PaperConfig) => PaperConfig; exitMode?: 'levels' | 'script' | 'both' };
/**
 * One representative of each family that has been tested, so a single run reproduces the
 * decisions in docs/DECISIONS.md rather than re-deriving them. Add a row to test something new;
 * do not leave a one-off sweep here, or the next person gets an experiment instead of a baseline.
 */
/**
 * POLICIES=source: who decides the exit. Every row sets the trail explicitly, so the result does
 * not depend on whatever the local config happens to hold.
 *   scanner only   the script's own exit events and opposite signals; stop kept, no trail, no targets
 *   price only     stop, trail and targets; script exits and reversals ignored
 *   both           everything, as live runs
 */
const off = (p: PaperConfig): PaperConfig => ({ ...p, trailAfterR: 0, trailGiveBackPct: 0, trailAtrMult: 0, floorAtR: 0, floorKeepR: 0, staleBars: 0, fallbackRR: [50, 60, 70] });
const OLD = (p: PaperConfig): PaperConfig => ({ ...p, trailAfterR: 1, trailGiveBackPct: 25, floorAtR: 0, floorKeepR: 0 });
const NEW = (p: PaperConfig): PaperConfig => ({ ...p, trailAfterR: 1.5, trailGiveBackPct: 40, floorAtR: 0, floorKeepR: 0 });
const NEW_LOCK = (p: PaperConfig): PaperConfig => ({ ...NEW(p), floorAtR: 1, floorKeepR: 0.5 });
const sourcePolicies: Policy[] = [
  { name: 'both, OLD trail (75% from 1R)', cfg: OLD, exitMode: 'both' },
  { name: 'scanner exits only (+stop)', cfg: off, exitMode: 'both' },
  { name: 'price only, OLD trail', cfg: p => ({ ...OLD(p), allowReversal: false }), exitMode: 'levels' },
  { name: 'price only, NEW trail (60% from 1.5R)', cfg: p => ({ ...NEW(p), allowReversal: false }), exitMode: 'levels' },
  { name: 'price only, NEW + lock 0.5R at 1R', cfg: p => ({ ...NEW_LOCK(p), allowReversal: false }), exitMode: 'levels' },
  { name: 'both, NEW trail', cfg: NEW, exitMode: 'both' },
  { name: 'both, NEW + lock 0.5R at 1R', cfg: NEW_LOCK, exitMode: 'both' },
];
const standardPolicies: Policy[] = [
  { name: 'live: 2/4/6 R, all at TP3, keep 75% from 1R', cfg: p => p },

  // targets (decision 4): wider beat narrower, and the plateau was flat
  { name: 'targets 1/2/3 R', cfg: p => ({ ...p, fallbackRR: [1, 2, 3] }) },
  { name: 'targets 3/6/9 R', cfg: p => ({ ...p, fallbackRR: [3, 6, 9] }) },

  // splits (decision 9): every partial at TP1 was worse, monotonically
  { name: 'split 25/25/50', cfg: p => ({ ...p, tpSplit: [0.25, 0.25, 0.5] }) },
  { name: 'split 50/25/25', cfg: p => ({ ...p, tpSplit: [0.5, 0.25, 0.25] }) },

  // protecting earlier (decisions 6 and 7): all lost, while raising the win rate
  { name: 'no trail at all', cfg: p => ({ ...p, trailAfterR: 0 }) },
  { name: 'break-even after TP1 instead', cfg: p => ({ ...p, trailAfterR: 0, breakEvenAfterTp1: true }) },
  { name: 'floor 0.5R keep 0.25R', cfg: p => ({ ...p, floorAtR: 0.5, floorKeepR: 0.25 }) },
  { name: 'give back 50% from 0.4R', cfg: p => ({ ...p, trailAfterR: 0.4, trailGiveBackPct: 50 }) },
  { name: 'give back 50% from 1R', cfg: p => ({ ...p, trailGiveBackPct: 50 }) },
  { name: 'keep 75% from 2R', cfg: p => ({ ...p, trailAfterR: 2 }) },
  { name: 'keep 60% from 1.5R', cfg: p => ({ ...p, trailAfterR: 1.5, trailGiveBackPct: 40 }) },
  { name: 'keep 60% from 1R', cfg: p => ({ ...p, trailGiveBackPct: 40 }) },
  { name: 'keep 50% from 1.5R', cfg: p => ({ ...p, trailAfterR: 1.5, trailGiveBackPct: 50 }) },
  { name: 'time stop: 12 bars under 1R', cfg: p => ({ ...p, staleBars: 12, staleMinR: 1 }) },

  // volatility exits (decision 7): worse and far less consistent
  { name: 'ATR trail 3x from 1R', cfg: p => ({ ...p, trailGiveBackPct: 0, trailAtrMult: 3 }) },
  { name: 'ATR trail 2x from 1R', cfg: p => ({ ...p, trailGiveBackPct: 0, trailAtrMult: 2 }) },
  { name: 'ATR trail 2.5x from 1R', cfg: p => ({ ...p, trailGiveBackPct: 0, trailAtrMult: 2.5 }) },
  { name: 'ATR trail 4x from 1R', cfg: p => ({ ...p, trailGiveBackPct: 0, trailAtrMult: 4 }) },
  { name: 'ATR trail 3x from 0.5R', cfg: p => ({ ...p, trailAfterR: 0.5, trailGiveBackPct: 0, trailAtrMult: 3 }) },
  { name: 'ATR trail 3x from 2R', cfg: p => ({ ...p, trailAfterR: 2, trailGiveBackPct: 0, trailAtrMult: 3 }) },

  // reversals (decision 8): the requested variant was worst; reversing less helped slightly
  { name: 'reverse only above break-even', cfg: p => ({ ...p, reversalMinR: 0.01 }) },
  { name: 'never reverse', cfg: p => ({ ...p, allowReversal: false }) },

  // stop width (decision 3): 1.5 ATR sits on a peak, not a slope
  { name: 'stop 1.0 ATR', cfg: p => ({ ...p, fallbackAtrSl: 1.0 }) },
  { name: 'stop 2.5 ATR', cfg: p => ({ ...p, fallbackAtrSl: 2.5 }) },
];
/**
 * POLICIES=costfilter: skip entries whose stop is too tight for the round-trip cost. The filter is
 * `minRiskFeeRatio`: the stop distance must be at least this many round-trip fees (with GST).
 * Everything else is the local config's live exit.
 */
const costPolicies: Policy[] = [4, 6, 8, 10, 12, 16].map(k => ({ name: `stop ≥ ${k}× round-trip fee${k === 4 ? ' (live)' : ''}`, cfg: (p: PaperConfig) => ({ ...p, minRiskFeeRatio: k }) }));
costPolicies.push(
  { name: 'BTC/ETH ≥ 8×, others 4×', cfg: (p: PaperConfig) => ({ ...p, minRiskFeeRatio: 4, minRiskFeeRatioBySymbol: { BTCUSD: 8, ETHUSD: 8 } }) },
  { name: 'BTC/ETH ≥ 6×, others 4×', cfg: (p: PaperConfig) => ({ ...p, minRiskFeeRatio: 4, minRiskFeeRatioBySymbol: { BTCUSD: 6, ETHUSD: 6 } }) },
);
if (process.env.POLICIES === 'costfilter' && process.env.ONLY_MAJORS_ROWS === '1') costPolicies.splice(1, 5);
const policies: Policy[] = process.env.POLICIES === 'source' ? sourcePolicies : process.env.POLICIES === 'costfilter' ? costPolicies : standardPolicies;

interface Agg { trades: number; pnl: number; gp: number; gl: number; fees: number; wins: number; r: number; barsHeld: number; barsToFirstTp: number; firstTpCount: number }
const blank = (): Agg => ({ trades: 0, pnl: 0, gp: 0, gl: 0, fees: 0, wins: 0, r: 0, barsHeld: 0, barsToFirstTp: 0, firstTpCount: 0 });
const pf = (a: Agg) => (a.gl > 0 ? a.gp / a.gl : a.gp > 0 ? Infinity : 0);

function accumulate(acc: Agg, bt: any, tfMs: number) {
  acc.trades += bt.stats.trades; acc.pnl += bt.stats.pnl; acc.gp += bt.stats.grossProfit; acc.gl += bt.stats.grossLoss; acc.fees += bt.stats.fees;
  for (const t of bt.trades as any[]) {
    if (t.pnl > 0) acc.wins++;
    acc.r += t.rMultiple ?? 0;
    acc.barsHeld += Math.max(0, ((t.exitAt ?? t.entryAt) - t.entryAt) / tfMs);
    const firstTp = (t.fills ?? []).find((f: any) => String(f.reason).startsWith('tp'));
    if (firstTp) { acc.barsToFirstTp += Math.max(0, (firstTp.at - t.entryAt) / tfMs); acc.firstTpCount++; }
  }
}

interface TradeRow { reason: string; r: number; pnl: number; mfeR: number; afterR: number; heldBars: number }
function excursions(bars: Bar[], t: any, tfMs: number): TradeRow | null {
  const risk = Math.abs(t.entryPrice - (t.slOriginal ?? t.sl ?? t.entryPrice));
  if (!(risk > 0)) return null;
  const dir = t.side === 'long' ? 1 : -1;
  let mfe = 0, after = 0, exitIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.time < t.entryAt) continue;
    if (b.time > (t.exitAt ?? Infinity)) break;
    mfe = Math.max(mfe, ((t.side === 'long' ? b.high : b.low) - t.entryPrice) * dir / risk);
    exitIdx = i;
  }
  if (exitIdx >= 0 && t.exitPrice) {
    for (let i = exitIdx + 1; i <= Math.min(bars.length - 1, exitIdx + HORIZON_BARS); i++) {
      after = Math.max(after, ((t.side === 'long' ? bars[i].high : bars[i].low) - t.exitPrice) * dir / risk);
    }
  }
  return { reason: String(t.exitReason ?? '?'), r: t.rMultiple ?? 0, pnl: t.pnl, mfeR: mfe, afterR: after, heldBars: ((t.exitAt ?? t.entryAt) - t.entryAt) / tfMs };
}

const pool = new PinePool(4, 300_000);
const pooled = new Map<string, Agg>();
const perWindow: Array<Map<string, Agg>> = Array.from({ length: WINDOWS }, () => new Map());
const rows: TradeRow[] = [];
let done = 0, used = 0;

for (const p of pairs) {
  try {
    const product = await rest.product(p.symbol);
    const market = { contractValue: Number(product?.contract_value ?? 0.001), tickSize: Number(product?.tick_size ?? 0.5) };
    const tfMs = TF_SECONDS[p.tf] * 1000;
    const candles = await rest.recentCandles(p.symbol, p.tf, Number(barsArg), TF_SECONDS[p.tf]);
    const bars: Bar[] = candles.slice(0, -1).map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    if (bars.length < 400) { console.error(`skip ${p.id} ${p.symbol}: only ${bars.length} bars`); continue; }
    let m1: Bar[] | undefined;
    if (EXIT_1M) {
      const c1 = await rest.recentCandles(p.symbol, '1m', Math.ceil((bars.length + 2) * tfMs / 60_000), 60);
      m1 = c1.slice(0, -1).map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    }
    const s = registry.get(p.id)!;
    const res = await pool.run({ scannerId: s.id, source: s.patched, symbol: p.symbol, tf: p.tf, tickSize: market.tickSize, bars, tailBars: 'all', plotTail: bars.length, inputs: p.inputs ?? cfg.scanners[p.id]?.inputs });
    if (!res.ok) { console.error(`skip ${p.id} ${p.symbol}: ${res.error}`); continue; }
    const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: cfg.scanners[p.id]?.rule ?? null, bars, mode: 'backtest' });
    const events = extractEvents(res.alerts, res.shapes, { derived });
    used++;

    const size = Math.floor(bars.length / WINDOWS);
    for (const pol of policies) {
      const paper = pol.cfg(cfg.paper);
      const mode = pol.exitMode ?? p.exitMode;
      const run = (b: Bar[]) => {
        const from = b[0].time, to = b.at(-1)!.time;
        return runBacktest({ scannerId: s.id, scannerName: s.id, symbol: p.symbol, tf: p.tf, bars: b, events: events.filter(e => e.barTime >= from && e.barTime <= to), cfg: paper, exitMode: mode, contractValue: market.contractValue, tickSize: market.tickSize, subBars: m1 });
      };
      const whole = run(bars);
      const acc = pooled.get(pol.name) ?? blank();
      accumulate(acc, whole, tfMs); pooled.set(pol.name, acc);
      if (pol.name === policies[0].name) for (const t of whole.trades as any[]) { const r = excursions(bars, t, tfMs); if (r) rows.push(r); }
      for (let w = 0; w < WINDOWS; w++) {
        const slice = bars.slice(w * size, w === WINDOWS - 1 ? bars.length : (w + 1) * size);
        if (slice.length < 60) continue;
        const a = perWindow[w].get(pol.name) ?? blank();
        accumulate(a, run(slice), tfMs); perWindow[w].set(pol.name, a);
      }
    }
  } catch (e: any) {
    console.error(`skip ${p.id} ${p.symbol}: ${e?.message ?? e}`);
  }
  if (++done % 5 === 0) console.error(`… ${done}/${pairs.length} pairs`);
}
await pool.stop();

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
const base = pooled.get(policies[0].name)!;

console.log(`\n${used}/${pairs.length} live pairs · ${barsArg} bars of ${tfArg} · ${WINDOWS} walk-forward windows · ${rows.length} trades under the live policy\n`);

console.log('EXIT REASONS (live policy) — captured versus available');
console.log('reason        trades     pnl   avgR  avg best  captured   further after exit   bars held');
const byReason = new Map<string, TradeRow[]>();
for (const r of rows) { const l = byReason.get(r.reason) ?? []; l.push(r); byReason.set(r.reason, l); }
for (const [reason, list] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const avg = (f: (r: TradeRow) => number) => list.reduce((a, r) => a + f(r), 0) / list.length;
  const mfe = avg(r => r.mfeR), r = avg(t => t.r);
  const cap = r > 0 && mfe > 0 ? `${(r / mfe * 100).toFixed(0)}%` : '-';
  console.log(`${pad(reason, 12)} ${String(list.length).padStart(6)} ${list.reduce((a, t) => a + t.pnl, 0).toFixed(0).padStart(7)} ${r.toFixed(2).padStart(6)} ${mfe.toFixed(2).padStart(9)} ${cap.padStart(9)} ${avg(t => t.afterR).toFixed(2).padStart(20)} ${avg(t => t.heldBars).toFixed(1).padStart(10)}`);
}
const winners = rows.filter(r => r.r > 0);
const mean = (l: TradeRow[], f: (r: TradeRow) => number) => (l.length ? l.reduce((a, r) => a + f(r), 0) / l.length : 0);
console.log(`\nwinners ${winners.length}: captured ${mean(winners, r => r.r).toFixed(2)}R of ${mean(winners, r => r.mfeR).toFixed(2)}R shown (${(mean(winners, r => r.r) / Math.max(1e-9, mean(winners, r => r.mfeR)) * 100).toFixed(0)}%)`);
// how many trades ever reach the level a trailing stop needs before it can protect anything
const bucket = (lo: number, hi: number) => rows.filter(r => r.mfeR >= lo && r.mfeR < hi).length;
console.log('best unrealised R ever reached, all trades:');
for (const [lo, hi, label] of [[0, 0.25, 'under 0.25R'], [0.25, 0.5, '0.25 to 0.5R'], [0.5, 1, '0.5 to 1R'], [1, 2, '1 to 2R'], [2, 1e9, '2R or more']] as Array<[number, number, string]>) {
  const n = bucket(lo, hi);
  console.log(`  ${label.padEnd(14)} ${String(n).padStart(5)}  ${(n / Math.max(1, rows.length) * 100).toFixed(0).padStart(3)}%`);
}
console.log(`  never reached 1R: ${(rows.filter(r => r.mfeR < 1).length / Math.max(1, rows.length) * 100).toFixed(0)}% of trades — no exit rule can bank what these never showed`);
// the prize: losers that were green first, and by how much
const losers = rows.filter(r => r.r <= 0);
console.log(`\nlosing trades ${losers.length} — how far green did they get before turning?`);
let prize = 0;
for (const [lo, hi, label] of [[0, 0.1, 'never above 0.1R'], [0.1, 0.25, '0.1 to 0.25R'], [0.25, 0.5, '0.25 to 0.5R'], [0.5, 1, '0.5 to 1R'], [1, 1e9, '1R or more']] as Array<[number, number, string]>) {
  const l = losers.filter(r => r.mfeR >= lo && r.mfeR < hi);
  if (lo >= 0.25) prize += l.length;
  console.log(`  ${label.padEnd(18)} ${String(l.length).padStart(5)}  ${(l.length / Math.max(1, losers.length) * 100).toFixed(0).padStart(3)}%  avg lost ${(l.reduce((a, r) => a + r.r, 0) / Math.max(1, l.length)).toFixed(2)}R`);
}
console.log(`  reachable: ${prize} losers (${(prize / Math.max(1, rows.length) * 100).toFixed(0)}% of all trades) showed 0.25R or better before failing`);

console.log('\nPOOLED OVER THE WHOLE SPAN');
console.log('policy                           trades     net     PF   win%   avgR   fees  bars held  to 1st TP   net/bar');
for (const pol of policies) {
  const a = pooled.get(pol.name); if (!a || !a.trades) continue;
  const delta = pol.name === policies[0].name ? '' : ` (${a.pnl - base.pnl >= 0 ? '+' : ''}${(a.pnl - base.pnl).toFixed(0)})`;
  console.log(`${pad(pol.name, 30)} ${String(a.trades).padStart(6)} ${a.pnl.toFixed(0).padStart(7)} ${(Number.isFinite(pf(a)) ? pf(a).toFixed(2) : '∞').padStart(6)} ${(a.wins / a.trades * 100).toFixed(0).padStart(5)}% ${(a.r / a.trades).toFixed(2).padStart(6)} ${a.fees.toFixed(0).padStart(6)} ${(a.barsHeld / a.trades).toFixed(1).padStart(10)} ${(a.firstTpCount ? (a.barsToFirstTp / a.firstTpCount).toFixed(1) : '-').padStart(10)} ${(a.pnl / Math.max(1, a.barsHeld)).toFixed(3).padStart(9)}${delta}`);
}

console.log('\nWALK-FORWARD — the same fixed policy measured on each window separately');
console.log(`policy                         ${Array.from({ length: WINDOWS }, (_, i) => `w${i + 1}`.padStart(7)).join('')}     won   median`);
const winCount = new Map<string, number>();
for (const pol of policies) {
  const cells: string[] = []; let won = 0; const vals: number[] = [];
  for (let w = 0; w < WINDOWS; w++) {
    const a = perWindow[w].get(pol.name);
    if (!a || !a.trades) { cells.push('      -'); continue; }
    cells.push(a.pnl.toFixed(0).padStart(7));
    vals.push(a.pnl);
    if (a.pnl > 0) won++;
  }
  winCount.set(pol.name, won);
  const sorted = [...vals].sort((x, y) => x - y);
  const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  console.log(`${pad(pol.name, 30)} ${cells.join('')} ${String(won).padStart(6)}/${vals.length} ${med.toFixed(0).padStart(8)}`);
}

// realistic selection: choose on window w, trade window w+1
let picked = 0, oracle = 0, liveSum = 0;
const chosen: string[] = [];
for (let w = 1; w < WINDOWS; w++) {
  let bestPrev = policies[0].name, bestPrevPnl = -Infinity;
  for (const pol of policies) { const a = perWindow[w - 1].get(pol.name); if (a && a.trades && a.pnl > bestPrevPnl) { bestPrevPnl = a.pnl; bestPrev = pol.name; } }
  let bestNow = -Infinity;
  for (const pol of policies) { const a = perWindow[w].get(pol.name); if (a && a.trades) bestNow = Math.max(bestNow, a.pnl); }
  picked += perWindow[w].get(bestPrev)?.pnl ?? 0;
  oracle += Number.isFinite(bestNow) ? bestNow : 0;
  liveSum += perWindow[w].get(policies[0].name)?.pnl ?? 0;
  chosen.push(bestPrev);
}
console.log(`\nselecting on each window and trading the next: ${picked.toFixed(0)}  ·  staying on the live policy: ${liveSum.toFixed(0)}  ·  perfect hindsight: ${oracle.toFixed(0)}`);
console.log(`what selection would have picked: ${[...new Set(chosen)].join(', ')}`);
const stable = policies.filter(p => (winCount.get(p.name) ?? 0) >= Math.ceil(WINDOWS * 0.6)).map(p => `${p.name} (${winCount.get(p.name)}/${WINDOWS})`);
console.log(`profitable in at least 60% of windows: ${stable.length ? stable.join(', ') : 'none'}`);
