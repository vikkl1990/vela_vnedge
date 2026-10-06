/**
 * Scanner test (decision 67): for every script × market × timeframe, not "does it pay" but "why
 * does it not, and what would fix it". Every variant below is judged from the same script run and
 * the same events, so the differences are the reading, the exit or the costs — never a different
 * signal set.
 *
 *   IDS=ids.txt TFS=15m,1h,4h MARKETS=BTCUSD,… PAPER=vm-paper.json OUT=diag.tsv MD=diag.md npm run diagnose
 *
 * Variants per cell:
 *   base        the fleet's settings (the VM's paper config)
 *   gross       no fees, no slippage — the edge before costs
 *   stop1.5/2   a wider ATR stop (same targets)
 *   tp1         one target at 1R, no trail — do the moves it finds reach 1R at all
 *   levels      only our ATR levels (script exits ignored); script: only the script's own exits
 *   er0.25      the whipsaw gate (decision 66)
 *   inverted    every signal read the other way — a sign error in the reading shows up here
 *   long/short  one direction only
 * Plus the excursion profile (how many trades saw +0.5R / +1R / +2R before they ended, how many
 * were stopped inside the first bar) and the record per signal label. The verdict names the cause
 * the numbers support and the fix to try, in the script or in how it is read.
 */
import fs from 'node:fs';
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents, type ScanEvent } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest, type BacktestInput } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS, type PaperConfig } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';

const cfg = new ConfigStore().get();
if (process.env.PAPER) Object.assign(cfg.paper, JSON.parse(fs.readFileSync(process.env.PAPER, 'utf8')));
const ids = [...new Set(fs.readFileSync(process.env.IDS!, 'utf8').split(/\s+/).filter(Boolean))];
const TFS = (process.env.TFS ?? '15m,1h,4h').split(',');
const MARKETS = (process.env.MARKETS ?? 'BTCUSD,ETHUSD,SOLUSD').split(',');
const CONC = Number(process.env.CONCURRENCY ?? 4);
const BARS: Record<string, number> = { '5m': 4000, '15m': 8000, '1h': 4000, '4h': 2000 };
const SUB: Record<string, string> = { '5m': '1m', '15m': '1m', '1h': '15m', '4h': '15m' };
const rest = new DeltaRest();
const registry = new ScannerRegistry();
const pool = new PinePool(CONC, 120_000);
const out = fs.createWriteStream(process.env.OUT ?? '/tmp/diagnose.tsv');
out.write(['scanner', 'tf', 'symbol', 'variant', 'trades', 'avgR', 'sumR', 'win', 't1', 'r1', 't2', 'r2', 'both', 'mfe05', 'mfe1', 'mfe2', 'firstBarStops', 'note'].join('\t') + '\n');
const md: string[] = [];

const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
const series = new Map<string, Bar[]>();
async function bars(symbol: string, tf: string, n: number): Promise<Bar[]> {
  const k = `${symbol}:${tf}`;
  if (!series.has(k)) series.set(k, toBars(await rest.recentCandles(symbol, tf, n, TF_SECONDS[tf])));
  return series.get(k)!;
}
const market = new Map<string, { contractValue: number; tickSize: number }>();
for (const s of MARKETS) { const p = await rest.product(s); market.set(s, { contractValue: Number(p?.contract_value ?? 0.001), tickSize: Number(p?.tick_size ?? 0.5) }); }
for (const s of MARKETS) for (const tf of TFS) { const b = await bars(s, tf, BARS[tf]); await bars(s, SUB[tf], Math.min(60_000, Math.ceil((b.length + 2) * TF_SECONDS[tf] / TF_SECONDS[SUB[tf]]))); }
console.error('candles ready');

