/**
 * In-memory backtest of one scanner over a candle history using the exact same fill logic
 * as the live paper engine (bar-level fills: SL before TP on the same bar).
 *
 * With `subBars` (1-minute candles) the exits are resolved on the 1m path inside each signal bar,
 * the way the live engine sees them, instead of on the signal bar's OHLC. A 15m bar whose range
 * covers both the stop and a target is otherwise ambiguous and scored stop-first, and a trail can
 * only move once per signal bar; on the 1m path both happen in the order they actually did.
 * Entries and script events still act on the signal bar, exactly as before.
 */
import type { TrendGateMode, PaperConfig, ExitMode } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';
import { atrSeries } from '../data/indicators.ts';
import type { ScanEvent } from '../scanners/extractor.ts';
import { applyBar, applyScriptExit, checkRiskVsFees, computeStats, fillExit, openPosition, resolveLevels, reversalAllowed, sizeContracts, trendExit, type Position, trendGateReason, higherTrend, trendPerBar, exitConfigFor } from './logic.ts';
import { tradeOf } from './engine.ts';
import { TF_SECONDS } from '../config.ts';
import { SIMULATION_VERSION } from './version.ts';
import { computeFeatures } from '../ml/features.ts';

export interface BacktestInput {
  scannerId: string; scannerName: string; symbol: string; tf: string;
  bars: Bar[];                // closed bars, ascending — the same bars the script ran on
  events: ScanEvent[];        // extracted from the script run (all bars)
  cfg: PaperConfig; exitMode: ExitMode; contractValue: number; tickSize: number;
  /** This scanner's trend-gate mode; defaults to `cfg.trendGate.mode` when the gate is on. */
  trendGate?: TrendGateMode;
  /** Optional 1-minute candles, ascending, covering `bars`: exits are then resolved on this path. */
  subBars?: Bar[];
}

export interface BacktestResult {
  version: number;
  at: number; bars: number; from: number; to: number; signals: number; entries: number;
  stats: ReturnType<typeof computeStats> & { pnlPct: number; open: number };
  trades: ReturnType<typeof tradeOf>[];
  equity: Array<{ at: number; equity: number }>;
  rejected: Record<string, number>;
}

