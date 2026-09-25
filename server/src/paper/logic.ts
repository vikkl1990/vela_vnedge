/**
 * Pure paper-trading position logic shared by the live engine and the backtester.
 * No I/O, no timers: every function takes explicit inputs and returns explicit results.
 *
 * Conventions
 *  - Linear USD-settled perpetuals: pnl = Δprice × contractValue × qty (sign by side).
 *  - `qty` is in contracts (integer ≥ 1).
 *  - Ambiguous OHLC bars resolve stop-loss BEFORE take-profit (conservative).
 */
import { TF_SECONDS } from '../config.ts';
import type { TrendGateMode, PaperConfig, ExitMode, ExitOverride } from '../config.ts';
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
  /** Best favourable excursion seen so far, in R; drives the trailing stop. */
  peakR?: number;
  /** When the peak was reached, and the worst excursion before it — the forensic view (decision 35). */
  peakAt?: number;
  worstR?: number;
  worstAt?: number;
  /** When the position was actually filled; the backtest stamps `entryAt` with the signal bar's open. */
  openedAt?: number;
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
export function checkRiskVsFees(entry: number, sl: number, cfg: PaperConfig, symbol?: string): string | null {
  const ratio = (symbol ? cfg.minRiskFeeRatioBySymbol?.[symbol] : undefined) ?? cfg.minRiskFeeRatio ?? 0;
  if (!(ratio > 0)) return null;
  const risk = Math.abs(entry - sl);
  const feeRoundTrip = entry * (cfg.feeRatePct / 100) * (1 + (cfg.feeTaxPct ?? 0) / 100) * 2;
  if (risk < feeRoundTrip * ratio) return `stop too tight for fees (${(risk / entry * 100).toFixed(2)}% stop vs ${(feeRoundTrip / entry * 100).toFixed(2)}% round-trip fee; need ≥ ${ratio}×)`;
  return null;
}

/**
 * How much of the risk budget a single contract consumes on this market.
 *
 * Contracts are indivisible, so a market whose one contract already risks most of the budget cannot
 * express position sizing at all: the bot gets one contract or nothing, and the stop-loss cap — not
 * the strategy — decides which. AKEUSD is the live example: one contract is 10,000 tokens, risking
 * 0.94% of a 1,154 account at a 1.5×ATR stop against a 1% budget.
 */
export function contractRiskShare(stopDistance: number, contractValue: number, equity: number, cfg: PaperConfig): number {
  const budget = equity * (cfg.riskPerTradePct / 100);
  if (!(budget > 0)) return Infinity;
  return (stopDistance * contractValue) / budget;
}

/**
 * The exit policy for one market: the global rules with that market's overrides applied.
 *
 * Resolved once, when the position opens, and carried on the position — so a configuration change
 * mid-trade cannot move a stop that is already protecting money, and every later decision about the
 * trade uses the rules it was opened under.
 *
 * Three layers, narrowest last: the fleet's policy, then the market's, then the scanner's. A scanner
 * knows its own trades better than the market does, so where both have an opinion the scanner wins.
 */
export function exitConfigFor(cfg: PaperConfig, symbol: string, scannerOverride?: ExitOverride | null): PaperConfig {
  const bySymbol = cfg.exitBySymbol?.[symbol];
  const layers = [bySymbol, scannerOverride].filter((x): x is ExitOverride => !!x && Object.keys(x).length > 0);
  return layers.length ? Object.assign({ ...cfg }, ...layers) : cfg;
}

/** Leverage for a signal quality score (0..100) in `quality` sizing mode: linear from minLeverage to maxLeverage. */
export function leverageForScore(score: number | undefined, cfg: PaperConfig): number {
  const q = score === undefined || !Number.isFinite(score) ? 0 : Math.max(0, Math.min(1, score / 100));
  return Math.round((cfg.minLeverage + (cfg.maxLeverage - cfg.minLeverage) * q) * 10) / 10;
}

/** Headroom between the stop and the liquidation price, as a share of the stop distance. */
export const LIQ_STOP_BUFFER = 0.25;