type Stat = { trades: number; avgR: number; sumR: number; win: number; t1: number; r1: number; t2: number; r2: number; both: boolean; mfe05: number; mfe1: number; mfe2: number; firstBar: number };
function stat(trades: any[], b: Bar[], tfMs: number): Stat {
  const R = (xs: any[]) => (xs.length ? xs.reduce((a, x) => a + (x.rMultiple ?? 0), 0) / xs.length : 0);
  const split = b[Math.floor(b.length / 2)].time;
  const h1 = trades.filter(x => x.entryAt < split), h2 = trades.filter(x => x.entryAt >= split);
  const pk = (t: number) => (trades.length ? trades.filter(x => (x.peakR ?? 0) >= t).length / trades.length : 0);
  const fb = trades.filter(x => x.exitReason === 'sl' && x.exitAt - x.entryAt <= tfMs * 2).length;
  return { trades: trades.length, avgR: R(trades), sumR: R(trades) * trades.length, win: trades.length ? trades.filter(x => x.pnl > 0).length / trades.length : 0, t1: h1.length, r1: R(h1), t2: h2.length, r2: R(h2), both: h1.length >= 5 && h2.length >= 5 && R(h1) > 0 && R(h2) > 0, mfe05: pk(0.5), mfe1: pk(1), mfe2: pk(2), firstBar: trades.length ? fb / trades.length : 0 };
}
const row = (id: string, tf: string, sym: string, v: string, s: Stat, note = '') => out.write([id, tf, sym, v, s.trades, s.avgR.toFixed(3), s.sumR.toFixed(1), s.win.toFixed(2), s.t1, s.r1.toFixed(3), s.t2, s.r2.toFixed(3), s.both ? 1 : 0, s.mfe05.toFixed(2), s.mfe1.toFixed(2), s.mfe2.toFixed(2), s.firstBar.toFixed(2), note].join('\t') + '\n');

const flip = (evs: ScanEvent[]): ScanEvent[] => evs.map(e => (e.side ? { ...e, side: e.side === 'long' ? 'short' : 'long', sl: undefined, tp: [] } : e));
/**
 * One-bar confirmation (decision 81): an entry is taken at the close of the bar AFTER the signal bar, and
 * only if that bar closed in the trade's direction. The journal's stop exits were hit within the first bar
 * with no favourable excursion — late entries into a move that reversed — and this is the cheapest test of it.
 */
const confirm = (evs: ScanEvent[], bars: Bar[]): ScanEvent[] => {
  const at = new Map<number, number>(); bars.forEach((b, i) => at.set(b.time, i));
  const out: ScanEvent[] = [];
  for (const e of evs) {
    if (e.kind !== 'entry' || !e.side) { out.push(e); continue; }
    const i = at.get(e.barTime); const next = i !== undefined ? bars[i + 1] : undefined;
    if (i === undefined || !next) continue;
    const held = e.side === 'long' ? next.close > bars[i].close : next.close < bars[i].close;
    if (!held) continue;
    out.push({ ...e, barTime: next.time, barIndex: i + 1, price: undefined, label: `${e.label} (confirmed)` });
  }
  return out;
};

