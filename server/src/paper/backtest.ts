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
import type { TrendGateMode, PaperConfig, ExitMode, ExitOverride } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';
import { atrSeries } from '../data/indicators.ts';
import type { ScanEvent } from '../scanners/extractor.ts';
import { scriptModeExit, applyBar, applyScriptExit, earlyStallExit, earlyCutExit, checkRiskVsFees, computeStats, fillExit, openPosition, resolveLevels, reversalAllowed, sizeContracts, roundTick, trendExit, type Position, trendGateReason, higherTrend, trendPerBar, exitConfigFor, modelTrail, type TrailModel } from './logic.ts';
import { tradeOf } from './engine.ts';
import { TF_SECONDS } from '../config.ts';
import { SIMULATION_VERSION } from './version.ts';
import { computeFeatures } from '../ml/features.ts';

export interface BacktestInput {
  scannerId: string; scannerName: string; symbol: string; tf: string;
  bars: Bar[];                // closed bars, ascending — the same bars the script ran on
  events: ScanEvent[];        // extracted from the script run (all bars)
  cfg: PaperConfig; exitMode: ExitMode; contractValue: number; tickSize: number;
  /** The market's maintenance margin and leverage ceiling (Delta's product record); the config's figures when absent. */
  maintenanceMarginPct?: number; maxLeverage?: number;
  /** This scanner's trend-gate mode; defaults to `cfg.trendGate.mode` when the gate is on. */
  trendGate?: TrendGateMode;
  /** Whipsaw gate under measurement (decision 66): refuse an entry when the entry timeframe's Kaufman efficiency ratio over `len` bars is under `minEr`, or its choppiness index over 14 bars is over `maxChop`. */
  chopGate?: { minEr?: number; maxChop?: number; len?: number };
  /** This scanner's own exit rules, applied over the market's and the fleet's. */
  scannerExit?: ExitOverride;
  /** Optional 1-minute candles, ascending, covering `bars`: exits are then resolved on this path. */
  subBars?: Bar[];
  /**
   * Entry model under test (decision 95). `maxSignalBarAtr`: refuse a signal whose bar already ran
   * that many ATRs (the impulse is spent). `pullbackAtr`: do not enter at the signal bar's close;
   * rest a limit that many ATRs back from the signal price for `pullbackBars` bars and enter there as
   * a maker, or not at all. The stop is then measured from the fill, not from the impulse top.
   */
  entry?: { maxSignalBarAtr?: number; pullbackAtr?: number; pullbackBars?: number;
    /**
     * The hybrid entry (decision 133): the signal comes from this timeframe, the execution from the one below. A stop
     * order rests `breakAtr` ATR beyond the signal bar's extreme in the trade's direction and fills on the first lower
     * bar that crosses it (a taker fill at the trigger), or lapses after `breakBars` signal bars. A signal whose move
     * never continues on the lower timeframe is never taken.
     */
    breakAtr?: number; breakBars?: number };
  /**
   * The market's round-trip book cost in percent (the market gate's `bookCostPct`): every market-style
   * leg pays half of it on top of the configured slippage, as the account does when it crosses a real
   * quote. A resting limit (`entry.pullbackAtr`) pays none of it on the entry.
   */
  spreadPct?: number;
  /** Under test: the stop must be at least this many times the round trip's cost (fees plus the book), overriding `minRiskFeeRatio`. */
  costRatio?: number;
  /** Decision 178: an exit model under measurement, asked once per signal bar (index into `bars`); applied on that bar's close after the bar's fills, as the trail is. */
  trailModel?: (i: number) => TrailModel | null;
  /**
   * The context gate under test (decision 102): asked at every entry with the signal bar's time and
   * the side; `allow`, `block`, or `unknown` when the context has no reading for that time (the
   * Binance history stops 30 days back). `unknownIs` decides what an unknown does; blocking on
   * unknown confines a variant to the window the context covers, which is how it is compared fairly.
   */
  contextGate?: (time: number, side: 'long' | 'short') => 'allow' | 'block' | 'unknown';
  unknownIs?: 'allow' | 'block';
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
  // decision 113: under exit mode `script` the script's exits are the exits
  const cfg0 = exitConfigFor(inp.cfg, inp.symbol, inp.exitMode === 'script' ? { ...(inp.scannerExit ?? {}), ...scriptModeExit(inp.cfg) } : inp.scannerExit);
  const cfg = inp.spreadPct && inp.spreadPct > 0 ? { ...cfg0, slippageBps: (cfg0.slippageBps ?? 0) + inp.spreadPct * 50 } : cfg0;
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
  let open = null as Position | null;   // assigned inside closures below, so the declared type must survive the initialiser
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

