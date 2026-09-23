import { EventEmitter } from 'node:events';
import type { Db } from '../db.ts';
import { TF_SECONDS, type AppConfig, type ExitMode, type PaperConfig } from '../config.ts';
import type { Side, ExitType, ScanEvent } from '../scanners/extractor.ts';
import { logger } from '../log.ts';
import {
  type Position, type Fill, type PriceBar, type LevelResult, applyLiveBar, openR, reversalAllowed, applyScriptExit, applyTrade, applyMark, applyFunding, checkRiskVsFees, computeStats, fillExit, openPosition, resolveLevels, sizeContracts, unrealized, notionalOf, rMultiple, type TradeStats,
} from './logic.ts';

const log = logger.scoped('paper');

export interface MarketInfo { contractValue: number; tickSize: number }

export interface EntryDecision {
  action: 'opened' | 'ignored' | 'rejected' | 'reversed' | 'pending';
  reason?: string;
  position?: Position;
  closed?: Position;
  /** Tape mode: the position id reserved for an entry that fills at the next print after the latency window. */
  pendingId?: number;
}

/** Entry request passed to the portfolio risk layer (phase 3) before sizing. */
export interface RiskEntryRequest { scannerId: string; symbol: string; tf: string; side: Side; price: number; sl: number; atr?: number; at: number }
/** Portfolio risk layer hook (implemented by risk/manager.ts; optional so the engine and tests work without it). */
export interface RiskGate {
  /** Veto (`reject`) or scale (`leverageMult` ≤ 1 from drawdown scaling) an entry before sizing. */
  gate(req: RiskEntryRequest): { reject?: string; leverageMult: number };
  /** Correlation / exposure cap once the candidate's notional is known; returns a rejection reason or null. */
  exposureCheck(req: { symbol: string; side: Side; tf: string; notional: number }): string | null;
}

/** A pending entry is abandoned this long after its latency window closes. */
export const PENDING_EXPIRY_MS = 60_000;

/** Tape-mode entry waiting for its first print after signal time + latency. */
export interface PendingEntry {
  id: number; scannerId: string; scannerName: string; symbol: string; tf: string; side: Side; signalPrice: number; levels: LevelResult;
  market: MarketInfo; at: number; dueAt: number; signalId: number | null; features?: Record<string, number>; mlProb: number | null; score?: number; leverageMult: number;
}

/**
 * Live paper-trading account. Persists positions/orders/equity to SQLite and emits
 * `position` ({type, position}), `trade` (closed position), `order` (fill) and `stats`.
 */
export class PaperEngine extends EventEmitter {
  /**
   * Which book this engine owns: 0 is the live paper account, 2 the incubator's shadow book.
   * Every row it writes carries this in `bt`, and every query it makes filters on it, so the books
   * never see each other's positions. (1 is the in-memory backtest and never reaches the table.)
   */
  readonly book: number;
  private readonly kvPrefix: string;
  private db: Db;
  private cfgRef: () => AppConfig;
  private open = new Map<number, Position>();
  private closedCache: Position[] | null = null;
  private marks = new Map<string, number>();
  private priceBars = new Map<string, PriceBar>();
  private lastEquityPoint = 0;
  private lastEquityValue = NaN;
  // ---- phase 2: tape / mark / funding state ----
  /** Exchange mark price per symbol (from the `mark_price` channel); liquidation reference in tape mode. */
  private markPrices = new Map<string, { price: number; at: number }>();
  /** Wall-clock time of the last tape print per symbol (decides the 1m-candle fallback). */
  private lastTradeAt = new Map<string, number>();
  private pending = new Map<number, PendingEntry>();
  /** Portfolio risk layer; set by the composition root (app.ts). */
  risk: RiskGate | null = null;
  /**
   * How entry prices were obtained since start. `slippage` means no fresh top-of-book was
   * available and the configured slippage model priced the fill; a high share of those means
   * the quote feed is not delivering and simulated fills are optimistic by about half a spread.
   */
  readonly priceSource = { quote: 0, slippage: 0, rejectedNoQuote: 0 };

  /**
   * Current ATR of a position's own timeframe (last closed bars), for the ATR trail. Without it the
   * trail falls back to a fixed R distance, which is not the rule the backtest measured.
   */
  atrFor?: (symbol: string, tf: string) => number | undefined;

  constructor(db: Db, cfgRef: () => AppConfig, opts: { book?: number } = {}) {
    super();
    this.db = db; this.cfgRef = cfgRef;
    this.book = opts.book ?? 0;
    this.kvPrefix = this.book === 0 ? 'paper' : `book${this.book}`;
    for (const row of db.all<any>(`SELECT * FROM positions WHERE status='open' AND bt=${this.book}`)) {
      const p = rowToPosition(row); this.open.set(p.id, p);
    }
    // pending tape entries do not survive a restart (their signal is seconds old at most)
    for (const row of db.all<any>(`SELECT id, signal_id FROM positions WHERE status='pending' AND bt=${this.book}`)) {
      db.run('DELETE FROM positions WHERE id=?', row.id);
      if (row.signal_id) db.updateSignalAction(row.signal_id, 'rejected:pending entry dropped on restart', null);
    }
    log.info(`loaded ${this.open.size} open ${this.book === 0 ? 'paper' : 'shadow'} positions`);
  }

  private get paper(): PaperConfig { return this.cfgRef().paper; }
  private get tapeMode(): boolean { return (this.paper.fillSource ?? 'candles') === 'tape'; }

  // ---- account state ----

  get initialEquity(): number { return this.db.kvGet<number>(`${this.kvPrefix}.initialEquity`) ?? this.paper.initialEquity; }