interface CellResult { id: string; tf: string; sym: string; variants: Record<string, Stat>; labels: Array<[string, Stat]>; verdict: string; fix: string }
async function cell(id: string, tf: string, sym: string): Promise<CellResult | null> {
  const s = registry.get(id); if (!s || s.status !== 'ok') return null;
  const b = await bars(sym, tf, BARS[tf]); const sub = series.get(`${sym}:${SUB[tf]}`); const m = market.get(sym)!;
  const sc = cfg.scanners[id] ?? {};
  const res = await pool.run({ scannerId: id, source: s.patched, symbol: sym, tf, tickSize: m.tickSize, bars: b, tailBars: 'all', plotTail: b.length, inputs: sc.inputs && Object.keys(sc.inputs).length ? sc.inputs : undefined, timezone: sc.timezone });
  if (!res.ok) { md.push(`- ${id} · ${sym} ${tf}: **did not run** — ${res.error}`); return null; }
  const derived = applyRules({ scannerId: id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: sc.rule ?? null, bars: b, mode: 'backtest' });
  const events = extractEvents(res.alerts, res.shapes, { derived, sources: sc.sources, edge: sc.edge, labels: sc.labels, invert: sc.invert });
  const tfMs = TF_SECONDS[tf] * 1000;
  if (!events.some(e => e.kind === 'entry')) {
    // a zero-entry cell is a result, not a hole: say what came out of the run and where the funnel emptied
    const nAlert = res.alerts.filter(a => a.type === 'alert').length, nCond = res.alerts.filter(a => a.type === 'alertcondition').length;
    const nShape = res.shapes.reduce((a, s) => a + s.times.length, 0);
    const exits = events.filter(e => e.kind === 'exit').length, info = events.filter(e => e.kind === 'info').length;
    const why = !nAlert && !nCond && !nShape && !res.labels.length ? (res.plots.length ? 'NO SIGNAL CHANNEL: plots only (a feature source, not an entry system)' : 'SILENT: no alert, condition, shape, label or plot')
      : !nAlert && !nCond && !nShape ? `OUTPUT NOT MAPPED: ${res.labels.length} drawn labels, no alert/condition/shape`
      : exits && !info ? `EXITS ONLY: ${exits} exit events, no entry` : `NO ENTRY READ: ${nAlert} alert(), ${nCond} conditions, ${nShape} shape hits → ${info} info, ${exits} exits, 0 entries`;
    const empty = stat([], b, tfMs);
    row(id, tf, sym, 'base', empty, why);
    md.push(`- ${id} · ${sym} ${tf}: **no entries** — ${why}`);
    return { id, tf, sym, variants: { base: empty }, labels: [], verdict: why, fix: why.startsWith('NO ENTRY READ') ? 'name the entry channel/labels in the scanner config, or add a rule' : why.startsWith('EXITS') ? 'an exit tool: pair it with an entry system in the exit lab' : 'a feature adapter, not a scanner' };
  }
  const base: BacktestInput = { scannerId: id, scannerName: id, symbol: sym, tf, bars: b, events, cfg: cfg.paper, exitMode: sc.exitMode ?? 'both', trendGate: sc.trendGate, contractValue: m.contractValue, tickSize: m.tickSize, subBars: sub } as any;
  const run = (patch: Partial<BacktestInput>, paper: Partial<PaperConfig> = {}) => runBacktest({ ...base, ...patch, cfg: { ...cfg.paper, ...paper } }).trades as any[];
  const variants: Record<string, Stat> = {};
  variants.base = stat(run({}), b, tfMs);
  variants.gross = stat(run({}, { feeRatePct: 0, feeTaxPct: 0, slippageBps: 2 }), b, tfMs);
  variants['stop1.5'] = stat(run({}, { fallbackAtrSl: cfg.paper.fallbackAtrSl * 1.5 }), b, tfMs);
  variants.stop2 = stat(run({}, { fallbackAtrSl: cfg.paper.fallbackAtrSl * 2 }), b, tfMs);
  variants.tp1 = stat(run({}, { scriptTargets: 'ignore', fallbackRR: [1, 1, 1], tpSplit: [1, 0, 0], trailAfterR: 99, floorAtR: 99 } as any), b, tfMs);
  variants.levels = stat(run({ exitMode: 'levels' }), b, tfMs);
  if (events.some(e => e.kind === 'exit') || events.some(e => e.kind === 'entry' && (e.sl || e.tp?.length))) variants.script = stat(run({ exitMode: 'script' }), b, tfMs);
  variants['er0.25'] = stat(run({ chopGate: { minEr: 0.25 } }), b, tfMs);
  variants.confirm1 = stat(run({ events: confirm(events, b) }), b, tfMs);
  variants['er+stop1.5'] = stat(run({ chopGate: { minEr: 0.25 } }, { fallbackAtrSl: cfg.paper.fallbackAtrSl * 1.5 }), b, tfMs);
  variants['er+stop2'] = stat(run({ chopGate: { minEr: 0.25 } }, { fallbackAtrSl: cfg.paper.fallbackAtrSl * 2 }), b, tfMs);
  variants['confirm1+er'] = stat(run({ events: confirm(events, b), chopGate: { minEr: 0.25 } }), b, tfMs);
  variants.inverted = stat(run({ events: flip(events) }), b, tfMs);
  variants.long = stat(run({ events: events.filter(e => e.kind !== 'entry' || e.side === 'long') }), b, tfMs);
  variants.short = stat(run({ events: events.filter(e => e.kind !== 'entry' || e.side === 'short') }), b, tfMs);
  // per label: the base run's trades mapped back to the signal that opened them
  const byLabel = new Map<string, any[]>();
  const sig = new Map<string, string>(); for (const e of events) if (e.kind === 'entry') sig.set(`${e.barTime}:${e.side}`, `${e.source}:${(e.label ?? '').slice(0, 30)}`);
  for (const t of run({})) { const k = sig.get(`${t.entryAt}:${t.side}`) ?? 'unknown'; byLabel.set(k, [...(byLabel.get(k) ?? []), t]); }
  const labels: Array<[string, Stat]> = [...byLabel].filter(([, ts]) => ts.length >= 10).map(([k, ts]) => [k, stat(ts, b, tfMs)] as [string, Stat]).sort((a, c) => c[1].sumR - a[1].sumR);
  for (const [v, st] of Object.entries(variants)) row(id, tf, sym, v, st);
  for (const [k, st] of labels) row(id, tf, sym, `label:${k}`, st);
  const { verdict, fix } = diagnose(variants, labels);
  row(id, tf, sym, 'verdict', variants.base, `${verdict} → ${fix}`);
  return { id, tf, sym, variants, labels, verdict, fix };
}