/**
 * Leverage low enough that the stop is reached before liquidation.
 *
 * Under isolated margin the liquidation price sits `1/leverage − maintenance` from entry, and that
 * distance shrinks as leverage rises. Choosing leverage from a signal's score alone ignores the stop:
 * a score of 54 gives 29×, whose liquidation is 2.9% away, and a 3.3% stop behind it can never be
 * reached — the position dies at the exchange's price instead of ours, for a worse loss than the R
 * it was sized for. That is exactly how MUBARAKUSD was lost at −0.88R with a stop that never traded.
 *
 * So the stop sets the ceiling on leverage. Posting more margin is what buys the room.
 */
export function leverageForStop(entry: number, sl: number, wanted: number, cfg: PaperConfig): number {
  if (!cfg.liquidation) return wanted;
  const stopPct = Math.abs(entry - sl) / entry;
  if (!(stopPct > 0)) return wanted;
  const room = stopPct * (1 + LIQ_STOP_BUFFER) + cfg.maintenanceMarginPct / 100;
  return Math.max(0.1, Math.min(wanted, 1 / room));
}

/**
 * Position size in contracts.
 *  - `risk` mode: the stop loses riskPerTradePct of equity, capped by maxLeverage.
 *  - `quality` mode: notional = equity × leverage(score); the stop decides the R.
 */
export function sizeContracts(entry: number, sl: number, s: SizingInputs, openNotional = 0, score?: number): { qty: number; riskAmount: number; leverage: number; marginLeverage: number; reason?: string } {
  const marginLeverage = leverageForStop(entry, sl, s.cfg.sizingMode === 'quality' ? leverageForScore(score, s.cfg) : s.cfg.maxLeverage, s.cfg);
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
  // Hard cap in EVERY mode: the loss at the stop may never exceed maxStopLossPct of equity.
  // Quality sizing targets a notional, so without this a wide (ATR-fallback) stop can cost most of the account.
  const stopCapPct = s.cfg.maxStopLossPct ?? 0;
  const stopCapQty = stopCapPct > 0 ? Math.floor((s.equity * stopCapPct / 100) / perContractRisk) : Infinity;
  let qty = Math.min(desired, maxQty, stopCapQty);
  if (!Number.isFinite(qty) || qty < 1) {
    if (stopCapQty < 1) return rejected(`stop too wide for the ${stopCapPct}% max stop-loss cap`);
    return rejected(maxQty < 1 ? 'margin or leverage cap exhausted' : 'risk budget too small for one contract');
  }
  // With depth impact the cost of a fill grows with its size, so the per-contract figure above
  // understates the loss of a large order. Price the stop-out exactly as the fills will (entry and
  // exit impact on the order's own notional) and shrink the order until it fits the budget.
  if ((s.cfg.depthUsdPerBp ?? 0) > 0) {
    const budget = Math.min(s.cfg.sizingMode === 'risk' ? s.equity * (s.cfg.riskPerTradePct / 100) : Infinity, stopCapPct > 0 ? s.equity * stopCapPct / 100 : Infinity);
    const lossAt = (n: number) => {
      const fe = slip(entry, long ? 'buy' : 'sell', s.cfg, entry * n * s.contractValue);
      const fs = slip(sl, long ? 'sell' : 'buy', s.cfg, sl * n * s.contractValue);
      return Math.abs(fe - fs) * n * s.contractValue + feeFor(fe, n, s.contractValue, s.cfg) + feeFor(fs, n, s.contractValue, s.cfg);
    };
    if (Number.isFinite(budget)) for (let i = 0; i < 60 && qty >= 1 && lossAt(qty) > budget; i++) qty = Math.min(qty - 1, Math.floor(qty * budget / lossAt(qty)));
    if (qty < 1) return rejected('risk budget too small once depth impact is included');
    return { qty, riskAmount: lossAt(qty), leverage: qty * notional / s.equity, marginLeverage };
  }
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
  return price * qty * contractValue * (rate / 100) * (1 + (cfg.feeTaxPct ?? 0) / 100);
}

/**
 * Market-order fill price. Fixed `slippageBps` plus, when `depthUsdPerBp` > 0 and the order's USD
 * notional is known, `notional / depthUsdPerBp` bps of impact (a linear book-depth assumption).
 */
