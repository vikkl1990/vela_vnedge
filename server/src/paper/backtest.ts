/**
 * In-memory backtest of one scanner over a candle history using the exact same fill logic
 * as the live paper engine (bar-level fills: SL before TP on the same bar).
 */
import type { PaperConfig, ExitMode } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';
import { atrSeries } from '../data/indicators.ts';
import type { ScanEvent } from '../scanners/extractor.ts';
import { applyBar, applyScriptExit, computeStats, fillExit, openPosition, resolveLevels, sizeContracts, type Position } from './logic.ts';
import { tradeOf } from './engine.ts';

export interface BacktestInput {
  scannerId: string; scannerName: string; symbol: string; tf: string;
  bars: Bar[];                // closed bars, ascending — the same bars the script ran on
  events: ScanEvent[];        // extracted from the script run (all bars)
  cfg: PaperConfig; exitMode: ExitMode; contractValue: number; tickSize: number;
}

export interface BacktestResult {
  at: number; bars: number; from: number; to: number; signals: number; entries: number;
  stats: ReturnType<typeof computeStats> & { pnlPct: number; open: number };
  trades: ReturnType<typeof tradeOf>[];
  equity: Array<{ at: number; equity: number }>;
  rejected: Record<string, number>;
}

export function runBacktest(inp: BacktestInput): BacktestResult {
  const { bars, cfg } = inp;
  const atr = atrSeries(bars, 14);
  const idxByTime = new Map<number, number>();
  bars.forEach((b, i) => idxByTime.set(b.time, i));
  const byBar = new Map<number, ScanEvent[]>();
  for (const e of inp.events) { const l = byBar.get(e.barTime) ?? []; l.push(e); byBar.set(e.barTime, l); }

  let equity = cfg.initialEquity;
  let open: Position | null = null;
  const closed: Position[] = [];
  const curve: Array<{ at: number; equity: number }> = [{ at: bars[0]?.time ?? 0, equity }];
  const rejected: Record<string, number> = {};
  let nextId = 1, entries = 0;

  const finish = (p: Position) => { closed.push(p); equity += p.realizedPnl - p.fees; curve.push({ at: p.exitAt!, equity }); open = null; };

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    // 1. level fills on this bar for a position opened on an earlier bar
    if (open && open.entryAt < bar.time) {
      applyBar(open, bar, cfg);
      if (open.status === 'closed') finish(open);
    }
    // 2. script events on this bar (exits first, then entries)
    const evs = byBar.get(bar.time);
    if (!evs) continue;
    for (const ev of evs) {
      if (ev.kind === 'exit' && open) {
        const fb = ev.price ?? bar.close;
        applyScriptExit(open, ev.exitType ?? 'close', ev.price, bar.time, cfg, inp.exitMode, fb);
        if (open.status === 'closed') finish(open);
      }
    }
    for (const ev of evs) {
      if (ev.kind !== 'entry' || !ev.side) continue;
      if (open) {
        if (open.side === ev.side) { rejected['already_open'] = (rejected['already_open'] ?? 0) + 1; continue; }
        if (!cfg.allowReversal) { rejected['reversal_disabled'] = (rejected['reversal_disabled'] ?? 0) + 1; continue; }
        fillExit(open, ev.price ?? bar.close, open.qtyOpen, 'reversal', bar.time, cfg, true);
        finish(open);
      }
      const price = ev.price && ev.price > 0 ? ev.price : bar.close;
      const lv = resolveLevels({ side: ev.side, price, sl: ev.sl, tp: ev.tp, atr: atr[i] }, cfg, inp.tickSize);
      if ('error' in lv) { rejected[lv.error] = (rejected[lv.error] ?? 0) + 1; continue; }
      const sz = sizeContracts(price, lv.sl, { equity, contractValue: inp.contractValue, tickSize: inp.tickSize, cfg });
      if (sz.qty < 1) { rejected[sz.reason ?? 'size'] = (rejected[sz.reason ?? 'size'] ?? 0) + 1; continue; }
      open = openPosition({ id: nextId++, scannerId: inp.scannerId, scannerName: inp.scannerName, symbol: inp.symbol, tf: inp.tf, side: ev.side, qty: sz.qty, contractValue: inp.contractValue, entryPrice: price, at: bar.time, sl: lv.sl, tp: lv.tp, riskAmount: sz.riskAmount, levelsSource: lv.source, signalId: null, cfg, bt: true });
      entries++;
    }
  }
  const stats = computeStats(closed, cfg.initialEquity) as BacktestResult['stats'];
  stats.pnlPct = cfg.initialEquity ? stats.pnl / cfg.initialEquity * 100 : 0;
  stats.open = open ? 1 : 0;
  if (stats.profitFactor === Infinity) stats.profitFactor = 999;
  return {
    at: Date.now(), bars: bars.length, from: bars[0]?.time ?? 0, to: bars.at(-1)?.time ?? 0, signals: inp.events.length, entries,
    stats, trades: closed.map(tradeOf).reverse(), equity: curve, rejected,
  };
}
