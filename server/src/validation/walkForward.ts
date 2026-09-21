/**
 * Walk-forward validation of one scanner×symbol×timeframe over a long history.
 *
 * The history is cut into rolling windows: a training window of `trainDays` followed by a
 * test window of `testDays`, advanced by `stepDays`. Each window is replayed with the same
 * `runBacktest` the dashboard uses. The in-sample result decides whether the tuner WOULD have
 * selected the pair (the current auto-tune rule: trades ≥ min, pnl > 0, PF ≥ min); the
 * out-of-sample (OOS) figures aggregate only the test windows that followed a selected
 * training window — the honest "what would trading this rule have produced" number.
 *
 * Overlapping test windows (stepDays < testDays) would count the same trade several times, so
 * trades are de-duplicated by entry time before aggregation.
 */
import type { PaperConfig, ExitMode } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';
import { runBacktest, type BacktestResult } from '../paper/backtest.ts';
import { SIMULATION_VERSION } from '../paper/version.ts';
import type { ScanEvent } from '../scanners/extractor.ts';

const DAY = 86_400_000;

export interface WfWindow { index: number; trainFrom: number; trainTo: number; testFrom: number; testTo: number }

export interface WfOptions {
  trainDays: number; testDays: number; stepDays: number;
  /** In-sample selection rule (mirrors auto-tune). */
  minTrades: number; minProfitFactor: number;
  /** Bars fed before each window so ATR/indicators are warm (events on them are ignored). */
  leadBars?: number;
}

export interface WfStats {
  trades: number; wins: number; losses: number; winRatePct: number; pnl: number; fees: number;
  grossProfit: number; grossLoss: number; profitFactor: number | null; maxDrawdownPct: number; avgR: number | null;
  weeks: number; positiveWeeks: number; negativeWeeks: number;
}

export type WfTrade = BacktestResult['trades'][number];

export interface WfWindowResult extends WfWindow {
  inSample: Pick<WfStats, 'trades' | 'pnl' | 'profitFactor' | 'winRatePct'>;
  selected: boolean;
  outOfSample: Pick<WfStats, 'trades' | 'pnl' | 'profitFactor' | 'winRatePct'>;
}

export interface WalkForwardResult {
  version: number;
  at: number;
  scannerId: string; scannerName: string; symbol: string; tf: string;
  bars: number; from: number; to: number;
  opts: WfOptions;
  windows: WfWindowResult[];
  selectedWindows: number;
  /** All training windows aggregated (trades de-duplicated by entry time). */
  inSample: WfStats;
  /** Test windows following a selected training window, de-duplicated. */
  outOfSample: WfStats;
  /** Every test window regardless of selection, de-duplicated. */
  outOfSampleAll: WfStats;
  /** OOS trades (selected windows), newest first, capped. */
  trades: WfTrade[];
  /** Weekly OOS pnl (selected windows), ascending by week. */
  weekly: Array<{ week: string; from: number; pnl: number; trades: number }>;
}

/** Rolling windows covering [from, end) (ms, `end` exclusive). The last test window ends at `end`. */
export function makeWindows(from: number, end: number, opts: Pick<WfOptions, 'trainDays' | 'testDays' | 'stepDays'>): WfWindow[] {
  const train = Math.max(1, opts.trainDays) * DAY, test = Math.max(1, opts.testDays) * DAY, step = Math.max(1, opts.stepDays) * DAY;
  const out: WfWindow[] = [];
  if (!(end > from) || end - from < train + test) return out;
  for (let start = from, i = 0; start + train + test <= end; start += step, i++) {
    out.push({ index: i, trainFrom: start, trainTo: start + train, testFrom: start + train, testTo: Math.min(end, start + train + test) });
  }
  return out;
}

