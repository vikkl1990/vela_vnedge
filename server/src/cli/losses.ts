/**
 * Deep research into losing trades.
 *
 *   npm run losses -- [BARS] [TF] [WINDOWS]
 *
 * Runs every enabled scanner/symbol pair once through PineTS under the live configuration,
 * collects every resulting trade with its entry features, and asks three questions:
 *
 *   1. How do losses happen?  Immediate rejection, slow bleed, or a round trip from profit.
 *   2. What conditions precede them?  Every feature is bucketed and scored by expectancy.
 *   3. Does the condition hold up?  Each candidate is re-checked in each of `WINDOWS`
 *      consecutive, non-overlapping slices of the same history. A condition that is only
 *      negative in one slice is noise, and is reported as such rather than as a finding.
 *
 * Nothing here changes configuration. It prints evidence.
 */
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import { FEATURE_NAMES, FEATURE_LABELS } from '../ml/features.ts';
import type { Bar } from '../data/candleStore.ts';

const [barsArg = '4000', tfArg = '15m', windowsArg = '8'] = process.argv.slice(2);
const WINDOWS = Math.max(2, Number(windowsArg));
const MIN_BUCKET = 40;          // a slice smaller than this cannot support a claim
const MIN_WINDOWS_AGREE = 0.6;  // fraction of windows a condition must hold in

const cfg = new ConfigStore().get();
const registry = new ScannerRegistry();
const rest = new DeltaRest();

interface T {
  scanner: string; symbol: string; side: 'long' | 'short';
  r: number; pnl: number; fees: number; reason: string;
  mfeR: number; maeR: number; bars: number; win: number;
  f: Record<string, number>;
}

const pairs: Array<{ id: string; symbol: string; tf: string; exitMode: 'levels' | 'script' | 'both' }> = [];
for (const s of registry.all()) {
  const sc = cfg.scanners[s.id];
  if (!sc?.enabled || sc.hidden || s.status !== 'ok') continue;
  for (const symbol of sc.symbols ?? cfg.symbols) for (const tf of sc.timeframes ?? [tfArg]) pairs.push({ id: s.id, symbol, tf, exitMode: sc.exitMode ?? 'both' });
}
if (!pairs.length) { console.error('no enabled scanner/symbol pairs'); process.exit(1); }

const pool = new PinePool(4, 300_000);
const trades: T[] = [];
let done = 0;

for (const p of pairs) {
  try {
    const product = await rest.product(p.symbol);
    const market = { contractValue: Number(product?.contract_value ?? 0.001), tickSize: Number(product?.tick_size ?? 0.5) };
    const tfMs = TF_SECONDS[p.tf] * 1000;
    const candles = await rest.recentCandles(p.symbol, p.tf, Number(barsArg), TF_SECONDS[p.tf]);
    const bars: Bar[] = candles.slice(0, -1).map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    if (bars.length < 400) continue;
    const s = registry.get(p.id)!;
    const res = await pool.run({ scannerId: s.id, source: s.patched, symbol: p.symbol, tf: p.tf, tickSize: market.tickSize, bars, tailBars: 'all', plotTail: bars.length, inputs: cfg.scanners[p.id]?.inputs });
    if (!res.ok) continue;
    const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: cfg.scanners[p.id]?.rule ?? null, bars, mode: 'backtest' });
    const events = extractEvents(res.alerts, res.shapes, { derived });
    const bt = runBacktest({ scannerId: s.id, scannerName: s.id, symbol: p.symbol, tf: p.tf, bars, events, cfg: cfg.paper, exitMode: p.exitMode, contractValue: market.contractValue, tickSize: market.tickSize });
    const size = Math.floor(bars.length / WINDOWS);
    const idxOf = (t: number) => Math.min(WINDOWS - 1, Math.max(0, Math.floor((bars.findIndex(b => b.time >= t)) / size)));
    for (const t of bt.trades as any[]) {
      if (!t.features) continue;
      const risk = Math.abs(t.entryPrice - (t.slOriginal ?? t.sl ?? t.entryPrice));
      if (!(risk > 0)) continue;
      const dir = t.side === 'long' ? 1 : -1;
      let mfe = 0, mae = 0;
      for (const b of bars) {
        if (b.time < t.entryAt) continue;
        if (b.time > (t.exitAt ?? Infinity)) break;
        mfe = Math.max(mfe, ((t.side === 'long' ? b.high : b.low) - t.entryPrice) * dir / risk);
        mae = Math.min(mae, ((t.side === 'long' ? b.low : b.high) - t.entryPrice) * dir / risk);
      }
      trades.push({
        scanner: s.id, symbol: p.symbol, side: t.side, r: t.rMultiple ?? 0, pnl: t.pnl, fees: t.fees ?? 0,
        reason: String(t.exitReason ?? '?'), mfeR: mfe, maeR: mae,
        bars: ((t.exitAt ?? t.entryAt) - t.entryAt) / tfMs, win: idxOf(t.entryAt), f: t.features,
      });
    }
  } catch { /* skipped pair */ }
  if (++done % 5 === 0) console.error(`… ${done}/${pairs.length} pairs`);
}
await pool.stop();

