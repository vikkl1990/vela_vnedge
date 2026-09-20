/**
 * Pure paper-trading position logic shared by the live engine and the backtester.
 * No I/O, no timers: every function takes explicit inputs and returns explicit results.
 *
 * Conventions
 *  - Linear USD-settled perpetuals: pnl = Δprice × contractValue × qty (sign by side).
 *  - `qty` is in contracts (integer ≥ 1).
 *  - Ambiguous OHLC bars resolve stop-loss BEFORE take-profit (conservative).
 */
import type { PaperConfig, ExitMode } from '../config.ts';
import type { Side, ExitType } from '../scanners/extractor.ts';

export interface Fill { at: number; price: number; qty: number; reason: string; fee: number; pnl: number }

export interface Position {
  id: number;
  status: 'open' | 'closed';
  scannerId: string;
  scannerName: string;
  symbol: string;
  tf: string;
  side: Side;
  qty: number;
  qtyOpen: number;
  contractValue: number;
  entryPrice: number;
  entryAt: number;
  sl: number | null;
  slOriginal: number | null;
  tp: number[];
  tpHit: boolean[];
  /** Contracts allocated to each TP leg (sum == qty). */
  legs: number[];
  breakEven: boolean;
  realizedPnl: number;
  fees: number;
  riskAmount: number;
  levelsSource: 'script' | 'atr-fallback' | 'mixed';
  /** Effective leverage (notional / equity at entry). */
  leverage: number;
  /** Selected isolated leverage; separate from account exposure above. */
  marginLeverage?: number;
  /** Modelled liquidation price (null when liquidation modelling is off). */
  liqPrice: number | null;
  exitAt: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  signalId: number | null;
  fills: Fill[];
  bt: boolean;
  /** Entry-time ML features (see ml/features.ts); optional. */
  features?: Record<string, number>;
  mlProb?: number | null;
  /** Last cumulative live candle observed; retained across restarts. */
  lastPriceBar?: PriceBar;
}

export interface EntryRequest {
  side: Side;
  price: number;         // signal/reference price
  sl?: number;
  tp?: number[];
  atr?: number;          // for fallback levels
  score?: number;
}

export interface SizingInputs {
  equity: number;
  /** Wallet cash available after reserving existing position margin (excludes unrealized gains). */
  availableMargin?: number;
  contractValue: number;
  tickSize: number;
  cfg: PaperConfig;
}

export interface LevelResult { sl: number; tp: number[]; source: Position['levelsSource']; reason?: string }

export function roundTick(p: number, tick: number): number {
  if (!tick || tick <= 0) return p;
  const d = Math.round(p / tick) * tick;
  const [coefficient, exponent = '0'] = tick.toString().toLowerCase().split('e');
  const decimals = Math.min(15, Math.max(0, (coefficient.split('.')[1]?.length ?? 0) - Number(exponent)));
  return Number(d.toFixed(decimals));
}

/** Resolve SL/TP levels, filling gaps with ATR-based defaults. */
export function resolveLevels(req: EntryRequest, cfg: PaperConfig, tick: number): LevelResult | { error: string } {
  const dir = req.side === 'long' ? 1 : -1;
  const entry = req.price;
  if (!Number.isFinite(entry) || entry <= 0) return { error: 'invalid entry price' };
  let sl = req.sl;
  let source: Position['levelsSource'] = 'script';
  const validSl = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && (req.side === 'long' ? v < entry : v > entry);
  if (!validSl(sl)) {
    if (!req.atr || !Number.isFinite(req.atr) || req.atr <= 0) return { error: 'no stop-loss and no ATR available for fallback' };
    sl = entry - dir * cfg.fallbackAtrSl * req.atr;
    source = 'atr-fallback';
  }
  const risk = Math.abs(entry - sl!);
  if (risk <= 0) return { error: 'zero risk distance' };
  let tp = (req.tp ?? []).filter(v => Number.isFinite(v) && v > 0 && (req.side === 'long' ? v > entry : v < entry));
  tp.sort((a, b) => (req.side === 'long' ? a - b : b - a));
  if (tp.length === 0) {
    tp = cfg.fallbackRR.map(rr => entry + dir * rr * risk);
    source = source === 'script' ? 'mixed' : 'atr-fallback';
  }
  sl = roundTick(sl!, tick);
  tp = [...new Set(tp.slice(0, 3).map(v => roundTick(v, tick)))];
  if (!validSl(sl)) return { error: 'stop invalid after tick rounding' };
  if (!tp.length || tp.some(v => !Number.isFinite(v) || v <= 0 || (req.side === 'long' ? v <= entry : v >= entry))) return { error: 'target invalid after tick rounding' };
  return { sl, tp, source };
}