/** ISO-8601 week key (UTC), e.g. 2026-W38. */
export function weekKey(ms: number): string {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  const thu = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const y = thu.getUTCFullYear();
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const week = 1 + Math.round(((thu.getTime() - jan4.getTime()) / DAY - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${y}-W${String(week).padStart(2, '0')}`;
}

export function weekStart(ms: number): number {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

/** Aggregate statistics over a trade list (closed-trade equity drawdown, ISO weeks by exit time). */
export function statsOf(trades: Array<Pick<WfTrade, 'pnl' | 'fees' | 'exitAt' | 'rMultiple'>>, initialEquity: number): WfStats {
  const sorted = [...trades].sort((a, b) => (a.exitAt ?? 0) - (b.exitAt ?? 0));
  let wins = 0, losses = 0, gp = 0, gl = 0, fees = 0, rSum = 0, rN = 0;
  let eq = initialEquity, peak = initialEquity, maxDd = 0;
  const weeks = new Map<string, number>();
  for (const t of sorted) {
    fees += t.fees ?? 0;
    if (t.pnl > 0) { wins++; gp += t.pnl; } else { losses++; gl += -t.pnl; }
    if (t.rMultiple !== null && t.rMultiple !== undefined && Number.isFinite(t.rMultiple)) { rSum += t.rMultiple; rN++; }
    eq += t.pnl; if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak * 100 : 0; if (dd > maxDd) maxDd = dd;
    const wk = weekKey(t.exitAt ?? 0); weeks.set(wk, (weeks.get(wk) ?? 0) + t.pnl);
  }
  const n = sorted.length;
  let pos = 0, neg = 0;
  for (const v of weeks.values()) { if (v > 0) pos++; else if (v < 0) neg++; }
  return {
    trades: n, wins, losses, winRatePct: n ? wins / n * 100 : 0, pnl: gp - gl, fees, grossProfit: gp, grossLoss: gl,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? 999 : null, maxDrawdownPct: maxDd, avgR: rN ? rSum / rN : null,
    weeks: weeks.size, positiveWeeks: pos, negativeWeeks: neg,
  };
}

/** The auto-tune in-sample rule. */
export function passesRule(s: { trades: number; pnl: number; profitFactor: number | null }, minTrades: number, minProfitFactor: number): boolean {
  return s.trades >= minTrades && s.pnl > 0 && (s.profitFactor ?? 0) >= minProfitFactor;
}

export interface WalkForwardInput {
  scannerId: string; scannerName: string; symbol: string; tf: string;
  bars: Bar[];              // ascending closed bars over the whole history
  events: ScanEvent[];      // extracted events over the whole history
  cfg: PaperConfig; exitMode: ExitMode; contractValue: number; tickSize: number;
  opts: WfOptions;
  windows?: WfWindow[];     // override (tests)
}

function replay(inp: WalkForwardInput, from: number, to: number): BacktestResult {
  const lead = inp.opts.leadBars ?? 50;
  let i0 = inp.bars.findIndex(b => b.time >= from);
  if (i0 < 0) i0 = inp.bars.length;
  let i1 = inp.bars.findIndex(b => b.time >= to);
  if (i1 < 0) i1 = inp.bars.length;
  const bars = inp.bars.slice(Math.max(0, i0 - lead), i1);
  const events = inp.events.filter(e => e.barTime >= from && e.barTime < to);
  return runBacktest({ scannerId: inp.scannerId, scannerName: inp.scannerName, symbol: inp.symbol, tf: inp.tf, bars, events, cfg: inp.cfg, exitMode: inp.exitMode, contractValue: inp.contractValue, tickSize: inp.tickSize });
}

const brief = (s: WfStats | BacktestResult['stats']) => ({ trades: s.trades, pnl: s.pnl, profitFactor: s.profitFactor === Infinity ? 999 : s.profitFactor, winRatePct: s.winRatePct });

export function walkForward(inp: WalkForwardInput): WalkForwardResult {
  const from = inp.bars[0]?.time ?? 0, to = inp.bars.at(-1)?.time ?? 0;
  const windows = inp.windows ?? makeWindows(from, to + 1, inp.opts);
  const isTrades = new Map<number, WfTrade>(), oosTrades = new Map<number, WfTrade>(), oosAll = new Map<number, WfTrade>();
  const results: WfWindowResult[] = [];
  let selectedWindows = 0;
  for (const w of windows) {
    const train = replay(inp, w.trainFrom, w.trainTo);
    const selected = passesRule(train.stats, inp.opts.minTrades, inp.opts.minProfitFactor);
    const test = replay(inp, w.testFrom, w.testTo);
    for (const t of train.trades) if (!isTrades.has(t.entryAt)) isTrades.set(t.entryAt, t);
    for (const t of test.trades) { if (!oosAll.has(t.entryAt)) oosAll.set(t.entryAt, t); if (selected && !oosTrades.has(t.entryAt)) oosTrades.set(t.entryAt, t); }
    if (selected) selectedWindows++;
    results.push({ ...w, inSample: brief(train.stats), selected, outOfSample: brief(test.stats) });
  }
  const oos = [...oosTrades.values()];
  const weeklyMap = new Map<string, { week: string; from: number; pnl: number; trades: number }>();
  for (const t of oos) { const k = weekKey(t.exitAt ?? 0); const e = weeklyMap.get(k) ?? { week: k, from: weekStart(t.exitAt ?? 0), pnl: 0, trades: 0 }; e.pnl += t.pnl; e.trades++; weeklyMap.set(k, e); }
  return {
    version: SIMULATION_VERSION, at: Date.now(), scannerId: inp.scannerId, scannerName: inp.scannerName, symbol: inp.symbol, tf: inp.tf,
    bars: inp.bars.length, from, to, opts: inp.opts, windows: results, selectedWindows,
    inSample: statsOf([...isTrades.values()], inp.cfg.initialEquity),
    outOfSample: statsOf(oos, inp.cfg.initialEquity),
    outOfSampleAll: statsOf([...oosAll.values()], inp.cfg.initialEquity),
    trades: oos.sort((a, b) => b.entryAt - a.entryAt).slice(0, 300),
    weekly: [...weeklyMap.values()].sort((a, b) => a.from - b.from),
  };
}

/** Compact OOS view used by auto-tune. */
export interface OosSummary { at: number; windows: number; selectedWindows: number; trades: number; pnl: number; profitFactor: number | null; positiveWeeks: number; negativeWeeks: number; weeks: number; maxDrawdownPct: number }
export function oosSummary(r: WalkForwardResult): OosSummary {
  const o = r.outOfSample;
  return { at: r.at, windows: r.windows.length, selectedWindows: r.selectedWindows, trades: o.trades, pnl: o.pnl, profitFactor: o.profitFactor, positiveWeeks: o.positiveWeeks, negativeWeeks: o.negativeWeeks, weeks: o.weeks, maxDrawdownPct: o.maxDrawdownPct };
}