// ---------- helpers ----------
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (n: number, d: number) => (d ? (n / d * 100) : 0);
const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
const losers = trades.filter(t => t.r <= 0);
const winners = trades.filter(t => t.r > 0);
const baseExp = mean(trades.map(t => t.r));
const baseLossRate = pct(losers.length, trades.length);

/** Expectancy in R, loss rate, and how consistently the slice is negative across windows. */
function score(sel: T[]) {
  const exp = mean(sel.map(t => t.r));
  let negWindows = 0, seen = 0;
  for (let w = 0; w < WINDOWS; w++) {
    const s = sel.filter(t => t.win === w);
    if (s.length < 8) continue;
    seen++;
    if (mean(s.map(t => t.r)) < baseExp) negWindows++;
  }
  return { n: sel.length, exp, lossRate: pct(sel.filter(t => t.r <= 0).length, sel.length), pnl: sel.reduce((a, t) => a + t.pnl, 0), negWindows, seen };
}

console.log(`\n${pairs.length} live pairs · ${barsArg} bars of ${tfArg} · ${trades.length} trades · ${WINDOWS} windows`);
console.log(`baseline: expectancy ${baseExp.toFixed(3)}R · loss rate ${baseLossRate.toFixed(1)}% · net ${trades.reduce((a, t) => a + t.pnl, 0).toFixed(0)}\n`);

// ---------- 1. anatomy of a loss ----------
console.log('HOW LOSSES HAPPEN');
const buckets: Array<[string, (t: T) => boolean]> = [
  ['never went green (MFE < 0.1R)', t => t.mfeR < 0.1],
  ['small pop then failed (0.1–0.5R)', t => t.mfeR >= 0.1 && t.mfeR < 0.5],
  ['real move then failed (0.5–1R)', t => t.mfeR >= 0.5 && t.mfeR < 1],
  ['round trip from 1R+', t => t.mfeR >= 1],
];
for (const [label, f] of buckets) {
  const sel = losers.filter(f);
  console.log(`  ${pad(label, 34)} ${String(sel.length).padStart(5)}  ${pct(sel.length, losers.length).toFixed(0).padStart(3)}% of losses  avg ${mean(sel.map(t => t.r)).toFixed(2)}R  held ${mean(sel.map(t => t.bars)).toFixed(1)} bars  fees ${mean(sel.map(t => t.fees)).toFixed(2)}`);
}
const feeShare = pct(losers.reduce((a, t) => a + t.fees, 0), Math.abs(losers.reduce((a, t) => a + t.pnl, 0)));
console.log(`  fees are ${feeShare.toFixed(1)}% of gross losses; average loss ${mean(losers.map(t => t.r)).toFixed(2)}R against average win ${mean(winners.map(t => t.r)).toFixed(2)}R`);
console.log(`  average worst excursion: losers ${mean(losers.map(t => t.maeR)).toFixed(2)}R, winners ${mean(winners.map(t => t.maeR)).toFixed(2)}R`);