  closedPositions(): Position[] {
    if (!this.closedCache) this.closedCache = this.db.all<any>(`SELECT * FROM positions WHERE status='closed' AND bt=${this.book} ORDER BY exit_at ASC`).map(rowToPosition);
    return this.closedCache;
  }

  realizedPnl(): number { return this.closedPositions().reduce((a, p) => a + p.realizedPnl - p.fees, 0) + [...this.open.values()].reduce((a, p) => a + p.realizedPnl - p.fees, 0); }

  unrealizedPnl(): number {
    let u = 0;
    for (const p of this.open.values()) { const m = this.marks.get(p.symbol); if (m) u += unrealized(p, m); }
    return u;
  }

  equity(): number { return this.initialEquity + this.realizedPnl() + this.unrealizedPnl(); }

  openPositions(): Position[] { return [...this.open.values()]; }
  position(id: number): Position | undefined { return this.open.get(id) ?? (this.db.get<any>('SELECT * FROM positions WHERE id=?', id) ? rowToPosition(this.db.get<any>('SELECT * FROM positions WHERE id=?', id)) : undefined); }

  /** Last traded price (ticker / tape / candle close): reference for unrealized P&L and market fills. */
  setMark(symbol: string, price: number) { this.marks.set(symbol, price); }

  /** Live top-of-book source (set by the realtime wiring); enables spread-crossing fills. */
  quotes: {
    executable(symbol: string, side: 'buy' | 'sell', maxAgeMs: number, now?: number): number | null;
    markState?(symbol: string): { bestBid: number | null; bestAsk: number | null; at: number; quoteAt?: number | null } | undefined;
  } | null = null;

  /**
   * What each fill was priced against, captured at the moment it happened.
   *
   * The simulated cost is only as good as `slippageBps`, and the edge is thin enough that a few
   * basis points decide it. Recording the live book alongside every fill lets the assumption be
   * audited against the market actually traded, rather than assumed correct for months.
   */
  private fillContext: { ref?: number; source?: 'quote' | 'slippage' } = {};

  /**
   * Price a market-style fill. With a fresh quote we cross the real spread (buy at ask,
   * sell at bid); otherwise we fall back to the configured slippage around `reference`.
   */
  marketPrice(symbol: string, side: 'buy' | 'sell', reference: number, cfg: PaperConfig, now = Date.now()): { price: number; source: 'quote' | 'slippage' } {
    if (cfg.useSpread && this.quotes) {
      const q = this.quotes.executable(symbol, side, cfg.quoteMaxAgeMs ?? 0, now);
      if (q !== null && Number.isFinite(q) && q > 0) return { price: q, source: 'quote' };
    }
    return { price: reference, source: 'slippage' };
  }

  /**
   * Entry pricing. Exits never go through here: a position must always be closable, even with
   * no book. When `paper.requireQuote` is on, an entry that cannot be priced off a fresh
   * top-of-book is refused rather than filled at an assumed price.
   */
  private entryPrice(symbol: string, side: 'buy' | 'sell', reference: number, cfg: PaperConfig, now: number): { price: number; quoted: boolean } | { reject: string } {
    const quoted = this.marketPrice(symbol, side, reference, cfg, now);
    if (quoted.source === 'slippage' && cfg.useSpread && cfg.requireQuote) {
      this.priceSource.rejectedNoQuote++;
      return { reject: `no executable ${side === 'buy' ? 'ask' : 'bid'} within ${cfg.quoteMaxAgeMs ?? 0}ms` };
    }
    this.priceSource[quoted.source]++;
    return { price: quoted.price, quoted: quoted.source === 'quote' };
  }
  mark(symbol: string): number | undefined { return this.marks.get(symbol); }
  /** Exchange mark price (liquidation reference). */
  markPrice(symbol: string): number | undefined { return this.markPrices.get(symbol)?.price; }
  pendingEntries(): PendingEntry[] { return [...this.pending.values()]; }
  /** True when a tape print for the symbol arrived within `tapeFallbackMs`. */
  tapeActive(symbol: string, now = Date.now()): boolean {
    const last = this.lastTradeAt.get(symbol);
    return last !== undefined && now - last <= (this.paper.tapeFallbackMs ?? 5000);
  }

  // ---- signals → positions ----

  findOpen(scannerId: string, symbol: string, tf: string): Position | undefined {
    for (const p of this.open.values()) if (p.scannerId === scannerId && p.symbol === symbol && p.tf === tf) return p;
    return undefined;
  }
  private findPending(scannerId: string, symbol: string, tf: string): PendingEntry | undefined {
    for (const p of this.pending.values()) if (p.scannerId === scannerId && p.symbol === symbol && p.tf === tf) return p;
    return undefined;
  }

  /** Paper config with drawdown scaling applied (risk % and leverage bounds multiplied by `mult`). */
  private scaledCfg(mult: number): PaperConfig {
    const cfg = this.paper;
    if (!(mult > 0) || mult >= 1) return cfg;
    const maxLeverage = Math.max(1, cfg.maxLeverage * mult);
    return { ...cfg, riskPerTradePct: cfg.riskPerTradePct * mult, maxLeverage, minLeverage: Math.min(maxLeverage, Math.max(1, cfg.minLeverage * mult)) };
  }

  /** Seconds between the close of the signal's bar and `at` (negative while the bar is still forming). */
  static signalAgeSec(ev: Pick<ScanEvent, 'barTime'>, tf: string, at: number): number {
    const tfSec = TF_SECONDS[tf] ?? 0;
    if (!ev.barTime || !tfSec) return 0;
    return (at - (ev.barTime + tfSec * 1000)) / 1000;
  }