  const refuse = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1; };
  /** Open a position at `price` for signal `ev` raised on bar `sigI`; false when sizing or fees refuse it. */
  const openAt = (price: number, at: number, ev: ScanEvent, sigI: number, maker: boolean): boolean => {
    const lv = resolveLevels({ side: ev.side!, price, sl: ev.sl, tp: ev.tp, atr: atr[sigI] }, cfg, inp.tickSize);
    if ('error' in lv) { refuse(lv.error); return false; }
    const feeErr = checkRiskVsFees(price, lv.sl, inp.costRatio ? { ...cfg, minRiskFeeRatio: inp.costRatio, minRiskFeeRatioBySymbol: undefined } : cfg, inp.symbol, inp.spreadPct ?? 0);
    if (feeErr) { refuse('stop too tight for fees'); return false; }
    const sz = sizeContracts(price, lv.sl, { equity, contractValue: inp.contractValue, tickSize: inp.tickSize, maintenanceMarginPct: inp.maintenanceMarginPct, maxLeverage: inp.maxLeverage, cfg }, 0, ev.score);
    if (sz.qty < 1) { refuse(sz.reason ?? 'size'); return false; }
    const features = computeFeatures({ bars, i: sigI, ev, entry: price, sl: lv.sl, tp1: lv.tp[0], atr: atr[sigI], levelsSource: lv.source });
    open = openPosition({ id: nextId++, scannerId: inp.scannerId, scannerName: inp.scannerName, symbol: inp.symbol, tf: inp.tf, side: ev.side!, qty: sz.qty, contractValue: inp.contractValue, maintenanceMarginPct: inp.maintenanceMarginPct, entryPrice: price, at, sl: lv.sl, tp: lv.tp, riskAmount: sz.riskAmount, levelsSource: lv.source, signalId: null, cfg, bt: true, openedAt: at + (maker ? 0 : tfMs), leverage: sz.leverage, marginLeverage: sz.marginLeverage, features, maker });
    entries++;
    return true;
  };
  // a limit resting back from a signal price (the pullback entry model); the latest signal replaces an earlier one
  let pending: { ev: ScanEvent; limit: number; sigI: number; expires: number; kind?: 'limit' | 'stop' } | null = null;

  let busted = false;
  for (let i = 0; i < bars.length && !busted; i++) {
    const model = inp.trailModel?.(i) ?? null;
    const bar = bars[i];
    if (equity <= Math.max(0, cfg.initialEquity * 0.02)) { busted = true; rejected['purse_wiped'] = (rejected['purse_wiped'] ?? 0) + 1; break; }
    // 0. a resting pullback limit: filled on the first minute that touches it, dropped when its bars run out
    if (pending && !open) {
      if (i > pending.expires) { refuse('no pullback'); pending = null; }
      else if (pending.kind === 'stop' ? (pending.ev.side === 'long' ? bar.high >= pending.limit : bar.low <= pending.limit) : (pending.ev.side === 'long' ? bar.low <= pending.limit : bar.high >= pending.limit)) {
        const { ev, limit, sigI } = pending; const isStop = pending.kind === 'stop'; pending = null;
        const touched = (b: { high: number; low: number }) => isStop ? (ev.side === 'long' ? b.high >= limit : b.low <= limit) : (ev.side === 'long' ? b.low <= limit : b.high >= limit);
        if (sub) {
          while (si < sub.length && sub[si].time < bar.time) si++;
          let j = si;
          for (; j < sub.length && sub[j].time < bar.time + tfMs; j++) if (touched(sub[j])) break;
          const fillAt = j < sub.length && sub[j].time < bar.time + tfMs ? sub[j].time : bar.time;
          if (openAt(limit, fillAt, ev, sigI, !isStop)) {
            // `openAt` assigned the closure's `open`; the narrowing above does not see that
            const o = open as unknown as Position;
            const atrKnown = atr[i - 1] ?? atr[i];
            for (let k = j + 1; o.status === 'open' && k < sub.length && sub[k].time < bar.time + tfMs; k++) {
              applyBar(o, sub[k], cfg, atrKnown);
              if (o.status === 'open' && te?.enabled) trendExit(o, trend[i - 1], sub[k].close, sub[k].time, cfg);
              if (o.status === 'open') earlyStallExit(o, sub[k].close, sub[k].time, cfg);
              if (o.status === 'open') earlyCutExit(o, sub[k].close, sub[k].time, cfg);
            }
            if (o.status === 'closed') finish(o);
          }
        } else if (openAt(limit, bar.time, ev, sigI, !isStop)) {
          const o = open as unknown as Position;
          applyBar(o, bar, cfg, atr[i], model);
          if (o.status === 'closed') finish(o);
        }
      }
    }
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
          if (open.status === 'open') earlyStallExit(open, sub[j].close, sub[j].time, cfg);
          if (open.status === 'open') earlyCutExit(open, sub[j].close, sub[j].time, cfg);
        }
        // the model reads the signal timeframe, once per bar, however many 1m bars resolved the exits
        if (model && open && (open as Position).status === 'open') modelTrail(open, bar, model);
      } else applyBar(open, bar, cfg, atr[i], model);
      if (open.status === 'closed') finish(open);
      // a profitable trade whose timeframe turned against it is closed at this bar's close
      if (open && (open as Position).status === 'open' && te?.enabled && !sub) {
        const f = trendExit(open, trend[i], bar.close, bar.time, cfg);
        if (f && (open as Position).status === 'closed') finish(open);
      }
      if (open && (open as Position).status === 'open' && !sub) earlyStallExit(open, bar.close, bar.time, cfg);
      if (open && (open as Position).status === 'open' && !sub) earlyCutExit(open, bar.close, bar.time, cfg);
      if (open && (open as Position).status === 'closed') finish(open);
    }
    // 2. script events on this bar (exits first, then entries)
    const evs = byBar.get(bar.time);
    if (!evs) continue;
    for (const ev of evs) {
      if (ev.kind === 'exit' && open && (!ev.side || ev.side === open.side)) {
        // decision 135: a script's exit is acted on after the close, so it fills there; only a target hit keeps its level (a resting limit fills at it)
        const type = ev.exitType ?? 'close';
        applyScriptExit(open, type, /^tp\d$/.test(type) ? ev.price : undefined, bar.time, cfg, inp.exitMode, bar.close);
        if (open.status === 'closed') finish(open);
      }
    }
    for (const ev of evs) {
      if (ev.kind !== 'entry' || !ev.side) continue;
      const blocked = gateMode === 'off' ? null : trendGateReason(ev.side, gateTrend[i], gateMode);
      if (blocked) { rejected['against the trend'] = (rejected['against the trend'] ?? 0) + 1; continue; }
      if (inp.chopGate && chopBlocked(bars, i, inp.chopGate)) { rejected['choppy'] = (rejected['choppy'] ?? 0) + 1; continue; }
      if (inp.contextGate) {
        const v = inp.contextGate(bar.time, ev.side);
        if (v === 'block' || (v === 'unknown' && (inp.unknownIs ?? 'allow') === 'block')) { refuse(v === 'block' ? 'context' : 'no context'); continue; }
      }
      if (open) {
        if (open.side === ev.side) { rejected['already_open'] = (rejected['already_open'] ?? 0) + 1; continue; }
        if (!cfg.allowReversal) { rejected['reversal_disabled'] = (rejected['reversal_disabled'] ?? 0) + 1; continue; }
        // hold a losing position through an opposite signal when reversalMinR asks us to
        // decision 135: the reversal is acted on after the close and fills there, as the live engine fills it at the quote
        if (!reversalAllowed(open, bar.close, cfg)) { rejected['reversal_below_min'] = (rejected['reversal_below_min'] ?? 0) + 1; continue; }
        fillExit(open, bar.close, open.qtyOpen, 'reversal', bar.time, cfg, true);
        finish(open);
      }
      // decision 134: a market entry fills at the signal bar's close, as the live engine fills at the market when it acts
      // after the close. The event's own price is a reference: a strategy's stop-order fill at the breakout level, read
      // after the bar closed beyond it, handed the screen a head start the account never gets (Inside Day Breakout: a
      // median 60% of the bar's range).
      const price = bar.close;
      const em = inp.entry;
      if (em?.maxSignalBarAtr && atr[i] > 0 && (bar.high - bar.low) / atr[i] > em.maxSignalBarAtr) { refuse('chased'); continue; }
      if (em?.pullbackAtr != null && em.pullbackAtr >= 0 && atr[i] > 0) {
        const limit = roundTick(ev.side === 'long' ? price - em.pullbackAtr * atr[i] : price + em.pullbackAtr * atr[i], inp.tickSize);
        pending = { ev, limit, sigI: i, expires: i + Math.max(1, em.pullbackBars ?? 3) };
        continue;
      }
      if (em?.breakAtr != null && em.breakAtr >= 0 && atr[i] > 0) {
        const trigger = roundTick(ev.side === 'long' ? bar.high + em.breakAtr * atr[i] : bar.low - em.breakAtr * atr[i], inp.tickSize);
        pending = { ev, limit: trigger, sigI: i, expires: i + Math.max(1, em.breakBars ?? 4), kind: 'stop' };
        continue;
      }
      openAt(price, bar.time, ev, i, false);
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

/** Kaufman efficiency ratio over `len` closed bars ending at `i`: net change over the sum of bar-to-bar changes (1 = a straight line, 0 = pure noise). */
export function efficiencyRatio(bars: Bar[], i: number, len = 20): number | null {
  if (i < len) return null;
  let vol = 0; for (let j = i - len + 1; j <= i; j++) vol += Math.abs(bars[j].close - bars[j - 1].close);
  return vol > 0 ? Math.abs(bars[i].close - bars[i - len].close) / vol : 0;
}
/** Choppiness index over 14 bars ending at `i` (100 × log10(ΣTR / range) / log10(14)); above ~61.8 is consolidation, below ~38.2 is a trend. */
export function choppiness(bars: Bar[], i: number, len = 14): number | null {
  if (i < len) return null;
  let tr = 0, hh = -Infinity, ll = Infinity;
  for (let j = i - len + 1; j <= i; j++) { const pc = bars[j - 1].close; tr += Math.max(bars[j].high - bars[j].low, Math.abs(bars[j].high - pc), Math.abs(bars[j].low - pc)); hh = Math.max(hh, bars[j].high); ll = Math.min(ll, bars[j].low); }
  return hh > ll && tr > 0 ? 100 * Math.log10(tr / (hh - ll)) / Math.log10(len) : null;
}
function chopBlocked(bars: Bar[], i: number, g: { minEr?: number; maxChop?: number; len?: number }): boolean {
  if (g.minEr !== undefined) { const er = efficiencyRatio(bars, i, g.len ?? 20); if (er !== null && er < g.minEr) return true; }
  if (g.maxChop !== undefined) { const c = choppiness(bars, i, 14); if (c !== null && c > g.maxChop) return true; }
  return false;
}