/** The cause the numbers support, in order of what would be the cheapest real fix. */
function diagnose(v: Record<string, Stat>, labels: Array<[string, Stat]>): { verdict: string; fix: string } {
  const b = v.base;
  if (b.trades < 20) return { verdict: 'too few trades to say', fix: 'more history or a faster timeframe before judging' };
  if (b.both) return { verdict: 'pays as read', fix: 'nothing to fix; measure in shadow' };
  if (v.inverted.both && v.inverted.avgR > 0.1) return { verdict: 'READING: direction inverted', fix: 'the signals mean the opposite of how they are read (a warning read as an entry, a state read as a flip); invert or restrict the source' };
  const bad = labels.filter(([, s]) => s.avgR < -0.15 && s.trades >= 20), good = labels.filter(([, s]) => s.both);
  if (bad.length && good.length) return { verdict: `READING: label mix (${bad.map(([k]) => k).join(', ')} lose; ${good.map(([k]) => k).join(', ')} pay)`, fix: 'read only the paying channel/label (sources or a label allow-list in the scanner config)' };
  if (v.long.both && !v.short.both && v.short.avgR < -0.1) return { verdict: 'READING: shorts lose, longs pay', fix: 'long-only on this market (the script\'s short logic does not transfer)' };
  if (v.short.both && !v.long.both && v.long.avgR < -0.1) return { verdict: 'READING: longs lose, shorts pay', fix: 'short-only on this market' };
  if (v.script && v.script.both && !b.both) return { verdict: "EXIT: the script's own exits pay, ours do not", fix: 'exitMode script for this scanner (its stop/target logic is the strategy)' };
  if (v.levels.both && !b.both) return { verdict: 'EXIT: the script\'s exits hurt; our levels alone pay', fix: 'exitMode levels (ignore the script\'s exit/flip signals)' };
  if (v.tp1.both && b.mfe1 >= 0.35) return { verdict: 'EXIT: moves reach 1R but the trail gives it back', fix: 'take 1R (or part) instead of trailing from 0.5R on this scanner' };
  if ((v['stop1.5'].both || v.stop2.both) && b.firstBar >= 0.3) return { verdict: 'STOP: too tight for this market\'s bar size (first-bar stops)', fix: `fallbackAtrSl ${v.stop2.both ? '2' : '1.5'}× for this scanner` };
  if (v.gross.both && !b.both) return { verdict: 'COSTS: positive before fees, negative after', fix: 'a slower timeframe or a wider stop/target so each trade pays the round trip several times over' };
  if (v['er0.25'].both) return { verdict: 'WHIPSAW: pays only when the market is moving efficiently', fix: 'efficiency-ratio gate ≥ 0.25 on this timeframe' };
  if (b.mfe05 < 0.35) return { verdict: 'ENTRY: most trades never see +0.5R', fix: 'the signal is late or the stop sits inside the noise; try the slower timeframe or the script\'s confirmation inputs' };
  return { verdict: 'no variant pays in both halves', fix: 'not a reading, exit or cost problem on this cell; re-time or retire the pair' };
}