  onEntry(ev: ScanEvent, ctx: { scannerId: string; scannerName: string; symbol: string; tf: string; market: MarketInfo; atr?: number; refPrice: number; at: number; signalId: number | null; exitMode: ExitMode; features?: Record<string, number>; mlProb?: number | null; scoreOverride?: number }): EntryDecision {
    const cfg = this.paper;
    // A signal acted on long after its bar closed could not have been taken at these prices
    // (restarts and deep queues used to replay bar-old signals straight into the book).
    const maxAge = cfg.maxSignalAgeSec ?? 0;
    if (maxAge > 0) {
      const age = PaperEngine.signalAgeSec(ev, ctx.tf, ctx.at);
      if (age > maxAge) return { action: 'rejected', reason: `stale signal: bar closed ${age.toFixed(0)}s ago (max ${maxAge}s)` };
    }
    const existing = this.findOpen(ctx.scannerId, ctx.symbol, ctx.tf);
    let closed: Position | undefined;
    if (existing) {
      if (existing.side === ev.side) return { action: 'ignored', reason: 'already in position' };
      if (!cfg.allowReversal) return { action: 'ignored', reason: 'opposite signal while in position (reversal disabled)' };
      const markNow = this.marks.get(existing.symbol) ?? ctx.refPrice;
      if (!reversalAllowed(existing, markNow, cfg)) {
        return { action: 'ignored', reason: `reversal held: position at ${openR(existing, markNow).toFixed(2)}R, below the ${cfg.reversalMinR}R needed to bank it` };
      }
      const ref = ev.price && ev.price > 0 ? ev.price : ctx.refPrice;
      const exitQuote = this.marketPrice(existing.symbol, existing.side === 'long' ? 'sell' : 'buy', ref, cfg, ctx.at);
      this.applyFills(existing, [fillExit(existing, exitQuote.price, existing.qtyOpen, 'reversal', ctx.at, cfg, exitQuote.source === 'quote' ? 'quoted' : true)]);
      closed = existing;
    }
    if (this.findPending(ctx.scannerId, ctx.symbol, ctx.tf)) return { action: 'ignored', reason: 'entry already pending', closed };
    if (this.open.size + this.pending.size >= cfg.maxOpenPositions) return { action: 'rejected', reason: `max open positions (${cfg.maxOpenPositions})`, closed };
    // A market entry pays the spread: buy at the ask, sell at the bid when a fresh quote exists.
    // The script's own price is only a reference and is often minutes old by the time we act.
    const reference = ev.price && ev.price > 0 ? ev.price : ctx.refPrice;
    const quoted = this.entryPrice(ctx.symbol, ev.side === 'long' ? 'buy' : 'sell', reference, cfg, ctx.at);
    if ('reject' in quoted) return { action: 'rejected', reason: `unpriceable: ${quoted.reject}`, closed };
    const price = quoted.price;
    this.fillContext = { ref: reference, source: quoted.quoted ? 'quote' : 'slippage' };
    const levels = resolveLevels({ symbol: ctx.symbol, side: ev.side!, price, sl: ev.sl, tp: ev.tp, atr: ctx.atr }, cfg, ctx.market.tickSize);
    if ('error' in levels) return { action: 'rejected', reason: levels.error, closed };
    const feeErr = checkRiskVsFees(price, levels.sl, cfg, ctx.symbol);
    if (feeErr) return { action: 'rejected', reason: feeErr, closed };
    // portfolio risk layer: kill switches, position caps, cooldowns, regime filter, drawdown scaling
    let leverageMult = 1;
    if (this.risk) {
      const g = this.risk.gate({ scannerId: ctx.scannerId, symbol: ctx.symbol, tf: ctx.tf, side: ev.side!, price, sl: levels.sl, atr: ctx.atr, at: ctx.at });
      if (g.reject) return { action: 'rejected', reason: `risk ${g.reject}`, closed };
      leverageMult = g.leverageMult;
    }
    const size = this.size(price, levels.sl, ctx.market, ev.score ?? ctx.scoreOverride, leverageMult);
    if (size.qty < 1) return { action: 'rejected', reason: size.reason ?? 'size', closed };
    if (this.risk) {
      const x = this.risk.exposureCheck({ symbol: ctx.symbol, side: ev.side!, tf: ctx.tf, notional: size.qty * ctx.market.contractValue * price });
      if (x) return { action: 'rejected', reason: `risk ${x}`, closed };
    }
    if (this.tapeMode) {
      // latency model: the order reaches the book latencyMs after the signal and fills at the first print after that
      const id = this.nextId();
      const pe: PendingEntry = { id, scannerId: ctx.scannerId, scannerName: ctx.scannerName, symbol: ctx.symbol, tf: ctx.tf, side: ev.side!, signalPrice: price, levels, market: ctx.market, at: ctx.at, dueAt: ctx.at + (cfg.latencyMs ?? 0), signalId: ctx.signalId, features: ctx.features, mlProb: ctx.mlProb ?? null, score: ev.score ?? ctx.scoreOverride, leverageMult };
      this.pending.set(id, pe);
      this.db.run("UPDATE positions SET scanner_id=?, scanner_name=?, symbol=?, tf=?, side=?, entry_price=?, entry_at=?, signal_id=?, fills=? WHERE id=?", pe.scannerId, pe.scannerName, pe.symbol, pe.tf, pe.side, price, pe.at, pe.signalId, JSON.stringify({ pending: { dueAt: pe.dueAt, levels } }), id);
      log.info(`PENDING ${pe.side.toUpperCase()} ${pe.symbol} @~${price.toFixed(2)} fills at first print after +${cfg.latencyMs ?? 0}ms [${ctx.scannerId}]`);
      return { action: 'pending', reason: 'awaiting tape fill', pendingId: id, closed };
    }
    const pos = this.openAt(this.nextId(), { scannerId: ctx.scannerId, scannerName: ctx.scannerName, symbol: ctx.symbol, tf: ctx.tf, side: ev.side!, qty: size.qty, contractValue: ctx.market.contractValue, entryPrice: price, at: ctx.at, sl: levels.sl, tp: levels.tp, tpSplit: levels.tpSplit, riskAmount: size.riskAmount, levelsSource: levels.source, signalId: ctx.signalId, leverage: size.leverage, marginLeverage: size.marginLeverage, features: ctx.features, mlProb: ctx.mlProb ?? null, quoted: quoted.quoted, scannerTag: ctx.scannerId }, cfg);
    return { action: closed ? 'reversed' : 'opened', position: pos, closed };
  }