export function slip(price: number, side: 'buy' | 'sell', cfg: PaperConfig, notionalUsd = 0): number {
  const f = slippageBpsFor(cfg, notionalUsd) / 10_000;
  return side === 'buy' ? price * (1 + f) : price * (1 - f);
}

export function slippageBpsFor(cfg: PaperConfig, notionalUsd = 0): number {
  const depth = cfg.depthUsdPerBp ?? 0;
  const impact = depth > 0 && notionalUsd > 0 ? notionalUsd / depth : 0;
  return cfg.slippageBps + impact;
}

/**
 * Depth impact only, for a price that already crossed the real spread (buy at the ask, sell at
 * the bid). `slippageBps` stands in for the spread when no quote exists, so adding it on top of
 * a quoted price would charge the spread twice; walking the book for size still costs extra.
 */
export function impactOnly(price: number, side: 'buy' | 'sell', cfg: PaperConfig, notionalUsd = 0): number {
  const depth = cfg.depthUsdPerBp ?? 0;
  const f = (depth > 0 && notionalUsd > 0 ? notionalUsd / depth : 0) / 10_000;
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
  /** True when `entryPrice` is already an executable quote, so only depth impact is added. */
  quoted?: boolean;
  /** Last cumulative live candle observed; retained across restarts. */
  lastPriceBar?: PriceBar;
  /** Actual fill time when it differs from `at` (the backtest fills at the signal bar's close). */
  openedAt?: number;
}

/**
 * Delta India's Scalper Offer: the closing leg of a futures position pays no fee when it closes
 * within the window of opening. Liquidations never qualify.
 */
export function closingFeeWaived(pos: Position, at: number, reason: string, cfg: PaperConfig): boolean {
  const o = cfg.scalperOffer;
  if (!o?.enabled || reason === 'liquidation' || o.excluded?.includes(pos.symbol)) return false;
  const minutes = o.majors.includes(pos.symbol) ? o.majorsMinutes : o.othersMinutes;
  return at - (pos.openedAt ?? pos.entryAt) <= minutes * 60_000;
}

export function openPosition(p: OpenParams): Position {
  const side = p.side === 'long' ? 'buy' : 'sell';
  const notional = p.entryPrice * p.qty * p.contractValue;
  const fillPrice = p.quoted ? impactOnly(p.entryPrice, side, p.cfg, notional) : slip(p.entryPrice, side, p.cfg, notional);
  const fee = feeFor(fillPrice, p.qty, p.contractValue, p.cfg);
  const legs = splitLegs(p.qty, p.cfg.tpSplit, p.tp.length);
  return {
    id: p.id, status: 'open', scannerId: p.scannerId, scannerName: p.scannerName, symbol: p.symbol, tf: p.tf, side: p.side,
    qty: p.qty, qtyOpen: p.qty, contractValue: p.contractValue, entryPrice: fillPrice, entryAt: p.at, sl: p.sl, slOriginal: p.sl,
    tp: p.tp.slice(0, legs.length), tpHit: legs.map(() => false), legs, breakEven: false, realizedPnl: 0, fees: fee, riskAmount: p.riskAmount,
    levelsSource: p.levelsSource, leverage: p.leverage ?? 0, marginLeverage: p.marginLeverage ?? p.leverage ?? 0, liqPrice: liquidationPrice(p.side, fillPrice, p.marginLeverage ?? p.leverage ?? 0, p.cfg), exitAt: null, exitPrice: null, exitReason: null, signalId: p.signalId,
    fills: [{ at: p.at, price: fillPrice, qty: p.qty, reason: 'entry', fee, pnl: 0 }], bt: p.bt, features: p.features, mlProb: p.mlProb ?? null, lastPriceBar: p.lastPriceBar, openedAt: p.openedAt ?? p.at,
  };
}

export interface FillEvent { position: Position; fill: Fill; closed: boolean }