// ---------- 2. categorical slices ----------
function categorical(name: string, key: (t: T) => string, limit = 8) {
  const groups = new Map<string, T[]>();
  for (const t of trades) { const k = key(t); const l = groups.get(k); if (l) l.push(t); else groups.set(k, [t]); }
  const rows = [...groups.entries()].map(([k, v]) => ({ k, ...score(v) })).filter(r => r.n >= MIN_BUCKET).sort((a, b) => a.exp - b.exp);
  if (!rows.length) return;
  console.log(`\n${name} — worst first (n ≥ ${MIN_BUCKET})`);
  console.log(`  ${pad('bucket', 30)} ${'n'.padStart(5)} ${'exp R'.padStart(7)} ${'loss%'.padStart(6)} ${'net'.padStart(7)}  windows below baseline`);
  for (const r of rows.slice(0, limit)) {
    console.log(`  ${pad(r.k, 30)} ${String(r.n).padStart(5)} ${r.exp.toFixed(3).padStart(7)} ${r.lossRate.toFixed(0).padStart(5)}% ${r.pnl.toFixed(0).padStart(7)}  ${r.negWindows}/${r.seen}`);
  }
}
categorical('BY SCANNER', t => t.scanner, 8);
categorical('BY SYMBOL', t => t.symbol, 8);
categorical('BY SIDE', t => t.side, 4);
categorical('BY LEVEL SOURCE', t => (t.f.lvl_script ? 'script levels' : 'ATR fallback'), 4);
categorical('BY SESSION (UTC)', t => { const h = t.f.hour; return h < 6 ? '00–06 Asia' : h < 12 ? '06–12 Europe pre' : h < 18 ? '12–18 Europe/US' : '18–24 US late'; }, 4);

// ---------- 3. feature buckets, validated across windows ----------
console.log(`\nENTRY CONDITIONS — every feature split at its median and quartiles, worst slices first`);
console.log(`  a slice counts as a finding only if it is below baseline in ≥ ${Math.round(MIN_WINDOWS_AGREE * 100)}% of windows it appears in\n`);
type Cand = { label: string; feature: string } & ReturnType<typeof score>;
const cands: Cand[] = [];
for (const name of FEATURE_NAMES) {
  const vals = trades.map(t => t.f[name]).filter(v => Number.isFinite(v));
  if (new Set(vals).size < 3) {           // binary flag
    for (const v of [...new Set(vals)]) {
      const sel = trades.filter(t => t.f[name] === v);
      if (sel.length >= MIN_BUCKET) cands.push({ label: `${name} = ${v}`, feature: name, ...score(sel) });
    }
    continue;
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.floor(sorted.length * p)];
  const edges: Array<[string, number, number]> = [
    ['bottom quartile', -Infinity, q(0.25)], ['lower middle', q(0.25), q(0.5)],
    ['upper middle', q(0.5), q(0.75)], ['top quartile', q(0.75), Infinity],
  ];
  for (const [lab, lo, hi] of edges) {
    const sel = trades.filter(t => t.f[name] > lo && t.f[name] <= hi);
    if (sel.length >= MIN_BUCKET) cands.push({ label: `${name} ${lab} (${lo === -Infinity ? '≤' + hi.toFixed(2) : hi === Infinity ? '>' + lo.toFixed(2) : lo.toFixed(2) + '–' + hi.toFixed(2)})`, feature: name, ...score(sel) });
  }
}
const stable = cands.filter(c => c.exp < baseExp && c.seen >= 3 && c.negWindows / c.seen >= MIN_WINDOWS_AGREE).sort((a, b) => a.exp - b.exp);
const unstable = cands.filter(c => c.exp < baseExp && !(c.seen >= 3 && c.negWindows / c.seen >= MIN_WINDOWS_AGREE)).sort((a, b) => a.exp - b.exp);
console.log(`  ${pad('condition', 46)} ${'n'.padStart(5)} ${'exp R'.padStart(7)} ${'loss%'.padStart(6)} ${'net'.padStart(7)}  windows`);
for (const c of stable.slice(0, 12)) console.log(`  ${pad(c.label, 46)} ${String(c.n).padStart(5)} ${c.exp.toFixed(3).padStart(7)} ${c.lossRate.toFixed(0).padStart(5)}% ${c.pnl.toFixed(0).padStart(7)}  ${c.negWindows}/${c.seen}`);
if (!stable.length) console.log('  none survived the cross-window check');
console.log(`\n  did NOT hold up across windows (report as noise, not signal):`);
for (const c of unstable.slice(0, 5)) console.log(`  ${pad(c.label, 46)} ${String(c.n).padStart(5)} ${c.exp.toFixed(3).padStart(7)} ${c.lossRate.toFixed(0).padStart(5)}% ${c.pnl.toFixed(0).padStart(7)}  ${c.negWindows}/${c.seen}`);
for (const c of stable.slice(0, 3)) console.log(`\n  ${c.label}: ${FEATURE_LABELS[c.feature as keyof typeof FEATURE_LABELS] ?? c.feature}`);