  private size(price: number, sl: number, market: MarketInfo, score: number | undefined, leverageMult: number) {
    const cfg = this.scaledCfg(leverageMult);
    const openNotional = [...this.open.values()].reduce((a, p) => a + notionalOf(p), 0);
    const reservedMargin = [...this.open.values()].reduce((a, p) => a + notionalOf(p) / (p.marginLeverage || p.leverage || cfg.maxLeverage), 0);
    return sizeContracts(price, sl, { equity: this.equity(), availableMargin: this.initialEquity + this.realizedPnl() - reservedMargin, contractValue: market.contractValue, tickSize: market.tickSize, cfg }, openNotional, score);
  }

  private openAt(id: number, p: Omit<Parameters<typeof openPosition>[0], 'id' | 'cfg' | 'bt' | 'lastPriceBar'> & { scannerTag: string }, cfg: PaperConfig): Position {
    // `quoted` entries already crossed the real spread; openPosition adds depth impact only
    const pos = openPosition({ ...p, id, cfg, bt: false, lastPriceBar: this.priceBars.get(p.symbol) });
    this.open.set(id, pos);
    this.persist(pos);
    this.persistFill(pos, pos.fills[0]);
    this.emit('order', orderOf(pos, pos.fills[0]));   // the fill precedes the open position (executor: entry before bracket)
    this.emit('position', { type: 'opened', position: pos });
    this.recordEquity(true);
    log.info(`${this.book ? 'INCUBATOR ' : ''}OPEN ${pos.side.toUpperCase()} ${pos.symbol} x${pos.qty} @ ${pos.entryPrice.toFixed(2)} ${pos.leverage.toFixed(1)}x sl ${pos.sl} tp ${pos.tp.join('/')} liq ${pos.liqPrice?.toFixed(1) ?? '-'} [${p.scannerTag}]`);
    return pos;
  }

  /** Fill a pending entry at `price` (first print after the latency window, or the 1m close when the tape is silent). */
  private fillPending(pe: PendingEntry, price: number, at: number, source: 'tape' | 'candle', receivedAt = Date.now()): Position | null {
    this.pending.delete(pe.id);
    const cfg = this.paper;
    const cancel = (reason: string) => {
      this.db.run('DELETE FROM positions WHERE id=?', pe.id);
      if (pe.signalId) this.db.updateSignalAction(pe.signalId, `rejected:${reason}`, null);
      log.info(`PENDING ${pe.symbol} cancelled: ${reason} [${pe.scannerId}]`);
      this.emit('pending', { type: 'cancelled', id: pe.id, reason });
      return null;
    };
    // expiry belongs in the fill path, not only in housekeeping: a print can arrive past the
    // deadline before the next housekeeping tick and would otherwise still be filled
    if (receivedAt > pe.dueAt + PENDING_EXPIRY_MS) return cancel(`no fill within ${PENDING_EXPIRY_MS / 1000}s of the latency window`);
    // the signal's levels are absolute; the fill price must still sit on the right side of them
    if (pe.levels.tpSplit && pe.levels.tp.some(tp => pe.side === 'long' ? price >= tp : price <= tp)) return cancel('price moved past a pair target before fill');
    const levels = resolveLevels({ side: pe.side, price, sl: pe.levels.sl, tp: pe.levels.tp }, cfg, pe.market.tickSize);
    if (!('error' in levels)) levels.tpSplit = pe.levels.tpSplit;
    if ('error' in levels) return cancel(`price moved past levels before fill (${levels.error})`);
    const feeErr = checkRiskVsFees(price, levels.sl, cfg, pe.symbol);
    if (feeErr) return cancel(feeErr);
    if (this.open.size >= cfg.maxOpenPositions) return cancel(`max open positions (${cfg.maxOpenPositions})`);
    // the portfolio risk layer was consulted when the entry was queued; the book can have
    // halted, hit a cap or changed the drawdown scaling since, so ask it again at fill time
    let leverageMult = pe.leverageMult;
    if (this.risk) {
      const g = this.risk.gate({ scannerId: pe.scannerId, symbol: pe.symbol, tf: pe.tf, side: pe.side, price, sl: levels.sl, at: receivedAt });
      if (g.reject) return cancel(`risk ${g.reject}`);
      leverageMult = g.leverageMult;
    }
    const size = this.size(price, levels.sl, pe.market, pe.score, leverageMult);
    if (size.qty < 1) return cancel(size.reason ?? 'size');
    if (this.risk) {
      const x = this.risk.exposureCheck({ symbol: pe.symbol, side: pe.side, tf: pe.tf, notional: size.qty * pe.market.contractValue * price });
      if (x) return cancel(`risk ${x}`);
    }
    const pos = this.openAt(pe.id, { scannerId: pe.scannerId, scannerName: pe.scannerName, symbol: pe.symbol, tf: pe.tf, side: pe.side, qty: size.qty, contractValue: pe.market.contractValue, entryPrice: price, at, sl: levels.sl, tp: levels.tp, tpSplit: levels.tpSplit, riskAmount: size.riskAmount, levelsSource: pe.levels.source, signalId: pe.signalId, leverage: size.leverage, marginLeverage: size.marginLeverage, features: pe.features, mlProb: pe.mlProb, scannerTag: `${pe.scannerId} ${source} +${at - pe.at}ms` }, cfg);
    if (pe.signalId) this.db.updateSignalAction(pe.signalId, 'opened', pos.id);
    return pos;
  }

