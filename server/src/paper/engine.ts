import { EventEmitter } from 'node:events';
import type { Db } from '../db.ts';
import { TF_SECONDS, type AppConfig, type ExitMode, type ExitOverride, type PaperConfig } from '../config.ts';
import type { Side, ExitType, ScanEvent } from '../scanners/extractor.ts';
import { logger } from '../log.ts';
import {
  type Position, type Fill, type PriceBar, type LevelResult, applyLiveBar, openR, reversalAllowed, applyScriptExit, applyTrade, applyMark, applyFunding, checkRiskVsFees, trendExit, computeStats, fillExit, openPosition, resolveLevels, sizeContracts, unrealized, notionalOf, rMultiple, type TradeStats, exitConfigFor, earlyStallExit, splitLegs, liquidationPrice, pnlOf } from './logic.ts';

const log = logger.scoped('paper');

/** Pricing provenance belongs to one fill, never to an engine-wide pending context. */
interface FillContext { ref?: number; source?: 'quote' | 'slippage' | 'exchange' }

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
export interface RiskEntryRequest { scannerId: string; symbol: string; tf: string; side: Side; price: number; sl: number; atr?: number; at: number;
  /** A reversal: the open position this entry replaces; it does not count against caps or exposure (decision 77). */
  replacing?: number }
/** Portfolio risk layer hook (implemented by risk/manager.ts; optional so the engine and tests work without it). */
export interface RiskGate {
  /** Veto (`reject`) or scale (`leverageMult` ≤ 1 from drawdown scaling) an entry before sizing. */
  gate(req: RiskEntryRequest): { reject?: string; leverageMult: number };
  /** Correlation / exposure cap once the candidate's notional is known; returns a rejection reason or null. */
  exposureCheck(req: { symbol: string; side: Side; tf: string; notional: number; replacing?: number }): string | null;
}