// ---------- 4. concrete filters: what would each be worth ----------
console.log('\nCANDIDATE FILTERS — trades kept, and what the fleet would have earned without them');
console.log(`  ${pad('filter (trades it removes)', 44)} ${'kept'.padStart(5)} ${'exp R'.padStart(7)} ${'net'.padStart(7)} ${'Δnet'.padStart(7)}  windows improved`);
const filters: Array<[string, (t: T) => boolean]> = [
  ['late US session 18–24 UTC', t => t.f.hour >= 18],
  ['far below EMA200 (trend200 ≤ -1.49)', t => t.f.trend200 <= -1.49],
  ['ai-predictive-flow on UNIUSD', t => t.scanner === 'ai-predictive-flow-zeiierman' && t.symbol === 'UNIUSD'],
  ['all shorts', t => t.side === 'short'],
  ['quietest volume quartile', t => t.f.vol_ratio <= 0.68],
  ['session + far below EMA200', t => t.f.hour >= 18 || t.f.trend200 <= -1.49],
  ['session + ai-flow/UNI', t => t.f.hour >= 18 || (t.scanner === 'ai-predictive-flow-zeiierman' && t.symbol === 'UNIUSD')],
];
const baseNet = trades.reduce((a, t) => a + t.pnl, 0);
const netOf = (sel: T[]) => sel.reduce((a, t) => a + t.pnl, 0);
for (const [label, drop] of filters) {
  const keptSel = trades.filter(t => !drop(t));
  if (!keptSel.length) continue;
  let improved = 0, seen = 0;
  for (let w = 0; w < WINDOWS; w++) {
    const all = trades.filter(t => t.win === w);
    const k = keptSel.filter(t => t.win === w);
    if (all.length < 20 || k.length < 8) continue;
    seen++;
    if (netOf(k) > netOf(all)) improved++;
  }
  const net = netOf(keptSel);
  console.log(`  ${pad(label, 44)} ${String(keptSel.length).padStart(5)} ${mean(keptSel.map(t => t.r)).toFixed(3).padStart(7)} ${net.toFixed(0).padStart(7)} ${(net - baseNet >= 0 ? '+' : '') + (net - baseNet).toFixed(0)}  ${improved}/${seen}`);
}
console.log(`  ${pad('trade everything (baseline)', 44)} ${String(trades.length).padStart(5)} ${baseExp.toFixed(3).padStart(7)} ${baseNet.toFixed(0).padStart(7)}       -`);
console.log(`\nnote: a filter that raises expectancy while lowering net is removing profitable trades.`);
const anyNegative = cands.filter(c => c.exp < 0 && c.n >= MIN_BUCKET);
console.log(`conditions with outright negative expectancy and n ≥ ${MIN_BUCKET}: ${anyNegative.length ? anyNegative.map(c => c.label).join(', ') : 'none'}`);