/**
 * Stop distance versus round-trip taker fees. Returns an error string when the stop is so
 * tight that fees would consume more than 1/minRiskFeeRatio of the risk (0 disables).
 */
export function checkRiskVsFees(entry: number, sl: number, cfg: PaperConfig): string | null {
  const ratio = cfg.minRiskFeeRatio ?? 0;
  if (!(ratio > 0)) return null;
  const risk = Math.abs(entry - sl);
  const feeRoundTrip = entry * (cfg.feeRatePct / 100) * 2;
  if (risk < feeRoundTrip * ratio) return `stop too tight for fees (${(risk / entry * 100).toFixed(2)}% stop vs ${(feeRoundTrip / entry * 100).toFixed(2)}% round-trip fee; need ≥ ${ratio}×)`;
  return null;
}

/** Leverage for a signal quality score (0..100) in `quality` sizing mode: linear from minLeverage to maxLeverage. */
export function leverageForScore(score: number | undefined, cfg: PaperConfig): number {
  const q = score === undefined || !Number.isFinite(score) ? 0 : Math.max(0, Math.min(1, score / 100));
  return Math.round((cfg.minLeverage + (cfg.maxLeverage - cfg.minLeverage) * q) * 10) / 10;
}

/**
 * Position size in contracts.
 *  - `risk` mode: the stop loses riskPerTradePct of equity, capped by maxLeverage.
 *  - `quality` mode: notional = equity × leverage(score); the stop decides the R.
 */
export function sizeContracts(entry: number, sl: number, s: SizingInputs, openNotional = 0, score?: number): { qty: number; riskAmount: number; leverage: number; marginLeverage: number; reason?: string } {
  const marginLeverage = s.cfg.sizingMode === 'quality' ? leverageForScore(score, s.cfg) : s.cfg.maxLeverage;
  const rejected = (reason: string) => ({ qty: 0, riskAmount: 0, leverage: 0, marginLeverage, reason });
  if (![entry, sl, s.equity, s.contractValue, marginLeverage].every(v => Number.isFinite(v) && v > 0) || entry === sl) return rejected('invalid sizing inputs');
  if (s.cfg.liquidation && 1 / marginLeverage <= s.cfg.maintenanceMarginPct / 100) return rejected('initial margin must exceed maintenance margin');
  const long = sl < entry;
  const fillEntry = slip(entry, long ? 'buy' : 'sell', s.cfg);
  const fillStop = slip(sl, long ? 'sell' : 'buy', s.cfg);
  const entryFee = feeFor(fillEntry, 1, s.contractValue, s.cfg);
  const perContractRisk = Math.abs(fillEntry - fillStop) * s.contractValue + entryFee + feeFor(fillStop, 1, s.contractValue, s.cfg);
  const notional = fillEntry * s.contractValue;
  const availableMargin = s.availableMargin ?? (s.equity - openNotional / s.cfg.maxLeverage);
  const maxNotional = s.equity * s.cfg.maxLeverage - openNotional;
  // Entry fees consume wallet cash too. Margin is released pro-rata on partial exits.
  const maxQty = Math.min(Math.floor(maxNotional / notional), Math.floor(availableMargin / (notional / marginLeverage + entryFee)));
  const desired = s.cfg.sizingMode === 'quality'
    ? Math.floor(s.equity * marginLeverage / notional)
    : Math.floor(s.equity * (s.cfg.riskPerTradePct / 100) / perContractRisk);
  const qty = Math.min(desired, maxQty);
  if (!Number.isFinite(qty) || qty < 1) return rejected(maxQty < 1 ? 'margin or leverage cap exhausted' : 'risk budget too small for one contract');
  return { qty, riskAmount: qty * perContractRisk, leverage: qty * notional / s.equity, marginLeverage };
}