const results: CellResult[] = [];
const tasks = ids.flatMap(id => TFS.flatMap(tf => MARKETS.map(sym => ({ id, tf, sym }))));
let done = 0; const started = Date.now();
async function worker() { for (;;) { const t = tasks.shift(); if (!t) return; try { const r = await cell(t.id, t.tf, t.sym); if (r) results.push(r); } catch (e: any) { md.push(`- ${t.id} · ${t.sym} ${t.tf}: error ${e?.message ?? e}`); } done++; if (done % 20 === 0) console.error(`${done}/${ids.length * TFS.length * MARKETS.length} cells · ${((Date.now() - started) / 60000).toFixed(1)} min`); } }
await Promise.all(Array.from({ length: CONC }, worker));
await pool.stop();
out.end();

// per-script summary: the cells, the verdict distribution, the best fixable cell
const lines: string[] = ['# Scanner test — ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', '', `Scripts ${ids.length} · timeframes ${TFS.join(', ')} · markets ${MARKETS.join(', ')} · ${results.length} cells with trades.`, ''];
for (const id of ids) {
  const cells = results.filter(r => r.id === id); if (!cells.length) { lines.push(`## ${id}`, '', 'no cell produced 20+ trades (silent, broken, or too slow a signal on this history)', ''); continue; }
  const verdicts = new Map<string, number>(); for (const c of cells) verdicts.set(c.verdict.split(':')[0], (verdicts.get(c.verdict.split(':')[0]) ?? 0) + 1);
  lines.push(`## ${id}`, '', `cells ${cells.length} · ${[...verdicts].map(([k, n]) => `${k} ${n}`).join(' · ')}`, '', '| market | tf | trades | E[R] | halves | +1R seen | first-bar stops | verdict | fix |', '|---|---|---|---|---|---|---|---|---|');
  for (const c of cells.sort((a, b) => b.variants.base.sumR - a.variants.base.sumR)) { const b = c.variants.base; lines.push(`| ${c.sym} | ${c.tf} | ${b.trades} | ${b.avgR >= 0 ? '+' : ''}${b.avgR.toFixed(3)} | ${b.r1 >= 0 ? '+' : ''}${b.r1.toFixed(2)} / ${b.r2 >= 0 ? '+' : ''}${b.r2.toFixed(2)} | ${(b.mfe1 * 100).toFixed(0)}% | ${(b.firstBar * 100).toFixed(0)}% | ${c.verdict} | ${c.fix} |`); }
  lines.push('');
}
lines.push('## Notes', ...md);
fs.writeFileSync(process.env.MD ?? '/tmp/diagnose.md', lines.join('\n'));
console.error(`done: ${results.length} cells · ${process.env.OUT} · ${process.env.MD}`);
process.exit(0);