/** Reduce/close a position at `price`. Mutates and returns the fill. */
export function fillExit(pos: Position, price: number, qty: number, reason: string, at: number, cfg: PaperConfig, withSlippage: boolean | 'quoted'): Fill {
  let q = Math.min(qty, pos.qtyOpen);
  // an exchange would have liquidated before any exit could print beyond the liquidation price
  if (pos.liqPrice !== null && (pos.side === 'long' ? price <= pos.liqPrice : price >= pos.liqPrice)) { price = pos.liqPrice; reason = 'liquidation'; q = pos.qtyOpen; withSlippage = true; }
  const exitSide = pos.side === 'long' ? 'sell' : 'buy';
  // 'quoted' means the caller already crossed the real spread, so only depth impact is added
  let px = withSlippage === 'quoted' ? impactOnly(price, exitSide, cfg, price * q * pos.contractValue)
    : withSlippage ? slip(price, exitSide, cfg, price * q * pos.contractValue) : price;
  const marginLeverage = pos.marginLeverage ?? pos.leverage;
  const margin = marginLeverage > 0 ? pos.entryPrice * q * pos.contractValue / marginLeverage : Infinity;
  if (reason === 'liquidation' && marginLeverage > 0) {
    const bankruptcy = Math.max(0, pos.entryPrice * (1 + (pos.side === 'long' ? -1 : 1) / marginLeverage));
    px = pos.side === 'long' ? Math.max(px, bankruptcy) : Math.min(px, bankruptcy);
  }
  // take-profit legs rest as limit orders → maker fee; everything else crosses the spread → taker fee
  const pnl = pnlOf(pos, px, q);
  const quotedFee = closingFeeWaived(pos, at, reason, cfg) ? 0 : feeFor(px, q, pos.contractValue, cfg, /^tp[123]$/.test(reason) && !withSlippage);
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
export function applyBar(pos: Position, bar: { time: number; high: number; low: number; close: number }, cfg: PaperConfig, atrNow?: number): Fill[] {
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
  // 3. trail LAST: this bar's exits were checked against the stop as it stood when the bar
  // opened, so a stop raised here only applies from the next bar. Trailing earlier would let
  // the same bar's high both raise the stop and then trigger it.
  trailStop(pos, long ? bar.high : bar.low, cfg, atrNow, bar.time);
  const stale = staleExit(pos, bar, cfg, (TF_SECONDS[pos.tf] ?? 0) * 1000);
  if (stale) fills.push(stale);
  return fills;
}

/**
 * Advance the trailing stop from the best price seen. Never moves against the position and does
 * nothing until the trade has shown `trailAfterR` of favourable excursion.
 */
/**
 * How much of the peak this trade gives back, given how large it is and how long it has stalled.
 *
 * A flat percentage treats a 1R trade and a 5R trade the same, which is backwards: the small one
 * needs room to become the large one, and the large one is worth protecting. `trailSteps` tightens
 * with size; `trailStall` tightens with time, because a trade that has stopped making highs is
 * usually finished — across 96 reconstructed trades the median stopped one sat 44 minutes between
 * its peak and its stop.
 */
export function giveBackPct(peakR: number, cfg: PaperConfig, minutesSincePeak = 0): number {
  let give = cfg.trailGiveBackPct ?? 0;
  for (const [atR, pct] of cfg.trailSteps ?? []) if (peakR >= atR) give = pct;
  const stall = cfg.trailStall;
  if (stall && stall.minutes > 0 && minutesSincePeak >= stall.minutes) give *= stall.factor;
  return give;
}

export function trailStop(pos: Position, favourable: number, cfg: PaperConfig, atrNow?: number, at?: number): void {
  if (pos.status !== 'open') return;
  const base = pos.slOriginal ?? pos.sl;
  if (base === null) return;
  const risk = Math.abs(pos.entryPrice - base);
  if (!(risk > 0)) return;
  const long = pos.side === 'long';
  const dir = long ? 1 : -1;
  const r = ((favourable - pos.entryPrice) * dir) / risk;
  if (r > (pos.peakR ?? 0)) { pos.peakR = r; if (at) pos.peakAt = at; }
  const peak = pos.peakR ?? 0;
  const stalledMin = at && pos.peakAt ? (at - pos.peakAt) / 60_000 : 0;

  // Two independent protections, whichever is higher wins. The floor banks a small gain once
  // the trade clears `floorAtR` and then stops moving, so it does not cap a runner; the trail
  // takes over later and rises with the peak.
  let keptR = -Infinity;
  const floorAt = cfg.floorAtR ?? 0;
  if (floorAt > 0 && peak >= floorAt) keptR = Math.max(keptR, cfg.floorKeepR ?? 0);
  const afterR = cfg.trailAfterR ?? 0;
  if (afterR > 0 && peak >= afterR) {
    const atrMult = cfg.trailAtrMult ?? 0;
    if (atrMult > 0 && atrNow && atrNow > 0) {
      // distance measured in today's volatility, converted into R so the rest of the maths is shared
      keptR = Math.max(keptR, peak - (atrMult * atrNow) / risk);
    } else {
      const give = giveBackPct(peak, cfg, stalledMin);
      keptR = Math.max(keptR, give > 0 ? peak * (1 - give / 100) : peak - (cfg.trailDistanceR > 0 ? cfg.trailDistanceR : 1));
    }
  }
  if (!Number.isFinite(keptR)) return;

  const level = pos.entryPrice + dir * keptR * risk;
  if (pos.sl === null || (long ? level > pos.sl : level < pos.sl)) {
    pos.sl = level;
    if (long ? level >= pos.entryPrice : level <= pos.entryPrice) pos.breakEven = true;
  }
}

/**
 * Time stop: a position still below `staleMinR` after `staleBars` bars is closed at market.
 * Returns the fill, or null when the rule is off or the trade is doing well enough.
 */
/**
 * The trade's own timeframe trend, +1 (up) or −1 (down), from closes against an EMA of `len` of them.
 * Cheap enough to recompute per bar and identical in the backtest and live, which is the point.
 */
export function trendSide(closes: number[], len: number): 1 | -1 {
  if (!closes.length) return 1;
  const k = 2 / (len + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return closes.at(-1)! >= ema ? 1 : -1;
}

/**
 * Aggregate closes into a higher timeframe, returning for every input bar the EMA of the last
 * higher-timeframe bar that had **closed** when it printed.
 *
 * The "had closed" part is the whole point: reading the forming higher-timeframe bar would let a
 * 15m signal see where its own 1h candle ends up, which is a look into the future and would make any
 * measurement of this filter worthless.
 */
export function higherTrend(bars: Array<{ time: number; close: number }>, tfMs: number, htfMs: number, len: number): Array<1 | -1 | undefined> {
  const k = 2 / (len + 1);
  const out: Array<1 | -1 | undefined> = [];
  let ema: number | null = null, n = 0, bucket = -1, lastClose = 0, closedEma: number | null = null, closedN = 0;
  for (const b of bars) {
    const slot = Math.floor(b.time / htfMs);
    if (slot !== bucket) {
      // the previous bucket is now complete: it becomes the trend every bar in this bucket sees
      if (bucket >= 0) { ema = ema === null ? lastClose : lastClose * k + ema * (1 - k); n++; closedEma = ema; closedN = n; }
      bucket = slot;
    }
    lastClose = b.close;
    out.push(closedEma === null || closedN < Math.min(len, 20) ? undefined : (b.close >= closedEma ? 1 : -1));
  }
  void tfMs;
  return out;
}

/** The trend right now from a series of closes; undefined when there is not enough history to judge. */
export function trendNow(closes: number[], len: number): 1 | -1 | undefined {
  return closes.length < len ? undefined : trendSide(closes, len);
}

/** The trend under each bar on its own timeframe: EMA of closes up to and including that bar. */
export function trendPerBar(bars: Array<{ close: number }>, len: number): Array<1 | -1 | undefined> {
  const k = 2 / (len + 1);
  let ema = bars[0]?.close ?? 0;
  return bars.map((b, i) => {
    ema = i ? b.close * k + ema * (1 - k) : b.close;
    return i < len ? undefined : (b.close >= ema ? 1 : -1);
  });
}

/**
 * Whether the trend gate refuses this entry, and why.
 *
 * `follow` is for scanners that trade continuation; `fade` for the ones designed to buy dips, where
 * agreeing with the trend is the wrong test. An unknown trend (not enough history) never blocks.
 */
export function trendGateReason(side: 'long' | 'short', trend: 1 | -1 | undefined, mode: TrendGateMode): string | null {
  if (mode === 'off' || trend === undefined) return null;
  const withTrend = (side === 'long' && trend === 1) || (side === 'short' && trend === -1);
  if (mode === 'follow' && !withTrend) return `against the trend (${side} while the trend is ${trend === 1 ? 'up' : 'down'})`;
  if (mode === 'fade' && withTrend) return `with the trend, and this scanner fades it (${side} while the trend is ${trend === 1 ? 'up' : 'down'})`;
  return null;
}

/**
 * Close a profitable trade that has turned: once its peak reached `minR`, a trend flip against the
 * position ends it at market. Nothing happens to trades that are still running, or not yet ahead.
 */
export function trendExit(pos: Position, trend: 1 | -1 | undefined, price: number, at: number, cfg: PaperConfig): Fill | null {
  const t = cfg.trendExit;
  if (!t?.enabled || pos.status !== 'open' || trend === undefined || !(price > 0)) return null;
  if ((pos.peakR ?? 0) < t.minR) return null;
  const against = pos.side === 'long' ? -1 : 1;
  if (trend !== against) return null;
  return fillExit(pos, price, pos.qtyOpen, 'trend', at, cfg, true);
}

/**
 * Take what is there when a small winner stops going anywhere.
 *
 * Below `floorAtR` nothing protects a trade: it can travel half an R, turn, and pay the full stop.
 * This closes it at market once the peak sits between `minR` and `maxR` and no new high has come for
 * `minutes` — deliberately narrow, because arming break-even in that band was the worst policy of the
 * fourteen measured in decision 36, and doing nothing there is what decision 34 left in place.
 */
export function earlyStallExit(pos: Position, price: number, at: number, cfg: PaperConfig): Fill | null {
  const s = cfg.earlyStall;
  if (!s || !(s.minutes > 0) || pos.status !== 'open' || !(price > 0)) return null;
  const peak = pos.peakR ?? 0;
  if (!(peak >= s.minR && peak < s.maxR)) return null;
  if (pos.peakAt === undefined || at - pos.peakAt < s.minutes * 60_000) return null;   // peakAt can legitimately be 0
  return fillExit(pos, price, pos.qtyOpen, 'stalled', at, cfg, true);
}

export function staleExit(pos: Position, bar: { time: number; close: number }, cfg: PaperConfig, tfMs: number): Fill | null {
  const bars = cfg.staleBars ?? 0;
  if (!(bars > 0) || pos.status !== 'open' || !(tfMs > 0)) return null;
  if ((bar.time - pos.entryAt) / tfMs < bars) return null;
  if ((pos.peakR ?? 0) >= (cfg.staleMinR ?? 0)) return null;
  return fillExit(pos, bar.close, pos.qtyOpen, 'stale', bar.time, cfg, true);
}

export interface PriceBar { time: number; high: number; low: number; close: number }

/** Process only price information newly observed since entry/the previous update.
 * OHLC extremes are cumulative; replaying an old low after TP1 must not hit the new BE stop.
 * In an entry minute without a baseline, only the current close is known to be post-entry.
 */
export function applyLiveBar(pos: Position, bar: PriceBar, cfg: PaperConfig, observedAt: number, atrNow?: number): Fill[] {
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
  return applyBar(pos, { time: observedAt, high, low, close: bar.close }, cfg, atrNow);
}

/** Where a position stands right now, in R, counting realised legs, fees and the open mark. */
export function openR(pos: Position, mark: number): number {
  if (!(pos.riskAmount > 0)) return 0;
  return (pos.realizedPnl - pos.fees + unrealized(pos, mark)) / pos.riskAmount;
}

/** True when an opposite signal is allowed to close this position. */
export function reversalAllowed(pos: Position, mark: number, cfg: PaperConfig): boolean {
  if (!cfg.allowReversal) return false;
  const min = cfg.reversalMinR ?? 0;
  return min <= 0 || openR(pos, mark) >= min;
}

export interface TapePrint { time: number; price: number; qty?: number }

/**
 * Apply one tape print (phase 2). Liquidation is checked against `markPrice` when known (Delta
 * liquidates on mark), stops trigger on the last trade and fill at that print with slippage
 * (a stop-market can fill through a gap), take-profit legs are resting limits that fill at their
 * level: with `limitFill: 'through'` only once a print goes beyond the level, with `'touch'` on
 * a print at the level. Prints before the entry are ignored.
 */
export function applyTrade(pos: Position, t: TapePrint, cfg: PaperConfig, markPrice?: number, atrNow?: number): Fill[] {
  if (pos.status !== 'open' || t.time < pos.entryAt || !(t.price > 0)) return [];
  const fills: Fill[] = [];
  const long = pos.side === 'long';
  const at = t.time;
  // 0. liquidation on mark (falls back to the print when no mark is known)
  const liqRef = markPrice && markPrice > 0 ? markPrice : t.price;
  if (pos.liqPrice !== null && (long ? liqRef <= pos.liqPrice : liqRef >= pos.liqPrice)) {
    fills.push(fillExit(pos, pos.liqPrice, pos.qtyOpen, 'liquidation', at, cfg, true));
    return fills;
  }
  // 1. stop-loss: triggered by the print, filled at the print (never better than the stop)
  if (pos.sl !== null && (long ? t.price <= pos.sl : t.price >= pos.sl)) {
    const reason = pos.breakEven ? 'be' : 'sl';
    const px = long ? Math.min(t.price, pos.sl) : Math.max(t.price, pos.sl);
    fills.push(fillExit(pos, px, pos.qtyOpen, reason, at, cfg, true));
    return fills;
  }
  // 2. resting take-profit limits, sequential legs
  const through = (cfg.limitFill ?? 'through') === 'through';
  for (let i = 0; i < pos.tp.length; i++) {
    if (pos.tpHit[i] || pos.legs[i] <= 0) continue;
    const hit = through ? (long ? t.price > pos.tp[i] : t.price < pos.tp[i]) : (long ? t.price >= pos.tp[i] : t.price <= pos.tp[i]);
    if (!hit) break;
    pos.tpHit[i] = true;
    const isLast = i === pos.tp.length - 1;
    const q = isLast ? pos.qtyOpen : Math.min(pos.legs[i], pos.qtyOpen);
    fills.push(fillExit(pos, pos.tp[i], q, `tp${i + 1}`, at, cfg, false));
    if (pos.qtyOpen <= 0) return fills;
    if (i === 0 && cfg.breakEvenAfterTp1 && !pos.breakEven) { pos.sl = pos.entryPrice; pos.breakEven = true; }
  }
  // 3. trail and profit floor LAST, as on bars: this print was judged against the stop as it stood,
  // and a stop it raises applies from the next print. Without this, tape mode silently ran without
  // the exit rules the strategy was chosen with.
  trailStop(pos, t.price, cfg, atrNow, t.time);
  return fills;
}

/** Mark-price liquidation check without a print (used when a new mark arrives between trades). */
export function applyMark(pos: Position, markPrice: number, at: number, cfg: PaperConfig): Fill[] {
  if (pos.status !== 'open' || pos.liqPrice === null || !(markPrice > 0) || at < pos.entryAt) return [];
  const long = pos.side === 'long';
  if (long ? markPrice <= pos.liqPrice : markPrice >= pos.liqPrice) return [fillExit(pos, pos.liqPrice, pos.qtyOpen, 'liquidation', at, cfg, true)];
  return [];
}

/**
 * Funding charge at a realization timestamp: rate (percent) × open notional at `markPrice`,
 * paid by longs when positive and received by shorts (and vice versa). Recorded as a zero-qty
 * fill with reason `funding`; the amount flows through realizedPnl (fees untouched).
 */
export function applyFunding(pos: Position, ratePct: number, markPrice: number, at: number): Fill | null {
  if (pos.status !== 'open' || pos.qtyOpen <= 0 || !Number.isFinite(ratePct) || ratePct === 0 || !(markPrice > 0) || at < pos.entryAt) return null;
  const notional = pos.qtyOpen * pos.contractValue * markPrice;
  const pnl = -(ratePct / 100) * notional * (pos.side === 'long' ? 1 : -1);
  pos.realizedPnl += pnl;
  const fill: Fill = { at, price: markPrice, qty: 0, reason: 'funding', fee: 0, pnl };
  pos.fills.push(fill);
  return fill;
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