/** Simplified isolated liquidation: fixed maintenance on entry notional, no funding or tiering. */
export function liquidationPrice(side: Side, entry: number, leverage: number, cfg: PaperConfig): number | null {
  if (!cfg.liquidation || !Number.isFinite(entry) || entry <= 0 || !Number.isFinite(leverage) || !(leverage > 0)) return null;
  const move = 1 / leverage - cfg.maintenanceMarginPct / 100;
  if (move <= 0) return entry;
  const price = side === 'long' ? entry * (1 - move) : entry * (1 + move);
  return price > 0 ? price : null;
}

/** Split `qty` into TP legs following `split` (remainder goes to the last leg; zero legs are skipped at fill time). */
export function splitLegs(qty: number, split: number[], tpCount: number): number[] {
  const n = Math.min(split.length, tpCount);
  if (n <= 0) return [qty];
  const legs = split.slice(0, n).map(w => Math.floor(qty * w));
  const sum = legs.reduce((a, b) => a + b, 0);
  legs[n - 1] += qty - sum;
  return legs;
}

export function feeFor(price: number, qty: number, contractValue: number, cfg: PaperConfig, maker = false): number {
  const rate = maker ? (cfg.makerFeeRatePct ?? cfg.feeRatePct) : cfg.feeRatePct;
  return price * qty * contractValue * (rate / 100);
}

export function slip(price: number, side: 'buy' | 'sell', cfg: PaperConfig): number {
  const f = cfg.slippageBps / 10_000;
  return side === 'buy' ? price * (1 + f) : price * (1 - f);
}

export function pnlOf(pos: Pick<Position, 'side' | 'entryPrice' | 'contractValue'>, exitPrice: number, qty: number): number {
  const dir = pos.side === 'long' ? 1 : -1;
  return (exitPrice - pos.entryPrice) * dir * pos.contractValue * qty;
}

export function notionalOf(pos: Pick<Position, 'entryPrice' | 'qtyOpen' | 'contractValue'>): number {
  return pos.entryPrice * pos.qtyOpen * pos.contractValue;
}

export function unrealized(pos: Position, mark: number): number {
  return pos.status === 'open' ? pnlOf(pos, mark, pos.qtyOpen) : 0;
}

export interface OpenParams {
  id: number; scannerId: string; scannerName: string; symbol: string; tf: string; side: Side; qty: number; contractValue: number;
  entryPrice: number; at: number; sl: number; tp: number[]; riskAmount: number; levelsSource: Position['levelsSource']; signalId: number | null; cfg: PaperConfig; bt: boolean;
  leverage?: number;
  marginLeverage?: number;
  features?: Record<string, number>;
  mlProb?: number | null;
  /** Last cumulative live candle observed; retained across restarts. */
  lastPriceBar?: PriceBar;
}

export function openPosition(p: OpenParams): Position {
  const fillPrice = slip(p.entryPrice, p.side === 'long' ? 'buy' : 'sell', p.cfg);
  const fee = feeFor(fillPrice, p.qty, p.contractValue, p.cfg);
  const legs = splitLegs(p.qty, p.cfg.tpSplit, p.tp.length);
  return {
    id: p.id, status: 'open', scannerId: p.scannerId, scannerName: p.scannerName, symbol: p.symbol, tf: p.tf, side: p.side,
    qty: p.qty, qtyOpen: p.qty, contractValue: p.contractValue, entryPrice: fillPrice, entryAt: p.at, sl: p.sl, slOriginal: p.sl,
    tp: p.tp.slice(0, legs.length), tpHit: legs.map(() => false), legs, breakEven: false, realizedPnl: 0, fees: fee, riskAmount: p.riskAmount,
    levelsSource: p.levelsSource, leverage: p.leverage ?? 0, marginLeverage: p.marginLeverage ?? p.leverage ?? 0, liqPrice: liquidationPrice(p.side, fillPrice, p.marginLeverage ?? p.leverage ?? 0, p.cfg), exitAt: null, exitPrice: null, exitReason: null, signalId: p.signalId,
    fills: [{ at: p.at, price: fillPrice, qty: p.qty, reason: 'entry', fee, pnl: 0 }], bt: p.bt, features: p.features, mlProb: p.mlProb ?? null, lastPriceBar: p.lastPriceBar,
  };
}

export interface FillEvent { position: Position; fill: Fill; closed: boolean }