  /** Cancel a pending entry (manual or expiry). */
  cancelPending(id: number, reason = 'cancelled'): boolean {
    const pe = this.pending.get(id);
    if (!pe) return false;
    this.pending.delete(id);
    this.db.run('DELETE FROM positions WHERE id=?', id);
    if (pe.signalId) this.db.updateSignalAction(pe.signalId, `rejected:${reason}`, null);
    this.emit('pending', { type: 'cancelled', id, reason });
    return true;
  }

  /** Expire pending entries that neither the tape nor a candle could fill within a minute past their due time. */
  housekeeping(now = Date.now()): void {
    for (const pe of [...this.pending.values()]) if (now > pe.dueAt + PENDING_EXPIRY_MS) this.cancelPending(pe.id, `no fill within ${PENDING_EXPIRY_MS / 1000}s of the latency window`);
  }

  // ---- phase 2: tape, mark price, funding ----

  /** One print from the tape. Fills due pending entries, then checks liquidation (on mark), stop and resting targets. */
  onTrade(symbol: string, price: number, qty: number, time: number, observedAt = Date.now()): void {
    if (!(price > 0)) return;
    this.lastTradeAt.set(symbol, observedAt);
    this.marks.set(symbol, price);
    if (!this.tapeMode) return;
    const filled = new Set<number>();
    for (const pe of [...this.pending.values()]) {
      if (pe.symbol !== symbol || time < pe.dueAt) continue;
      const pos = this.fillPending(pe, price, time, 'tape', observedAt);
      if (pos) filled.add(pos.id);
    }
    const mark = this.markPrices.get(symbol)?.price;
    for (const pos of [...this.open.values()]) {
      if (pos.symbol !== symbol || filled.has(pos.id)) continue;
      const slBefore = pos.sl;
      const atr = (this.paper.trailAtrMult ?? 0) > 0 ? this.atrFor?.(pos.symbol, pos.tf) : undefined;
      const fills = applyTrade(pos, { time, price, qty }, this.paper, mark, atr);
      if (fills.length) this.applyFills(pos, fills);
      else if (pos.sl !== slBefore) { this.persist(pos); this.emit('position', { type: 'updated', position: pos }); }
    }
    this.recordEquity(false);
  }

  /** Exchange mark price update: liquidation reference (tape mode), otherwise informational. */
  onMarkPrice(symbol: string, price: number, at = Date.now()): void {
    if (!(price > 0)) return;
    const prev = this.markPrices.get(symbol);
    if (prev && at < prev.at) return;
    this.markPrices.set(symbol, { price, at });
    if (!this.tapeMode) return;
    for (const pos of [...this.open.values()]) {
      if (pos.symbol !== symbol) continue;
      const fills = applyMark(pos, price, at, this.paper);
      if (fills.length) this.applyFills(pos, fills);
    }
  }

  /** Charge funding (percent rate × notional at mark, sign by side) to every open position of the symbol. Returns the number charged. */
  chargeFunding(symbol: string, ratePct: number, at = Date.now()): number {
    if (!(this.paper.fundingCharges ?? true)) return 0;
    const mark = this.markPrices.get(symbol)?.price ?? this.marks.get(symbol);
    let n = 0;
    for (const pos of [...this.open.values()]) {
      if (pos.symbol !== symbol) continue;
      const fill = applyFunding(pos, ratePct, mark ?? pos.entryPrice, at);
      if (!fill) continue;
      this.applyFills(pos, [fill]);
      n++;
    }
    if (n) { log.info(`FUNDING ${symbol} ${ratePct}% charged to ${n} position(s)`); this.recordEquity(true); }
    return n;
  }

  onScriptExit(scannerId: string, symbol: string, tf: string, exitType: ExitType, price: number | undefined, at: number, exitMode: ExitMode, side?: Side): Position | undefined {
    const pos = this.findOpen(scannerId, symbol, tf);
    if (!pos) return undefined;
    if (side && pos.side !== side) return undefined;
    const fallback = price ?? this.marks.get(symbol) ?? pos.entryPrice;
    const fills = applyScriptExit(pos, exitType, price, at, this.paper, exitMode, fallback);
    if (fills.length) this.applyFills(pos, fills);
    return pos;
  }