export function runBacktest(inp: BacktestInput): BacktestResult {
  const { bars } = inp;
  // a backtest is one market, so its exit rules are resolved once (decision 34)
  const cfg = exitConfigFor(inp.cfg, inp.symbol);
  const atr = atrSeries(bars, 14);
  const idxByTime = new Map<number, number>();
  bars.forEach((b, i) => idxByTime.set(b.time, i));
  const byBar = new Map<number, ScanEvent[]>();
  for (const e of inp.events) { const l = byBar.get(e.barTime) ?? []; l.push(e); byBar.set(e.barTime, l); }

  // the trend every bar sees, on its own timeframe or a higher one, never reading an unclosed bar
  const gate = cfg.trendGate;
  const gateMode: TrendGateMode = gate?.enabled ? (inp.trendGate ?? gate.mode) : 'off';
  const gateTrend: Array<1 | -1 | undefined> = gateMode === 'off' ? []
    : gate!.tf && gate!.tf !== inp.tf
      ? higherTrend(bars, TF_SECONDS[inp.tf] * 1000, TF_SECONDS[gate!.tf] * 1000, gate!.emaLen)
      : trendPerBar(bars, gate!.emaLen);

  let equity = cfg.initialEquity;
  let open: Position | null = null;
  const closed: Position[] = [];
  const curve: Array<{ at: number; equity: number }> = [{ at: bars[0]?.time ?? 0, equity }];
  const rejected: Record<string, number> = {};
  let nextId = 1, entries = 0;

  const finish = (p: Position) => { closed.push(p); equity += p.realizedPnl - p.fees; curve.push({ at: p.exitAt!, equity }); open = null; };

  // the trade's own timeframe trend, one value per bar, for the trend exit
  const te = cfg.trendExit;
  const trend: Array<1 | -1> = [];
  if (te?.enabled) {
    const k = 2 / (te.emaLen + 1);
    let ema = bars[0]?.close ?? 0;
    bars.forEach((b, i) => { ema = i ? b.close * k + ema * (1 - k) : b.close; trend.push(b.close >= ema ? 1 : -1); });
  }
  const tfMs = (TF_SECONDS[inp.tf] ?? 0) * 1000;
  const sub = inp.subBars && inp.subBars.length && tfMs > 60_000 ? inp.subBars : null;
  let si = 0;   // cursor into `sub`, only ever moves forward

  let busted = false;
  for (let i = 0; i < bars.length && !busted; i++) {
    const bar = bars[i];
    if (equity <= Math.max(0, cfg.initialEquity * 0.02)) { busted = true; rejected['purse_wiped'] = (rejected['purse_wiped'] ?? 0) + 1; break; }
    // 1. level fills on this bar for a position opened on an earlier bar
    if (open && open.entryAt < bar.time) {
      if (sub) {
        while (si < sub.length && sub[si].time < bar.time) si++;
        const start = si;
        // no 1m data for this bar (gap in the feed): fall back to the bar itself
        // live only knows the ATR of the last closed signal bar, so the 1m path uses that too
        const atrKnown = atr[i - 1] ?? atr[i];
        if (si >= sub.length || sub[si].time >= bar.time + tfMs) applyBar(open, bar, cfg, atrKnown);
        for (let j = start; open && open.status === 'open' && j < sub.length && sub[j].time < bar.time + tfMs; j++) {
          applyBar(open, sub[j], cfg, atrKnown);
          // live checks the trend on every 1m bar, so the 1m path must too, not once per signal bar
          if (open.status === 'open' && te?.enabled) trendExit(open, trend[i - 1], sub[j].close, sub[j].time, cfg);
        }
      } else applyBar(open, bar, cfg, atr[i]);
      if (open.status === 'closed') finish(open);
      // a profitable trade whose timeframe turned against it is closed at this bar's close
      if (open && (open as Position).status === 'open' && te?.enabled && !sub) {
        const f = trendExit(open, trend[i], bar.close, bar.time, cfg);
        if (f && (open as Position).status === 'closed') finish(open);
      }
      if (open && (open as Position).status === 'closed') finish(open);
    }
    // 2. script events on this bar (exits first, then entries)
    const evs = byBar.get(bar.time);
    if (!evs) continue;
    for (const ev of evs) {
      if (ev.kind === 'exit' && open && (!ev.side || ev.side === open.side)) {
        const fb = ev.price ?? bar.close;
        applyScriptExit(open, ev.exitType ?? 'close', ev.price, bar.time, cfg, inp.exitMode, fb);
        if (open.status === 'closed') finish(open);
      }
    }
    for (const ev of evs) {
      if (ev.kind !== 'entry' || !ev.side) continue;
      const blocked = gateMode === 'off' ? null : trendGateReason(ev.side, gateTrend[i], gateMode);
      if (blocked) { rejected['against the trend'] = (rejected['against the trend'] ?? 0) + 1; continue; }
      if (open) {
        if (open.side === ev.side) { rejected['already_open'] = (rejected['already_open'] ?? 0) + 1; continue; }
        if (!cfg.allowReversal) { rejected['reversal_disabled'] = (rejected['reversal_disabled'] ?? 0) + 1; continue; }
        // hold a losing position through an opposite signal when reversalMinR asks us to
        if (!reversalAllowed(open, ev.price ?? bar.close, cfg)) { rejected['reversal_below_min'] = (rejected['reversal_below_min'] ?? 0) + 1; continue; }
        fillExit(open, ev.price ?? bar.close, open.qtyOpen, 'reversal', bar.time, cfg, true);
        finish(open);
      }
      const price = ev.price && ev.price > 0 ? ev.price : bar.close;
      const lv = resolveLevels({ side: ev.side, price, sl: ev.sl, tp: ev.tp, atr: atr[i] }, cfg, inp.tickSize);
      if ('error' in lv) { rejected[lv.error] = (rejected[lv.error] ?? 0) + 1; continue; }
      const feeErr = checkRiskVsFees(price, lv.sl, cfg, inp.symbol);
      if (feeErr) { rejected['stop too tight for fees'] = (rejected['stop too tight for fees'] ?? 0) + 1; continue; }
      const sz = sizeContracts(price, lv.sl, { equity, contractValue: inp.contractValue, tickSize: inp.tickSize, cfg }, 0, ev.score);
      if (sz.qty < 1) { rejected[sz.reason ?? 'size'] = (rejected[sz.reason ?? 'size'] ?? 0) + 1; continue; }
      const features = computeFeatures({ bars, i, ev, entry: price, sl: lv.sl, tp1: lv.tp[0], atr: atr[i], levelsSource: lv.source });
      open = openPosition({ id: nextId++, scannerId: inp.scannerId, scannerName: inp.scannerName, symbol: inp.symbol, tf: inp.tf, side: ev.side, qty: sz.qty, contractValue: inp.contractValue, entryPrice: price, at: bar.time, sl: lv.sl, tp: lv.tp, riskAmount: sz.riskAmount, levelsSource: lv.source, signalId: null, cfg, bt: true, openedAt: bar.time + tfMs, leverage: sz.leverage, marginLeverage: sz.marginLeverage, features });
      entries++;
    }
  }
  const stats = computeStats(closed, cfg.initialEquity) as BacktestResult['stats'];
  stats.pnlPct = cfg.initialEquity ? stats.pnl / cfg.initialEquity * 100 : 0;
  stats.open = open ? 1 : 0;
  if (stats.profitFactor === Infinity) stats.profitFactor = 999;
  return {
    version: SIMULATION_VERSION, at: Date.now(), bars: bars.length, from: bars[0]?.time ?? 0, to: bars.at(-1)?.time ?? 0, signals: inp.events.length, entries,
    stats, trades: closed.map(tradeOf).reverse(), equity: curve, rejected,
  };
}