/** A pending entry is abandoned this long after its latency window closes. */
export const PENDING_EXPIRY_MS = 60_000;
/** Candles mode: a due entry with no price update since the window closed fills at the mark after this long (the order is on the book; a quiet tape is not a reason not to fill). */
export const QUIET_FILL_MS = 1000;

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
  /** Highest equity since the last reset and the deepest drawdown from it, persisted; the one source for every drawdown the UI shows. */
  private peak = 0;
  private maxDd = 0;
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
  /** A scanner's own exit override, supplied by the app so the engine needs no config knowledge. */
  scannerExit?: (scannerId: string) => ExitOverride | undefined;

  /** The position timeframe's trend, +1 or −1, for the trend exit (set by the composition root). */
  trendFor?: (symbol: string, tf: string) => 1 | -1 | undefined;

  constructor(db: Db, cfgRef: () => AppConfig, opts: { book?: number } = {}) {
    super();
    this.db = db; this.cfgRef = cfgRef;
    this.book = opts.book ?? 0;
    this.kvPrefix = this.book === 0 ? 'paper' : `book${this.book}`;
    this.loadPeak();
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

  /** The database this book writes to (the executor's order ledger lives beside it). */
  get store(): Db { return this.db; }
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

  /**
   * The live account compounds; a shadow book does not.
   *
   * Book 2 is evidence, not money: every pair must be sized against the same purse for its R to mean
   * the same thing on day one and day thirty. Left to compound, one lucky trade inflates the next
   * hundred — on the VM a single +1.1M win carried the purse to roughly 20M and later trades were
   * sized in hundreds of millions of contracts.
   */
  equity(): number {
    if (this.book !== 0) return this.initialEquity;
    const eq = this.initialEquity + this.realizedPnl() + this.unrealizedPnl();
    this.observeEquity(eq);
    return eq;
  }

  // ---- peak and drawdown (live account only) ----

  private loadPeak() {
    if (this.book !== 0) return;
    const p = this.db.kvGet<number>('paper.peakEquity');
    if (p && p > 0) { this.peak = p; this.maxDd = this.db.kvGet<number>('paper.maxDrawdownPct') ?? 0; return; }
    // first run on an existing account: rebuild both from the equity path recorded since the reset
    let peak = this.initialEquity, dd = 0;
    for (const r of this.db.all<{ equity: number }>('SELECT equity FROM equity WHERE scanner_id IS NULL ORDER BY at')) {
      if (r.equity > peak) peak = r.equity; else if (peak > 0) dd = Math.max(dd, (peak - r.equity) / peak * 100);
    }
    this.peak = peak; this.maxDd = dd;
    this.db.kvSet('paper.peakEquity', peak); this.db.kvSet('paper.maxDrawdownPct', dd);
  }

  private observeEquity(eq: number) {
    if (!Number.isFinite(eq)) return;
    if (eq > this.peak) { this.peak = eq; this.db.kvSet('paper.peakEquity', eq); return; }
    const dd = this.peak > 0 ? (this.peak - eq) / this.peak * 100 : 0;
    if (dd > this.maxDd + 0.01) { this.maxDd = dd; this.db.kvSet('paper.maxDrawdownPct', dd); }
  }

  /** Highest equity since the last reset (a shadow book never moves). */
  peakEquity(): number { return this.book === 0 ? this.peak : this.initialEquity; }
  /** Drawdown right now from that peak, open positions included. */
  drawdownPct(): number { if (this.book !== 0) return 0; const eq = this.equity(); return this.peak > 0 ? Math.max(0, (this.peak - eq) / this.peak * 100) : 0; }
  /** Deepest drawdown since the reset, on the same path. */
  maxDrawdownPct(): number { return Math.max(this.maxDd, this.drawdownPct()); }

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
    // the market's and the scanner's own rules, so a stop width they ask for is used at entry and
    // then carried on the position for the rest of the trade (decision 43)
    const cfg = exitConfigFor(this.paper, ctx.symbol, this.scannerExit?.(ctx.scannerId));
    // A signal acted on long after its bar closed could not have been taken at these prices
    // (restarts and deep queues used to replay bar-old signals straight into the book).
    const maxAge = cfg.maxSignalAgeSec ?? 0;
    if (maxAge > 0) {
      const age = PaperEngine.signalAgeSec(ev, ctx.tf, ctx.at);
      if (age > maxAge) return { action: 'rejected', reason: `stale signal: bar closed ${age.toFixed(0)}s ago (max ${maxAge}s)` };
    }
    const existing = this.findOpen(ctx.scannerId, ctx.symbol, ctx.tf);
    // Reversal policy (decision 77): the replacement must pass every admission check — price, levels, fees,
    // risk gate, size, exposure — with the existing position counted as gone; only then is the existing
    // position closed. A replacement that cannot be admitted leaves the position as it was.
    let replacing: Position | undefined;
    if (existing) {
      if (existing.side === ev.side) return { action: 'ignored', reason: 'already in position' };
      if (!cfg.allowReversal) return { action: 'ignored', reason: 'opposite signal while in position (reversal disabled)' };
      const markNow = this.marks.get(existing.symbol) ?? ctx.refPrice;
      if (!reversalAllowed(existing, markNow, cfg)) {
        return { action: 'ignored', reason: `reversal held: position at ${openR(existing, markNow).toFixed(2)}R, below the ${cfg.reversalMinR}R needed to bank it` };
      }
      replacing = existing;
    }
    const refused = (reason: string): EntryDecision => ({ action: 'rejected', reason: replacing ? `reversal refused, position kept: ${reason}` : reason });
    let closed: Position | undefined;
    if (this.findPending(ctx.scannerId, ctx.symbol, ctx.tf)) return { action: 'ignored', reason: 'entry already pending' };
    if (this.open.size + this.pending.size - (replacing ? 1 : 0) >= cfg.maxOpenPositions) return refused(`max open positions (${cfg.maxOpenPositions})`);
    // A market entry pays the spread: buy at the ask, sell at the bid when a fresh quote exists.
    // The script's own price is only a reference and is often minutes old by the time we act.
    const reference = ev.price && ev.price > 0 ? ev.price : ctx.refPrice;
    const quoted = this.entryPrice(ctx.symbol, ev.side === 'long' ? 'buy' : 'sell', reference, cfg, ctx.at);
    if ('reject' in quoted) return refused(`unpriceable: ${quoted.reject}`);
    const price = quoted.price;
    const entryContext: FillContext = { ref: reference, source: quoted.quoted ? 'quote' : 'slippage' };
    const levels = resolveLevels({ side: ev.side!, price, sl: ev.sl, tp: ev.tp, atr: ctx.atr }, cfg, ctx.market.tickSize);
    if ('error' in levels) return refused(levels.error);
    const feeErr = checkRiskVsFees(price, levels.sl, cfg, ctx.symbol);
    if (feeErr) return refused(feeErr);
    // portfolio risk layer: kill switches, position caps, cooldowns, regime filter, drawdown scaling
    let leverageMult = 1;
    if (this.risk) {
      const g = this.risk.gate({ scannerId: ctx.scannerId, symbol: ctx.symbol, tf: ctx.tf, side: ev.side!, price, sl: levels.sl, atr: ctx.atr, at: ctx.at, replacing: replacing?.id });
      if (g.reject) return refused(`risk ${g.reject}`);
      leverageMult = g.leverageMult;
    }
    const size = this.size(price, levels.sl, ctx.market, ev.score ?? ctx.scoreOverride, leverageMult, replacing?.id);
    if (size.qty < 1) return refused(size.reason ?? 'size');
    if (this.risk) {
      const x = this.risk.exposureCheck({ symbol: ctx.symbol, side: ev.side!, tf: ctx.tf, notional: size.qty * ctx.market.contractValue * price, replacing: replacing?.id });
      if (x) return refused(`risk ${x}`);
    }
    if (replacing) {
      const ref = ev.price && ev.price > 0 ? ev.price : ctx.refPrice;
      const exitQuote = this.marketPrice(replacing.symbol, replacing.side === 'long' ? 'sell' : 'buy', ref, cfg, ctx.at);
      if (!this.applyFills(replacing, [fillExit(replacing, exitQuote.price, replacing.qtyOpen, 'reversal', ctx.at, cfg, exitQuote.source === 'quote' ? 'quoted' : true)], { ref, source: exitQuote.source })) return refused('the position to be replaced could not be closed (write failed)');
      closed = replacing;
    }
    if (this.tapeMode || (cfg.latencyMs ?? 0) > 0) {
      // latency model (decision 75: every mode): the order reaches the book latencyMs after the signal and fills at the
      // first price after that — a tape print, or in candles mode the next 1m candle update, or the mark once the feed is quiet
      const id = this.nextId();
      const pe: PendingEntry = { id, scannerId: ctx.scannerId, scannerName: ctx.scannerName, symbol: ctx.symbol, tf: ctx.tf, side: ev.side!, signalPrice: price, levels, market: ctx.market, at: ctx.at, dueAt: ctx.at + (cfg.latencyMs ?? 0), signalId: ctx.signalId, features: ctx.features, mlProb: ctx.mlProb ?? null, score: ev.score ?? ctx.scoreOverride, leverageMult };
      this.pending.set(id, pe);
      this.db.run("UPDATE positions SET scanner_id=?, scanner_name=?, symbol=?, tf=?, side=?, entry_price=?, entry_at=?, signal_id=?, fills=? WHERE id=?", pe.scannerId, pe.scannerName, pe.symbol, pe.tf, pe.side, price, pe.at, pe.signalId, JSON.stringify({ pending: { dueAt: pe.dueAt, levels } }), id);
      log.info(`PENDING ${pe.side.toUpperCase()} ${pe.symbol} @~${price.toFixed(2)} fills at first price after +${cfg.latencyMs ?? 0}ms [${ctx.scannerId}]`);
      return { action: 'pending', reason: this.tapeMode ? 'awaiting tape fill' : 'awaiting fill after the latency window', pendingId: id, closed };
    }
    const pos = this.openAt(this.nextId(), { scannerId: ctx.scannerId, scannerName: ctx.scannerName, symbol: ctx.symbol, tf: ctx.tf, side: ev.side!, qty: size.qty, contractValue: ctx.market.contractValue, entryPrice: price, at: ctx.at, sl: levels.sl, tp: levels.tp, riskAmount: size.riskAmount, levelsSource: levels.source, signalId: ctx.signalId, leverage: size.leverage, marginLeverage: size.marginLeverage, features: ctx.features, mlProb: ctx.mlProb ?? null, quoted: quoted.quoted, scannerTag: ctx.scannerId }, cfg, entryContext);
    return { action: closed ? 'reversed' : 'opened', position: pos, closed };
  }

  private size(price: number, sl: number, market: MarketInfo, score: number | undefined, leverageMult: number, replacing?: number) {
    const cfg = this.scaledCfg(leverageMult);
    const others = [...this.open.values()].filter(p => p.id !== replacing);
    const openNotional = others.reduce((a, p) => a + notionalOf(p), 0);
    const reservedMargin = others.reduce((a, p) => a + notionalOf(p) / (p.marginLeverage || p.leverage || cfg.maxLeverage), 0);
    const wallet = this.book === 0 ? this.initialEquity + this.realizedPnl() : this.initialEquity;
    return sizeContracts(price, sl, { equity: this.equity(), availableMargin: wallet - reservedMargin, contractValue: market.contractValue, tickSize: market.tickSize, cfg }, openNotional, score);
  }

  private openAt(id: number, p: Omit<Parameters<typeof openPosition>[0], 'id' | 'cfg' | 'bt' | 'lastPriceBar'> & { scannerTag: string }, cfg: PaperConfig, context: FillContext): Position {
    // `quoted` entries already crossed the real spread; openPosition adds depth impact only
    const pos = openPosition({ ...p, id, cfg, bt: false, lastPriceBar: this.priceBars.get(p.symbol) });
    // the position, its entry fill and the signal's outcome commit together; events go out only after the commit
    // (decision 77: a crash between the writes used to leave a position without its order, or a signal pointing nowhere)
    this.db.transaction(() => {
      this.persist(pos);
      this.persistFill(pos, pos.fills[0], context);
      if (pos.signalId) this.db.updateSignalAction(pos.signalId, 'opened', pos.id);
    });
    this.open.set(id, pos);
    this.emit('order', orderOf(pos, pos.fills[0]));   // the fill precedes the open position (executor: entry before bracket)
    this.emit('position', { type: 'opened', position: pos });
    this.recordEquity(true);
    log.info(`${this.book ? 'INCUBATOR ' : ''}OPEN ${pos.side.toUpperCase()} ${pos.symbol} x${pos.qty} @ ${pos.entryPrice.toFixed(2)} ${pos.leverage.toFixed(1)}x sl ${pos.sl} tp ${pos.tp.join('/')} liq ${pos.liqPrice?.toFixed(1) ?? '-'} [${p.scannerTag}]`);
    return pos;
  }

  /** Fill a pending entry at `price` (first print after the latency window, or the 1m close when the tape is silent). */
  private fillPending(pe: PendingEntry, priceIn: number, at: number, source: 'tape' | 'candle', receivedAt = Date.now()): Position | null {
    let price = priceIn;
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
    // a candle-sourced fill is a market order against the book at that moment: it pays the spread through the
    // live quote when one is fresh, otherwise the slippage assumption (the same pricing the immediate fill used)
    let quoted = false;
    const context: FillContext = { ref: priceIn, source: 'slippage' };
    if (source === 'candle') {
      const q = this.entryPrice(pe.symbol, pe.side === 'long' ? 'buy' : 'sell', price, cfg, receivedAt);
      if ('reject' in q) return cancel(`unpriceable: ${q.reject}`);
      context.source = q.quoted ? 'quote' : 'slippage';
      price = q.price; quoted = q.quoted;
    }
    // the signal's levels are absolute; the fill price must still sit on the right side of them
    const levels = resolveLevels({ side: pe.side, price, sl: pe.levels.sl, tp: pe.levels.tp }, cfg, pe.market.tickSize);
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
    const pos = this.openAt(pe.id, { scannerId: pe.scannerId, quoted, scannerName: pe.scannerName, symbol: pe.symbol, tf: pe.tf, side: pe.side, qty: size.qty, contractValue: pe.market.contractValue, entryPrice: price, at, sl: levels.sl, tp: levels.tp, riskAmount: size.riskAmount, levelsSource: pe.levels.source, signalId: pe.signalId, leverage: size.leverage, marginLeverage: size.marginLeverage, features: pe.features, mlProb: pe.mlProb, scannerTag: `${pe.scannerId} ${source} +${at - pe.at}ms` }, cfg, context);
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
    for (const pe of [...this.pending.values()]) {
      if (now > pe.dueAt + PENDING_EXPIRY_MS) { this.cancelPending(pe.id, `no fill within ${PENDING_EXPIRY_MS / 1000}s of the latency window`); continue; }
      // candles mode: the window has closed and no candle update has come for the symbol — fill at the mark
      if (!this.tapeMode && now >= pe.dueAt + QUIET_FILL_MS) { const m = this.marks.get(pe.symbol); if (m && m > 0) this.fillPending(pe, m, now, 'candle', now); }
    }
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
      const fills = applyTrade(pos, { time, price, qty }, exitConfigFor(this.paper, pos.symbol, this.scannerExit?.(pos.scannerId)), mark, atr);
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
    const fills = applyScriptExit(pos, exitType, price, at, exitConfigFor(this.paper, pos.symbol, this.scannerExit?.(pos.scannerId)), exitMode, fallback);
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
    if (!historical) {
      // tape mode: the candle is the fallback while the tape is silent; candles mode: the candle update is the price
      for (const pe of [...this.pending.values()]) if (pe.symbol === symbol && observedAt >= pe.dueAt) this.fillPending(pe, bar.close, observedAt, 'candle', observedAt);
    }
    this.housekeeping(observedAt);
    for (const pos of [...this.open.values()]) {
      if (pos.symbol !== symbol) continue;
      const previous = pos.lastPriceBar;
      const pcfg = exitConfigFor(this.paper, pos.symbol, this.scannerExit?.(pos.scannerId));
      const slBefore = pos.sl;
      const fills = applyLiveBar(pos, bar, pcfg, eventAt, (pcfg.trailAtrMult ?? 0) > 0 ? this.atrFor?.(pos.symbol, pos.tf) : undefined);
      if (fills.length) this.applyFills(pos, fills);
      for (const f of fills) this.recordPath(pos, f.price, eventAt, f.reason, `${f.qty} at ${f.price}`);
      if (pos.sl !== slBefore && pos.status === 'open') this.recordPath(pos, bar.close, eventAt, 'stop moved', `${slBefore} → ${pos.sl}`);
      if (pos.status === 'open') this.recordPath(pos, bar.close, eventAt);
      if (pos.status === 'open' && !historical) {
        const sf = earlyStallExit(pos, bar.close, eventAt, pcfg);
        if (sf) this.applyFills(pos, [sf]);
      }
      if (pos.status === 'open' && this.paper.trendExit?.enabled && !historical) {
        const f = trendExit(pos, this.trendFor?.(pos.symbol, pos.tf), bar.close, eventAt, this.paper);
        if (f) this.applyFills(pos, [f]);
      }
      else if (pos.lastPriceBar !== previous) this.persist(pos);
    }
    this.recordEquity(false);
  }

  // ---- exchange-authoritative fills (execution, decision 46) ----
  // The paper book decides intent; when an executor mirrors it, what the exchange actually filled is
  // what the book records. These restate fills the simulator already booked, or book fills the
  // exchange made on its own (a resting stop that triggered on mark price).

  /** Restate the entry from the exchange fill. A fill of zero contracts voids the position: the exchange never held it. */
  adoptEntryFill(id: number, f: { price: number | null; qty: number; fee: number | null; at?: number }): Position | undefined {
    const pos = this.open.get(id);
    if (!pos) return undefined;
    if (!(f.qty > 0)) { this.voidPosition(id, 'exchange-unfilled'); return undefined; }
    const entry = pos.fills[0];
    if (pos.qtyOpen !== pos.qty) { log.error(`adoptEntryFill #${id}: position already partly exited; entry not restated`); return pos; }
    const price = f.price ?? entry.price;
    const cfg = exitConfigFor(this.paper, pos.symbol, this.scannerExit?.(pos.scannerId));
    const fee = f.fee ?? (f.qty === pos.qty ? entry.fee : entry.fee * f.qty / pos.qty);
    pos.entryPrice = price; pos.qty = f.qty; pos.qtyOpen = f.qty;
    pos.legs = splitLegs(f.qty, cfg.tpSplit, pos.tp.length);
    pos.fees += fee - entry.fee;
    Object.assign(entry, { price, qty: f.qty, fee, ...(f.at ? { at: f.at } : {}) });
    if (pos.sl !== null) pos.riskAmount = Math.abs(price - pos.sl) * f.qty * pos.contractValue;
    pos.liqPrice = liquidationPrice(pos.side, price, pos.marginLeverage ?? pos.leverage ?? 0, cfg);
    this.db.run("UPDATE orders SET price=?, qty=?, fee=?, price_source='exchange' WHERE id=(SELECT id FROM orders WHERE position_id=? AND reason='entry' ORDER BY id ASC LIMIT 1)", price, f.qty, fee, pos.id);
    this.persist(pos);
    this.emit('position', { type: 'updated', position: pos });
    this.recordEquity(true);
    log.info(`ENTRY RESTATED #${pos.id} ${pos.symbol}: ${f.qty} @ ${price} fee ${fee.toFixed(4)} (exchange)`);
    return pos;
  }

  /** Remove a position the exchange never opened: nothing was risked, so nothing is recorded as a trade. */
  voidPosition(id: number, reason: string): boolean {
    const pos = this.open.get(id);
    if (!pos) return false;
    this.open.delete(id);
    this.db.transaction(() => {
      this.db.run('DELETE FROM position_path WHERE position_id=?', id);
      this.db.run('DELETE FROM orders WHERE position_id=?', id);
      this.db.run('DELETE FROM positions WHERE id=?', id);
      if (pos.signalId) this.db.updateSignalAction(pos.signalId, `rejected:${reason}`, null);
    });
    this.lastPathAt.delete(id); this.peakSeen.delete(id);
    this.emit('position', { type: 'voided', position: pos, reason });
    this.recordEquity(true);
    log.warn(`VOID #${id} ${pos.symbol} ${pos.side} x${pos.qty}: ${reason}`);
    return true;
  }

  /** Book an exit the exchange made that the simulator has not seen (its resting stop or target filled). */
  adoptExitFill(id: number, f: { price: number; qty: number; fee: number | null; reason: string; at: number }): Position | undefined {
    const pos = this.open.get(id);
    if (!pos || !(f.qty > 0)) return undefined;
    const cfg = exitConfigFor(this.paper, pos.symbol, this.scannerExit?.(pos.scannerId));
    const leg = Number(f.reason.match(/^tp(\d)$/)?.[1] ?? 0);
    if (leg > 0 && pos.tpHit[leg - 1] !== undefined) pos.tpHit[leg - 1] = true;
    const fill = fillExit(pos, f.price, f.qty, f.reason, f.at, cfg, false);
    if (f.fee !== null) { pos.fees += f.fee - fill.fee; fill.fee = f.fee; }
    this.applyFills(pos, [fill], { source: 'exchange' });
    this.recordPath(pos, f.price, f.at, f.reason, `${f.qty} at ${f.price} (exchange)`);
    log.info(`EXIT ADOPTED #${pos.id} ${pos.symbol} ${f.reason} ${f.qty} @ ${f.price} (exchange)`);
    return pos;
  }

  /** Restate the price and fee of a fill the simulator already booked (its last fill with this reason) from the exchange's. */
  restateFill(id: number, reason: string, f: { price: number | null; fee: number | null }): Position | undefined {
    const pos = this.open.get(id) ?? this.position(id);
    if (!pos) return undefined;
    const fill = [...pos.fills].reverse().find(x => x.reason === reason);
    if (!fill) return pos;
    const price = f.price ?? fill.price, fee = f.fee ?? fill.fee;
    if (price === fill.price && fee === fill.fee) return pos;
    const pnl = reason === 'entry' ? 0 : pnlOf(pos, price, fill.qty);
    pos.realizedPnl += pnl - fill.pnl; pos.fees += fee - fill.fee;
    Object.assign(fill, { price, fee, pnl });
    if (pos.status === 'closed' && pos.fills.at(-1) === fill) pos.exitPrice = price;
    this.db.run("UPDATE orders SET price=?, fee=?, price_source='exchange' WHERE id=(SELECT id FROM orders WHERE position_id=? AND reason=? ORDER BY id DESC LIMIT 1)", price, fee, pos.id, reason);
    this.persist(pos);
    if (pos.status === 'closed') { this.closedCache = null; this.emit('stats', this.stats()); }
    else this.emit('position', { type: 'updated', position: pos });
    this.recordEquity(true);
    log.info(`FILL RESTATED #${pos.id} ${pos.symbol} ${reason}: ${fill.qty} @ ${price} fee ${fee.toFixed(4)} (exchange)`);
    return pos;
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

  closeAll(reason = 'manual', at = Date.now()): number {
    let n = 0;
    for (const id of [...this.pending.keys()]) this.cancelPending(id, reason);
    for (const id of [...this.open.keys()]) if (this.closeManual(id, reason, at)) n++;
    return n;
  }

  /**
   * Start the book again at its initial equity. The record is archived, not deleted: positions and
   * orders move to book `-(book + 1)` where every live query ignores them and the forensics keep
   * them (a reset used to erase the trades that prompted it).
   */
  reset(): void {
    const archive = -(this.book + 1);
    this.db.transaction(() => {
      this.db.run(`UPDATE positions SET bt=? WHERE bt=${this.book}`, archive);
      this.db.run(`UPDATE orders SET bt=? WHERE bt=${this.book}`, archive);
      if (this.book === 0) {
        this.db.run('DELETE FROM equity');
        this.db.run("UPDATE signals SET action='reset', position_id=NULL WHERE position_id IS NOT NULL");
      }
    });
    this.open.clear(); this.pending.clear(); this.closedCache = null;
    this.db.kvSet(`${this.kvPrefix}.initialEquity`, this.paper.initialEquity);
    this.db.kvSet(`${this.kvPrefix}.resetAt`, Date.now());
    this.peak = this.paper.initialEquity; this.maxDd = 0;
    this.db.kvSet('paper.peakEquity', this.peak); this.db.kvSet('paper.maxDrawdownPct', 0);
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
    // closed = the journal (what the Trades page sums); open = every open position's banked legs, fees and mark.
    // equity = initial + closedPnl + openPnl, so no figure on the Overview can disagree with another.
    const open = [...this.open.values()];
    const closedPnl = closed.reduce((a, p) => a + p.realizedPnl - p.fees, 0);
    const openPnl = open.reduce((a, p) => a + p.realizedPnl - p.fees + unrealized(p, this.marks.get(p.symbol) ?? p.entryPrice), 0);
    return {
      equity: this.equity(), initialEquity: initial, closedPnl, closedFees: g.fees, openPnl, openFees: open.reduce((a, p) => a + p.fees, 0),
      peakEquity: this.peakEquity(), drawdownPct: this.drawdownPct(), maxDrawdownPct: this.maxDrawdownPct(),
      openPositions: this.open.size, pendingEntries: this.pending.size, trades: g.trades, wins: g.wins, losses: g.losses, winRatePct: g.winRatePct, profitFactor: fin(g.profitFactor),
      avgR: g.avgR, expectancy: g.expectancy, byScanner: mapFin(byScanner), bySymbol,
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

  /**
   * The path a trade takes, from entry to exit.
   *
   * `worstR` is the worst result *observed while sampling*, so a trade that runs up immediately and
   * never returns has a positive worst — it is the drawdown seen, not an assumption about the ticks
   * between samples.
   *
   * A closed trade in the database says where it ended but nothing about how it got there: the row
   * cannot answer "was it in profit before the stop", which is the first question anyone asks of a
   * loss. One row per sample or level event fixes that, and the peak and worst excursion are kept on
   * the position itself so the common question needs no replay at all.
   */
  private lastPathAt = new Map<number, number>();
  private peakSeen = new Map<number, number>();
  private readonly pathEveryMs = 60_000;

  private recordPath(p: Position, price: number, at: number, event?: string, note?: string): void {
    if (!(p.riskAmount > 0) || !Number.isFinite(price)) return;
    const r = openR(p, price);
    let moved = false;
    // the trail raises peakR itself from intra-bar highs, so the timestamp is taken from whenever the
    // magnitude last increased — the bar on which the peak was observed, not a separate estimate
    p.peakR = Math.max(p.peakR ?? -Infinity, r);
    if ((p.peakR ?? -Infinity) > (this.peakSeen.get(p.id) ?? -Infinity)) { this.peakSeen.set(p.id, p.peakR!); p.peakAt = at; moved = true; }
    if (r < (p.worstR ?? Infinity)) { p.worstR = r; p.worstAt = at; moved = true; }
    // written straight away: a fill persists the position before this runs, and a closed trade is
    // never persisted again, so waiting for the next persist would lose the peak of the last bar
    if (moved) this.db.run('UPDATE positions SET peak_r=?, peak_at=?, worst_r=?, worst_at=? WHERE id=?', p.peakR ?? null, p.peakAt ?? null, p.worstR ?? null, p.worstAt ?? null, p.id);
    const last = this.lastPathAt.get(p.id) ?? 0;
    if (!event && at - last < this.pathEveryMs) return;
    this.lastPathAt.set(p.id, at);
    this.db.run('INSERT INTO position_path(position_id, at, price, r, sl, event, note) VALUES (?,?,?,?,?,?,?)',
      p.id, at, price, r, p.sl ?? null, event ?? null, note ?? null);
    if (p.status !== 'open') { this.lastPathAt.delete(p.id); this.peakSeen.delete(p.id); }
  }

  private persist(p: Position) {
    this.db.run(
      `UPDATE positions SET status=?, scanner_id=?, scanner_name=?, symbol=?, tf=?, side=?, qty=?, qty_open=?, contract_value=?, entry_price=?, entry_at=?, sl=?, sl_original=?, tp=?, tp_hit=?, break_even=?,
       realized_pnl=?, fees=?, risk_amount=?, levels_source=?, exit_at=?, exit_price=?, exit_reason=?, signal_id=?, fills=?, bt=? WHERE id=?`,
      p.status, p.scannerId, p.scannerName, p.symbol, p.tf, p.side, p.qty, p.qtyOpen, p.contractValue, p.entryPrice, p.entryAt, p.sl, p.slOriginal, JSON.stringify(p.tp), JSON.stringify(p.tpHit), p.breakEven ? 1 : 0,
      p.realizedPnl, p.fees, p.riskAmount, p.levelsSource, p.exitAt, p.exitPrice, p.exitReason, p.signalId, JSON.stringify({ fills: p.fills, legs: p.legs, leverage: p.leverage, marginLeverage: p.marginLeverage, liqPrice: p.liqPrice, features: p.features, mlProb: p.mlProb, lastPriceBar: p.lastPriceBar, peakR: p.peakR }), this.book, p.id,
    );
    this.db.run('UPDATE positions SET peak_r=?, peak_at=?, worst_r=?, worst_at=? WHERE id=?', p.peakR ?? null, p.peakAt ?? null, p.worstR ?? null, p.worstAt ?? null, p.id);
  }

  private persistFill(p: Position, f: Fill, ctx: FillContext = {}) {
    const side = fillSide(p, f);
    // Funding is a cash adjustment, not a market execution with a quote/spread.
    const q = f.reason === 'funding' ? undefined : this.quotes?.markState?.(p.symbol);
    this.db.run(
      'INSERT INTO orders(at, position_id, scanner_id, symbol, side, qty, price, fee, reason, bt, ref_price, bid, ask, quote_at, price_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      f.at, p.id, p.scannerId, p.symbol, side, f.qty, f.price, f.fee, f.reason, this.book,
      ctx.ref ?? null, q?.bestBid ?? null, q?.bestAsk ?? null, q?.quoteAt ?? null, ctx.source ?? null,
    );
  }

  private applyFills(pos: Position, fills: Fill[], context: FillContext = {}): boolean {
    // every fill and the position's new state commit together; the order events follow the commit
    try {
      this.db.transaction(() => { for (const f of fills) this.persistFill(pos, f, context); this.persist(pos); });
    } catch (e: any) {
      // The write rolled back, so the database still holds the position as it was. The object the callers
      // mutated must agree with it (decision 85): restore every field from the row, keep the object identity,
      // and let the next price re-trigger the exit. Nothing is emitted for a fill that did not commit.
      const row = this.db.get<any>(`SELECT * FROM positions WHERE id=? AND bt=${this.book}`, pos.id);
      if (row) {
        const fresh = rowToPosition(row);
        for (const k of Object.keys(pos)) delete (pos as any)[k];
        Object.assign(pos, fresh);
        if (pos.status === 'open') this.open.set(pos.id, pos); else this.open.delete(pos.id);
      }
      log.error(`fills for #${pos.id} ${pos.symbol} were not persisted and were undone in memory: ${e?.message ?? e}`);
      return false;
    }
    for (const f of fills) this.emit('order', orderOf(pos, f));
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
    return true;
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
    return this.db.all<any>(`SELECT id, at, position_id positionId, scanner_id scannerId, symbol, side, qty, price, fee, reason, price_source priceSource FROM orders WHERE bt=${this.book} ORDER BY at DESC, id DESC LIMIT ?`, limit);
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
    peakR: p.peakR ?? null, worstR: p.worstR ?? null, peakAt: p.peakAt ?? null, riskAmount: p.riskAmount,
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