  /**
   * Feed a 1m candle for a symbol. In `candles` mode (legacy) it drives every fill; in `tape` mode it
   * only takes over while the tape has been silent for more than `tapeFallbackMs`, otherwise it just
   * refreshes each position's candle baseline so a later fallback sees only new movement.
   */
  onBar(symbol: string, bar: PriceBar, observedAt = Date.now(), opts: { historical?: boolean } = {}): void {
    if (bar.time < (this.priceBars.get(symbol)?.time ?? -Infinity)) return;
    this.priceBars.set(symbol, { ...bar });
    this.housekeeping(observedAt);
    // A bar a resync pulled from REST describes a period that has already ended. Its prices are
    // real, so open positions may still exit on them, but they are stamped at the bar's own close
    // instead of now, they never fill a new entry, and they never become the live mark.
    const barClosedAt = bar.time + 60_000;
    const historical = opts.historical === true || observedAt > barClosedAt + 60_000;
    const eventAt = historical ? Math.min(observedAt, barClosedAt) : observedAt;
    if (this.tapeMode && this.tapeActive(symbol, observedAt)) {
      for (const pos of this.open.values()) if (pos.symbol === symbol && pos.status === 'open' && observedAt >= pos.entryAt) pos.lastPriceBar = { ...bar };
      return;
    }
    if (!historical) this.marks.set(symbol, bar.close);
    if (this.tapeMode && !historical) {
      for (const pe of [...this.pending.values()]) if (pe.symbol === symbol && observedAt >= pe.dueAt) this.fillPending(pe, bar.close, observedAt, 'candle', observedAt);
    }
    for (const pos of [...this.open.values()]) {
      if (pos.symbol !== symbol) continue;
      const previous = pos.lastPriceBar;
      const fills = applyLiveBar(pos, bar, this.paper, eventAt, (this.paper.trailAtrMult ?? 0) > 0 ? this.atrFor?.(pos.symbol, pos.tf) : undefined);
      if (fills.length) this.applyFills(pos, fills);
      else if (pos.lastPriceBar !== previous) this.persist(pos);
    }
    this.recordEquity(false);
  }

  closeManual(id: number, reason = 'manual', at = Date.now()): Position | undefined {
    const pos = this.open.get(id);
    if (!pos) return undefined;
    const px = this.marks.get(pos.symbol) ?? pos.entryPrice;
    this.applyFills(pos, [fillExit(pos, px, pos.qtyOpen, reason, at, this.paper, true)]);
    return pos;
  }

  /** Close every open position that belongs to one scanner (used when a scanner is removed/disabled). */
  closeScanner(scannerId: string, reason = 'removed'): number {
    let n = 0;
    for (const p of [...this.open.values()]) if (p.scannerId === scannerId && this.closeManual(p.id, reason)) n++;
    return n;
  }

  closeAll(reason = 'manual'): number {
    let n = 0;
    for (const id of [...this.pending.keys()]) this.cancelPending(id, reason);
    for (const id of [...this.open.keys()]) if (this.closeManual(id, reason)) n++;
    return n;
  }

  reset(): void {
    this.db.transaction(() => {
      this.db.run(`DELETE FROM positions WHERE bt=${this.book}`);
      this.db.run(`DELETE FROM orders WHERE bt=${this.book}`);
      if (this.book === 0) {
        this.db.run('DELETE FROM equity');
        this.db.run("UPDATE signals SET action='reset', position_id=NULL WHERE position_id IS NOT NULL");
      }
    });
    this.open.clear(); this.pending.clear(); this.closedCache = null;
    this.db.kvSet(`${this.kvPrefix}.initialEquity`, this.paper.initialEquity);
    this.db.kvSet(`${this.kvPrefix}.resetAt`, Date.now());
    this.recordEquity(true);
    this.emit('stats', this.stats());
    log.warn('paper account reset');
  }

  // ---- stats ----

  stats(): any {
    const closed = this.closedPositions();
    const initial = this.initialEquity;
    const g = computeStats(closed, initial);
    const byScanner: Record<string, TradeStats & { open: number; unrealized: number }> = {};
    const bySymbol: Record<string, { trades: number; pnl: number }> = {};
    const ids = new Set<string>([...closed.map(p => p.scannerId), ...[...this.open.values()].map(p => p.scannerId)]);
    for (const id of ids) {
      const s = computeStats(closed.filter(p => p.scannerId === id), initial) as any;
      s.open = [...this.open.values()].filter(p => p.scannerId === id).length;
      s.unrealized = [...this.open.values()].filter(p => p.scannerId === id).reduce((a, p) => a + unrealized(p, this.marks.get(p.symbol) ?? p.entryPrice), 0);
      byScanner[id] = s;
    }
    for (const p of closed) { const b = bySymbol[p.symbol] ?? (bySymbol[p.symbol] = { trades: 0, pnl: 0 }); b.trades++; b.pnl += p.realizedPnl - p.fees; }
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const todayPnl = closed.filter(p => (p.exitAt ?? 0) >= dayStart.getTime()).reduce((a, p) => a + p.realizedPnl - p.fees, 0);
    return {
      equity: this.equity(), initialEquity: initial, realizedPnl: this.realizedPnl(), unrealizedPnl: this.unrealizedPnl(), fees: g.fees + [...this.open.values()].reduce((a, p) => a + p.fees, 0),
      openPositions: this.open.size, pendingEntries: this.pending.size, trades: g.trades, wins: g.wins, losses: g.losses, winRatePct: g.winRatePct, profitFactor: fin(g.profitFactor),
      maxDrawdownPct: g.maxDrawdownPct, avgR: g.avgR, expectancy: g.expectancy, todayPnl, byScanner: mapFin(byScanner), bySymbol,
    };
  }

  /** Closed positions grouped by scanner, so a full scanner list does not rescan the array per scanner. */
  closedByScanner(): Map<string, Position[]> {
    const m = new Map<string, Position[]>();
    for (const p of this.closedPositions()) { const l = m.get(p.scannerId); if (l) l.push(p); else m.set(p.scannerId, [p]); }
    return m;
  }