/** Reduce/close a position at `price`. Mutates and returns the fill. */
export function fillExit(pos: Position, price: number, qty: number, reason: string, at: number, cfg: PaperConfig, withSlippage: boolean): Fill {
  let q = Math.min(qty, pos.qtyOpen);
  // an exchange would have liquidated before any exit could print beyond the liquidation price
  if (pos.liqPrice !== null && (pos.side === 'long' ? price <= pos.liqPrice : price >= pos.liqPrice)) { price = pos.liqPrice; reason = 'liquidation'; q = pos.qtyOpen; withSlippage = true; }
  let px = withSlippage ? slip(price, pos.side === 'long' ? 'sell' : 'buy', cfg) : price;
  const marginLeverage = pos.marginLeverage ?? pos.leverage;
  const margin = marginLeverage > 0 ? pos.entryPrice * q * pos.contractValue / marginLeverage : Infinity;
  if (reason === 'liquidation' && marginLeverage > 0) {
    const bankruptcy = Math.max(0, pos.entryPrice * (1 + (pos.side === 'long' ? -1 : 1) / marginLeverage));
    px = pos.side === 'long' ? Math.max(px, bankruptcy) : Math.min(px, bankruptcy);
  }
  // take-profit legs rest as limit orders → maker fee; everything else crosses the spread → taker fee
  const pnl = pnlOf(pos, px, q);
  const quotedFee = feeFor(px, q, pos.contractValue, cfg, /^tp[123]$/.test(reason) && !withSlippage);
  const fee = reason === 'liquidation' ? Math.min(quotedFee, Math.max(0, margin + pnl)) : quotedFee;
  pos.qtyOpen -= q;
  pos.realizedPnl += pnl;
  pos.fees += fee;
  const fill: Fill = { at, price: px, qty: q, reason, fee, pnl };
  pos.fills.push(fill);
  if (pos.qtyOpen <= 0) {
    pos.status = 'closed'; pos.exitAt = at; pos.exitPrice = px;
    pos.exitReason = reason;
  }
  return fill;
}

/**
 * Apply one price bar (or tick expressed as a degenerate bar) to an open position.
 * Returns fills produced. SL is evaluated before TPs on the same bar.
 */
export function applyBar(pos: Position, bar: { time: number; high: number; low: number; close: number }, cfg: PaperConfig): Fill[] {
  if (pos.status !== 'open') return [];
  const fills: Fill[] = [];
  const long = pos.side === 'long';
  const at = bar.time;
  // 0. liquidation (worst case first)
  if (pos.liqPrice !== null && (long ? bar.low <= pos.liqPrice : bar.high >= pos.liqPrice) && (pos.sl === null || (long ? pos.liqPrice >= pos.sl : pos.liqPrice <= pos.sl))) {
    fills.push(fillExit(pos, pos.liqPrice, pos.qtyOpen, 'liquidation', at, cfg, true));
    return fills;
  }
  // 1. stop-loss
  if (pos.sl !== null && (long ? bar.low <= pos.sl : bar.high >= pos.sl)) {
    const reason = pos.breakEven ? 'be' : 'sl';
    fills.push(fillExit(pos, pos.sl, pos.qtyOpen, reason, at, cfg, true));
    return fills;
  }
  // 2. take-profits in order
  for (let i = 0; i < pos.tp.length; i++) {
    if (pos.tpHit[i] || pos.legs[i] <= 0) continue;
    const hit = long ? bar.high >= pos.tp[i] : bar.low <= pos.tp[i];
    if (!hit) break; // legs are sequential
    pos.tpHit[i] = true;
    const isLast = i === pos.tp.length - 1;
    const q = isLast ? pos.qtyOpen : Math.min(pos.legs[i], pos.qtyOpen);
    fills.push(fillExit(pos, pos.tp[i], q, `tp${i + 1}`, at, cfg, false));
    if (pos.qtyOpen <= 0) return fills;
    if (i === 0 && cfg.breakEvenAfterTp1 && !pos.breakEven) { pos.sl = pos.entryPrice; pos.breakEven = true; }
  }
  return fills;
}

export interface PriceBar { time: number; high: number; low: number; close: number }

/** Process only price information newly observed since entry/the previous update.
 * OHLC extremes are cumulative; replaying an old low after TP1 must not hit the new BE stop.
 * In an entry minute without a baseline, only the current close is known to be post-entry.
 */