  /** Open-position counts per scanner, same reason. */
  openCountByScanner(): Map<string, number> {
    const m = new Map<string, number>();
    for (const p of this.open.values()) m.set(p.scannerId, (m.get(p.scannerId) ?? 0) + 1);
    return m;
  }

  scannerStats(id: string, pre?: { closed: Map<string, Position[]>; open: Map<string, number> }) {
    if (pre) {
      const s: any = computeStats(pre.closed.get(id) ?? [], this.initialEquity);
      s.profitFactor = fin(s.profitFactor);
      s.open = pre.open.get(id) ?? 0;
      s.pnlPct = this.initialEquity ? s.pnl / this.initialEquity * 100 : 0;
      return s;
    }
    const closed = this.closedPositions().filter(p => p.scannerId === id);
    const s: any = computeStats(closed, this.initialEquity);
    s.profitFactor = fin(s.profitFactor);
    s.open = [...this.open.values()].filter(p => p.scannerId === id).length;
    s.pnlPct = this.initialEquity ? s.pnl / this.initialEquity * 100 : 0;
    return s;
  }

  equityCurve(scannerId: string | null, limit = 2000) {
    if (!scannerId) return this.db.all<any>('SELECT at, equity, realized, unrealized FROM equity WHERE scanner_id IS NULL ORDER BY at DESC LIMIT ?', limit).reverse();
    // per-scanner curve derived from closed trades
    const closed = this.closedPositions().filter(p => p.scannerId === scannerId);
    let eq = 0; const out = [{ at: closed[0]?.entryAt ?? Date.now(), equity: 0, realized: 0, unrealized: 0 }];
    for (const p of closed) { eq += p.realizedPnl - p.fees; out.push({ at: p.exitAt!, equity: eq, realized: eq, unrealized: 0 }); }
    return out.slice(-limit);
  }

  // ---- persistence ----

  private nextId(): number {
    const r = this.db.run("INSERT INTO positions(status, scanner_id, scanner_name, symbol, tf, side, qty, qty_open, contract_value, entry_price, entry_at, bt) VALUES ('pending','','','','','long',0,0,0,0,0,?)", this.book);
    return Number(r.lastInsertRowid);
  }

  private persist(p: Position) {
    this.db.run(
      `UPDATE positions SET status=?, scanner_id=?, scanner_name=?, symbol=?, tf=?, side=?, qty=?, qty_open=?, contract_value=?, entry_price=?, entry_at=?, sl=?, sl_original=?, tp=?, tp_hit=?, break_even=?,
       realized_pnl=?, fees=?, risk_amount=?, levels_source=?, exit_at=?, exit_price=?, exit_reason=?, signal_id=?, fills=?, bt=? WHERE id=?`,
      p.status, p.scannerId, p.scannerName, p.symbol, p.tf, p.side, p.qty, p.qtyOpen, p.contractValue, p.entryPrice, p.entryAt, p.sl, p.slOriginal, JSON.stringify(p.tp), JSON.stringify(p.tpHit), p.breakEven ? 1 : 0,
      p.realizedPnl, p.fees, p.riskAmount, p.levelsSource, p.exitAt, p.exitPrice, p.exitReason, p.signalId, JSON.stringify({ fills: p.fills, legs: p.legs, leverage: p.leverage, marginLeverage: p.marginLeverage, liqPrice: p.liqPrice, features: p.features, mlProb: p.mlProb, lastPriceBar: p.lastPriceBar, peakR: p.peakR }), this.book, p.id,
    );
  }

  private persistFill(p: Position, f: Fill) {
    const side = fillSide(p, f);
    const q = this.quotes?.markState?.(p.symbol);
    const ctx = this.fillContext;
    this.db.run(
      'INSERT INTO orders(at, position_id, scanner_id, symbol, side, qty, price, fee, reason, bt, ref_price, bid, ask, quote_at, price_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      f.at, p.id, p.scannerId, p.symbol, side, f.qty, f.price, f.fee, f.reason, this.book,
      ctx.ref ?? null, q?.bestBid ?? null, q?.bestAsk ?? null, q?.quoteAt ?? null, ctx.source ?? null,
    );
    this.fillContext = {};
  }

  private applyFills(pos: Position, fills: Fill[]) {
    for (const f of fills) { this.persistFill(pos, f); this.emit('order', orderOf(pos, f)); }
    this.persist(pos);
    if (pos.status === 'closed') {
      this.open.delete(pos.id);
      this.closedCache = null;
      this.emit('position', { type: 'closed', position: pos });
      this.emit('trade', tradeOf(pos));
      log.info(`${this.book ? 'INCUBATOR ' : ''}CLOSE ${pos.side.toUpperCase()} ${pos.symbol} x${pos.qty} ${pos.exitReason} pnl ${(pos.realizedPnl - pos.fees).toFixed(2)} [${pos.scannerId}]`);
      this.recordEquity(true);
      this.emit('stats', this.stats());
    } else {
      this.emit('position', { type: 'updated', position: pos });
    }
  }

  private recordEquity(force: boolean) {
    // the equity table and the drawdown alert belong to the live account only
    if (this.book !== 0) return;
    const now = Date.now();
    const eq = this.equity();
    if (!force && (now - this.lastEquityPoint < 60_000 || Math.abs(eq - this.lastEquityValue) < 1e-9)) return;
    this.lastEquityPoint = now; this.lastEquityValue = eq;
    this.db.run('INSERT INTO equity(at, scanner_id, equity, realized, unrealized) VALUES (?,?,?,?,?)', now, null, eq, this.realizedPnl(), this.unrealizedPnl());
  }