export function applyLiveBar(pos: Position, bar: PriceBar, cfg: PaperConfig, observedAt: number): Fill[] {
  const previous = pos.lastPriceBar;
  if (pos.status !== 'open' || observedAt < pos.entryAt || bar.time + 60_000 <= pos.entryAt) return [];
  if (previous && bar.time < previous.time) return [];
  const sameBar = previous?.time === bar.time;
  if (sameBar && previous.high === bar.high && previous.low === bar.low && previous.close === bar.close) return [];
  let high = bar.high, low = bar.low;
  if (sameBar) {
    high = bar.high > previous.high ? Math.max(bar.high, bar.close) : bar.close;
    low = bar.low < previous.low ? Math.min(bar.low, bar.close) : bar.close;
  } else if (bar.time < pos.entryAt) {
    high = low = bar.close;
  }
  pos.lastPriceBar = { ...bar };
  return applyBar(pos, { time: observedAt, high, low, close: bar.close }, cfg);
}

/** Script-emitted exit event applied according to the scanner's exit mode. */
export function applyScriptExit(pos: Position, exitType: ExitType, price: number | undefined, at: number, cfg: PaperConfig, mode: ExitMode, fallbackPrice: number): Fill[] {
  if (pos.status !== 'open' || mode === 'levels') return [];
  const px = price && Number.isFinite(price) && price > 0 ? price : fallbackPrice;
  const m = exitType.match(/^tp(\d)$/);
  if (m) {
    const i = Number(m[1]) - 1;
    if (i >= pos.tp.length || pos.tpHit[i]) return [];
    // fill all legs up to and including i that are not yet hit
    const fills: Fill[] = [];
    for (let k = 0; k <= i && pos.status === 'open'; k++) {
      if (pos.tpHit[k]) continue;
      pos.tpHit[k] = true;
      if (pos.legs[k] <= 0) continue;
      const isLast = k === pos.tp.length - 1;
      const q = isLast ? pos.qtyOpen : Math.min(pos.legs[k], pos.qtyOpen);
      fills.push(fillExit(pos, k === i ? px : pos.tp[k], q, `tp${k + 1}`, at, cfg, false));
      if (k === 0 && cfg.breakEvenAfterTp1 && !pos.breakEven && pos.status === 'open') { pos.sl = pos.entryPrice; pos.breakEven = true; }
    }
    return fills;
  }
  const reason = exitType === 'sl' ? 'sl' : exitType === 'be' ? 'be' : exitType === 'flip' ? 'script_flip' : 'script_exit';
  return [fillExit(pos, px, pos.qtyOpen, reason, at, cfg, true)];
}

export function rMultiple(pos: Position): number | null {
  if (pos.riskAmount <= 0) return null;
  return (pos.realizedPnl - pos.fees) / pos.riskAmount;
}

// ---------- statistics ----------

export interface TradeStats {
  trades: number; wins: number; losses: number; winRatePct: number; pnl: number; fees: number; avgR: number | null;
  profitFactor: number | null; maxDrawdownPct: number; grossProfit: number; grossLoss: number; avgWin: number; avgLoss: number; expectancy: number | null;
}

export function computeStats(closed: Position[], initialEquity: number): TradeStats {
  const sorted = [...closed].sort((a, b) => (a.exitAt ?? 0) - (b.exitAt ?? 0));
  let wins = 0, losses = 0, gp = 0, gl = 0, fees = 0, rSum = 0, rN = 0;
  let eq = initialEquity, peak = initialEquity, maxDd = 0;
  for (const p of sorted) {
    const net = p.realizedPnl - p.fees;
    fees += p.fees;
    if (net > 0) { wins++; gp += net; } else { losses++; gl += -net; }
    const r = rMultiple(p); if (r !== null) { rSum += r; rN++; }
    eq += net; if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak * 100 : 0; if (dd > maxDd) maxDd = dd;
  }
  const n = sorted.length;
  return {
    trades: n, wins, losses, winRatePct: n ? wins / n * 100 : 0, pnl: gp - gl, fees, avgR: rN ? rSum / rN : null,
    profitFactor: gl > 0 ? gp / gl : (gp > 0 ? Infinity : null), maxDrawdownPct: maxDd, grossProfit: gp, grossLoss: gl,
    avgWin: wins ? gp / wins : 0, avgLoss: losses ? gl / losses : 0,
    expectancy: rN ? rSum / rN : null,
  };
}