  orders(limit = 200) {
    return this.db.all<any>(`SELECT id, at, position_id positionId, scanner_id scannerId, symbol, side, qty, price, fee, reason FROM orders WHERE bt=${this.book} ORDER BY at DESC, id DESC LIMIT ?`, limit);
  }

  trades(opts: { limit?: number; scanner?: string; symbol?: string } = {}) {
    let list = this.closedPositions();
    if (opts.scanner) list = list.filter(p => p.scannerId === opts.scanner);
    if (opts.symbol) list = list.filter(p => p.symbol === opts.symbol);
    return list.slice().reverse().slice(0, opts.limit ?? 200).map(tradeOf);
  }
}

function fin(v: number | null): number | null { return v === null || !Number.isFinite(v) ? (v === Infinity ? 999 : null) : v; }
function mapFin<T extends Record<string, any>>(o: T): T { for (const k of Object.keys(o)) o[k].profitFactor = fin(o[k].profitFactor); return o; }

export function rowToPosition(r: any): Position {
  const extra = safe(r.fills, { fills: [], legs: [] });
  return {
    id: r.id, status: r.status, scannerId: r.scanner_id, scannerName: r.scanner_name, symbol: r.symbol, tf: r.tf, side: r.side, qty: r.qty, qtyOpen: r.qty_open,
    contractValue: r.contract_value, entryPrice: r.entry_price, entryAt: r.entry_at, sl: r.sl, slOriginal: r.sl_original, tp: safe(r.tp, []), tpHit: safe(r.tp_hit, []),
    legs: extra.legs ?? [], leverage: extra.leverage ?? 0, marginLeverage: extra.marginLeverage ?? extra.leverage ?? 0, liqPrice: extra.liqPrice ?? null, features: extra.features, mlProb: extra.mlProb ?? null, lastPriceBar: extra.lastPriceBar, peakR: extra.peakR, breakEven: Boolean(r.break_even), realizedPnl: r.realized_pnl, fees: r.fees, riskAmount: r.risk_amount, levelsSource: r.levels_source ?? 'script',
    exitAt: r.exit_at, exitPrice: r.exit_price, exitReason: r.exit_reason, signalId: r.signal_id, fills: extra.fills ?? [], bt: Boolean(r.bt),
  };
}
function safe(s: string, d: any) { try { return JSON.parse(s); } catch { return d; } }

/**
 * `mark` is the last traded price the engine values the position at; `exchangeMark` is Delta's own
 * mark price, the reference an exchange liquidates against. They are different numbers and the UI
 * must not present one as the other.
 */
export function positionView(p: Position, mark?: number, exchangeMark?: number | null) {
  const m = mark ?? p.entryPrice;
  return {
    id: p.id, scannerId: p.scannerId, scannerName: p.scannerName, symbol: p.symbol, tf: p.tf, side: p.side, qty: p.qty, qtyOpen: p.qtyOpen, contractValue: p.contractValue,
    entryPrice: p.entryPrice, entryAt: p.entryAt, sl: p.sl, slOriginal: p.slOriginal, tp: p.tp, tpHit: p.tpHit, breakEven: p.breakEven, markPrice: m,
    // contracts allocated to each target: a zero leg can never fill, so the UI must not imply it will
    legs: p.legs, peakR: p.peakR ?? null,
    unrealizedPnl: unrealized(p, m), realizedPnl: p.realizedPnl, fees: p.fees, riskAmount: p.riskAmount, rMultiple: p.riskAmount ? (p.realizedPnl - p.fees + unrealized(p, m)) / p.riskAmount : null,
    levelsSource: p.levelsSource, leverage: p.leverage, marginLeverage: p.marginLeverage, liqPrice: p.liqPrice, signalId: p.signalId, status: p.status,
    notional: p.qtyOpen * p.contractValue * m, notionalEntry: p.qty * p.contractValue * p.entryPrice, mlProb: p.mlProb ?? null,
    margin: (p.marginLeverage ?? p.leverage) > 0 ? notionalOf(p) / (p.marginLeverage ?? p.leverage) : null,
    exchangeMark: exchangeMark ?? null,
  };
}

export function tradeOf(p: Position) {
  const net = p.realizedPnl - p.fees;
  return {
    id: p.id, positionId: p.id, scannerId: p.scannerId, scannerName: p.scannerName, symbol: p.symbol, tf: p.tf, side: p.side, qty: p.qty, entryPrice: p.entryPrice,
    exitPrice: p.exitPrice, entryAt: p.entryAt, exitAt: p.exitAt, pnl: net, pnlPct: p.entryPrice ? net / (p.entryPrice * p.qty * p.contractValue) * 100 : 0, fees: p.fees,
    rMultiple: rMultiple(p), exitReason: p.exitReason, levelsSource: p.levelsSource, leverage: p.leverage, mlProb: p.mlProb ?? null, features: p.features, sl: p.slOriginal, tp: p.tp, tpHit: p.tpHit, fills: p.fills, signalId: p.signalId,
  };
}

/** Order side of a fill: entries trade with the position, exits against it; a funding charge is `pay` or `receive`. */
export function fillSide(p: Position, f: Fill): 'buy' | 'sell' | 'pay' | 'receive' {
  if (f.reason === 'funding') return f.pnl < 0 ? 'pay' : 'receive';
  return f.reason === 'entry' ? (p.side === 'long' ? 'buy' : 'sell') : (p.side === 'long' ? 'sell' : 'buy');
}

export function orderOf(p: Position, f: Fill) {
  return { at: f.at, positionId: p.id, scannerId: p.scannerId, symbol: p.symbol, side: fillSide(p, f), qty: f.qty, price: f.price, fee: f.fee, reason: f.reason, pnl: f.pnl };
}
