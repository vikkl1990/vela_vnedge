import { EventEmitter } from 'node:events';
import type { Db } from '../db.ts';
import type { AppConfig, ExitMode, PaperConfig } from '../config.ts';
import type { Side, ExitType, ScanEvent } from '../scanners/extractor.ts';
import { logger } from '../log.ts';
import {
  type Position, type Fill, type PriceBar, type LevelResult, applyLiveBar, applyScriptExit, applyTrade, applyMark, applyFunding, checkRiskVsFees, computeStats, fillExit, openPosition, resolveLevels, sizeContracts, unrealized, notionalOf, rMultiple, type TradeStats,
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

  constructor(db: Db, cfgRef: () => AppConfig) {
    super();
    this.db = db; this.cfgRef = cfgRef;
    for (const row of db.all<any>("SELECT * FROM positions WHERE status='open' AND bt=0")) {
      const p = rowToPosition(row); this.open.set(p.id, p);
    }
    // pending tape entries do not survive a restart (their signal is seconds old at most)
    for (const row of db.all<any>("SELECT id, signal_id FROM positions WHERE status='pending' AND bt=0")) {
      db.run('DELETE FROM positions WHERE id=?', row.id);
      if (row.signal_id) db.updateSignalAction(row.signal_id, 'rejected:pending entry dropped on restart', null);
    }
    log.info(`loaded ${this.open.size} open paper positions`);
  }

  private get paper(): PaperConfig { return this.cfgRef().paper; }
  private get tapeMode(): boolean { return (this.paper.fillSource ?? 'candles') === 'tape'; }

  // ---- account state ----

  get initialEquity(): number { return this.db.kvGet<number>('paper.initialEquity') ?? this.paper.initialEquity; }

  closedPositions(): Position[] {
    if (!this.closedCache) this.closedCache = this.db.all<any>("SELECT * FROM positions WHERE status='closed' AND bt=0 ORDER BY exit_at ASC").map(rowToPosition);
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

  onEntry(ev: ScanEvent, ctx: { scannerId: string; scannerName: string; symbol: string; tf: string; market: MarketInfo; atr?: number; refPrice: number; at: number; signalId: number | null; exitMode: ExitMode; features?: Record<string, number>; mlProb?: number | null; scoreOverride?: number }): EntryDecision {
    const cfg = this.paper;
    const existing = this.findOpen(ctx.scannerId, ctx.symbol, ctx.tf);
    let closed: Position | undefined;
    if (existing) {
      if (existing.side === ev.side) return { action: 'ignored', reason: 'already in position' };
      if (!cfg.allowReversal) return { action: 'ignored', reason: 'opposite signal while in position (reversal disabled)' };
      const px = ev.price && ev.price > 0 ? ev.price : ctx.refPrice;
      this.applyFills(existing, [fillExit(existing, px, existing.qtyOpen, 'reversal', ctx.at, cfg, true)]);
      closed = existing;
    }
    if (this.findPending(ctx.scannerId, ctx.symbol, ctx.tf)) return { action: 'ignored', reason: 'entry already pending', closed };
    if (this.open.size + this.pending.size >= cfg.maxOpenPositions) return { action: 'rejected', reason: `max open positions (${cfg.maxOpenPositions})`, closed };
    const price = ev.price && ev.price > 0 ? ev.price : ctx.refPrice;
    const levels = resolveLevels({ side: ev.side!, price, sl: ev.sl, tp: ev.tp, atr: ctx.atr }, cfg, ctx.market.tickSize);
    if ('error' in levels) return { action: 'rejected', reason: levels.error, closed };
    const feeErr = checkRiskVsFees(price, levels.sl, cfg);
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
    const pos = this.openAt(this.nextId(), { scannerId: ctx.scannerId, scannerName: ctx.scannerName, symbol: ctx.symbol, tf: ctx.tf, side: ev.side!, qty: size.qty, contractValue: ctx.market.contractValue, entryPrice: price, at: ctx.at, sl: levels.sl, tp: levels.tp, riskAmount: size.riskAmount, levelsSource: levels.source, signalId: ctx.signalId, leverage: size.leverage, marginLeverage: size.marginLeverage, features: ctx.features, mlProb: ctx.mlProb ?? null, scannerTag: ctx.scannerId }, cfg);
    return { action: closed ? 'reversed' : 'opened', position: pos, closed };
  }

  private size(price: number, sl: number, market: MarketInfo, score: number | undefined, leverageMult: number) {
    const cfg = this.scaledCfg(leverageMult);
    const openNotional = [...this.open.values()].reduce((a, p) => a + notionalOf(p), 0);
    const reservedMargin = [...this.open.values()].reduce((a, p) => a + notionalOf(p) / (p.marginLeverage || p.leverage || cfg.maxLeverage), 0);
    return sizeContracts(price, sl, { equity: this.equity(), availableMargin: this.initialEquity + this.realizedPnl() - reservedMargin, contractValue: market.contractValue, tickSize: market.tickSize, cfg }, openNotional, score);
  }

  private openAt(id: number, p: Omit<Parameters<typeof openPosition>[0], 'id' | 'cfg' | 'bt' | 'lastPriceBar'> & { scannerTag: string }, cfg: PaperConfig): Position {
    const pos = openPosition({ ...p, id, cfg, bt: false, lastPriceBar: this.priceBars.get(p.symbol) });
    this.open.set(id, pos);
    this.persist(pos);
    this.persistFill(pos, pos.fills[0]);
    this.emit('position', { type: 'opened', position: pos });
    this.emit('order', orderOf(pos, pos.fills[0]));
    this.recordEquity(true);
    log.info(`OPEN ${pos.side.toUpperCase()} ${pos.symbol} x${pos.qty} @ ${pos.entryPrice.toFixed(2)} ${pos.leverage.toFixed(1)}x sl ${pos.sl} tp ${pos.tp.join('/')} liq ${pos.liqPrice?.toFixed(1) ?? '-'} [${p.scannerTag}]`);
    return pos;
  }

  /** Fill a pending entry at `price` (first print after the latency window, or the 1m close when the tape is silent). */
  private fillPending(pe: PendingEntry, price: number, at: number, source: 'tape' | 'candle'): Position | null {
    this.pending.delete(pe.id);
    const cfg = this.paper;
    const cancel = (reason: string) => {
      this.db.run('DELETE FROM positions WHERE id=?', pe.id);
      if (pe.signalId) this.db.updateSignalAction(pe.signalId, `rejected:${reason}`, null);
      log.info(`PENDING ${pe.symbol} cancelled: ${reason} [${pe.scannerId}]`);
      this.emit('pending', { type: 'cancelled', id: pe.id, reason });
      return null;
    };
    // the signal's levels are absolute; the fill price must still sit on the right side of them
    const levels = resolveLevels({ side: pe.side, price, sl: pe.levels.sl, tp: pe.levels.tp }, cfg, pe.market.tickSize);
    if ('error' in levels) return cancel(`price moved past levels before fill (${levels.error})`);
    const feeErr = checkRiskVsFees(price, levels.sl, cfg);
    if (feeErr) return cancel(feeErr);
    if (this.open.size >= cfg.maxOpenPositions) return cancel(`max open positions (${cfg.maxOpenPositions})`);
    const size = this.size(price, levels.sl, pe.market, pe.score, pe.leverageMult);
    if (size.qty < 1) return cancel(size.reason ?? 'size');
    const pos = this.openAt(pe.id, { scannerId: pe.scannerId, scannerName: pe.scannerName, symbol: pe.symbol, tf: pe.tf, side: pe.side, qty: size.qty, contractValue: pe.market.contractValue, entryPrice: price, at, sl: levels.sl, tp: levels.tp, riskAmount: size.riskAmount, levelsSource: pe.levels.source, signalId: pe.signalId, leverage: size.leverage, marginLeverage: size.marginLeverage, features: pe.features, mlProb: pe.mlProb, scannerTag: `${pe.scannerId} ${source} +${at - pe.at}ms` }, cfg);
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
    for (const pe of [...this.pending.values()]) if (now > pe.dueAt + 60_000) this.cancelPending(pe.id, 'no fill within 60s of the latency window');
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
      const pos = this.fillPending(pe, price, time, 'tape');
      if (pos) filled.add(pos.id);
    }
    const mark = this.markPrices.get(symbol)?.price;
    for (const pos of [...this.open.values()]) {
      if (pos.symbol !== symbol || filled.has(pos.id)) continue;
      const fills = applyTrade(pos, { time, price, qty }, this.paper, mark);
      if (fills.length) this.applyFills(pos, fills);
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
  onBar(symbol: string, bar: PriceBar, observedAt = Date.now()): void {
    if (bar.time < (this.priceBars.get(symbol)?.time ?? -Infinity)) return;
    this.priceBars.set(symbol, { ...bar });
    this.housekeeping(observedAt);
    if (this.tapeMode && this.tapeActive(symbol, observedAt)) {
      for (const pos of this.open.values()) if (pos.symbol === symbol && pos.status === 'open' && observedAt >= pos.entryAt) pos.lastPriceBar = { ...bar };
      return;
    }
    this.marks.set(symbol, bar.close);
    if (this.tapeMode) {
      for (const pe of [...this.pending.values()]) if (pe.symbol === symbol && observedAt >= pe.dueAt) this.fillPending(pe, bar.close, observedAt, 'candle');
    }
    for (const pos of [...this.open.values()]) {
      if (pos.symbol !== symbol) continue;
      const previous = pos.lastPriceBar;
      const fills = applyLiveBar(pos, bar, this.paper, observedAt);
      if (fills.length) this.applyFills(pos, fills);
      else if (pos.lastPriceBar !== previous) this.persist(pos);
    }
    this.recordEquity(false);
  }

  closeManual(id: number, reason = 'manual'): Position | undefined {
    const pos = this.open.get(id);
    if (!pos) return undefined;
    const px = this.marks.get(pos.symbol) ?? pos.entryPrice;
    this.applyFills(pos, [fillExit(pos, px, pos.qtyOpen, reason, Date.now(), this.paper, true)]);
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
      this.db.run('DELETE FROM positions WHERE bt=0');
      this.db.run('DELETE FROM orders WHERE bt=0');
      this.db.run('DELETE FROM equity');
      this.db.run("UPDATE signals SET action='reset', position_id=NULL WHERE position_id IS NOT NULL");
    });
    this.open.clear(); this.pending.clear(); this.closedCache = null;
    this.db.kvSet('paper.initialEquity', this.paper.initialEquity);
    this.db.kvSet('paper.resetAt', Date.now());
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

  scannerStats(id: string) {
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
    const r = this.db.run("INSERT INTO positions(status, scanner_id, scanner_name, symbol, tf, side, qty, qty_open, contract_value, entry_price, entry_at, bt) VALUES ('pending','','','','','long',0,0,0,0,0,0)");
    return Number(r.lastInsertRowid);
  }

  private persist(p: Position) {
    this.db.run(
      `UPDATE positions SET status=?, scanner_id=?, scanner_name=?, symbol=?, tf=?, side=?, qty=?, qty_open=?, contract_value=?, entry_price=?, entry_at=?, sl=?, sl_original=?, tp=?, tp_hit=?, break_even=?,
       realized_pnl=?, fees=?, risk_amount=?, levels_source=?, exit_at=?, exit_price=?, exit_reason=?, signal_id=?, fills=?, bt=? WHERE id=?`,
      p.status, p.scannerId, p.scannerName, p.symbol, p.tf, p.side, p.qty, p.qtyOpen, p.contractValue, p.entryPrice, p.entryAt, p.sl, p.slOriginal, JSON.stringify(p.tp), JSON.stringify(p.tpHit), p.breakEven ? 1 : 0,
      p.realizedPnl, p.fees, p.riskAmount, p.levelsSource, p.exitAt, p.exitPrice, p.exitReason, p.signalId, JSON.stringify({ fills: p.fills, legs: p.legs, leverage: p.leverage, marginLeverage: p.marginLeverage, liqPrice: p.liqPrice, features: p.features, mlProb: p.mlProb, lastPriceBar: p.lastPriceBar }), p.bt ? 1 : 0, p.id,
    );
  }

  private persistFill(p: Position, f: Fill) {
    const side = fillSide(p, f);
    this.db.run('INSERT INTO orders(at, position_id, scanner_id, symbol, side, qty, price, fee, reason, bt) VALUES (?,?,?,?,?,?,?,?,?,0)', f.at, p.id, p.scannerId, p.symbol, side, f.qty, f.price, f.fee, f.reason);
  }

  private applyFills(pos: Position, fills: Fill[]) {
    for (const f of fills) { this.persistFill(pos, f); this.emit('order', orderOf(pos, f)); }
    this.persist(pos);
    if (pos.status === 'closed') {
      this.open.delete(pos.id);
      this.closedCache = null;
      this.emit('position', { type: 'closed', position: pos });
      this.emit('trade', tradeOf(pos));
      log.info(`CLOSE ${pos.side.toUpperCase()} ${pos.symbol} x${pos.qty} ${pos.exitReason} pnl ${(pos.realizedPnl - pos.fees).toFixed(2)} [${pos.scannerId}]`);
      this.recordEquity(true);
      this.emit('stats', this.stats());
    } else {
      this.emit('position', { type: 'updated', position: pos });
    }
  }

  private recordEquity(force: boolean) {
    const now = Date.now();
    const eq = this.equity();
    if (!force && (now - this.lastEquityPoint < 60_000 || Math.abs(eq - this.lastEquityValue) < 1e-9)) return;
    this.lastEquityPoint = now; this.lastEquityValue = eq;
    this.db.run('INSERT INTO equity(at, scanner_id, equity, realized, unrealized) VALUES (?,?,?,?,?)', now, null, eq, this.realizedPnl(), this.unrealizedPnl());
  }

  orders(limit = 200) {
    return this.db.all<any>('SELECT id, at, position_id positionId, scanner_id scannerId, symbol, side, qty, price, fee, reason FROM orders WHERE bt=0 ORDER BY at DESC, id DESC LIMIT ?', limit);
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
    legs: extra.legs ?? [], leverage: extra.leverage ?? 0, marginLeverage: extra.marginLeverage ?? extra.leverage ?? 0, liqPrice: extra.liqPrice ?? null, features: extra.features, mlProb: extra.mlProb ?? null, lastPriceBar: extra.lastPriceBar, breakEven: Boolean(r.break_even), realizedPnl: r.realized_pnl, fees: r.fees, riskAmount: r.risk_amount, levelsSource: r.levels_source ?? 'script',
    exitAt: r.exit_at, exitPrice: r.exit_price, exitReason: r.exit_reason, signalId: r.signal_id, fills: extra.fills ?? [], bt: Boolean(r.bt),
  };
}
function safe(s: string, d: any) { try { return JSON.parse(s); } catch { return d; } }

export function positionView(p: Position, mark?: number) {
  const m = mark ?? p.entryPrice;
  return {
    id: p.id, scannerId: p.scannerId, scannerName: p.scannerName, symbol: p.symbol, tf: p.tf, side: p.side, qty: p.qty, qtyOpen: p.qtyOpen, contractValue: p.contractValue,
    entryPrice: p.entryPrice, entryAt: p.entryAt, sl: p.sl, slOriginal: p.slOriginal, tp: p.tp, tpHit: p.tpHit, breakEven: p.breakEven, markPrice: m,
    unrealizedPnl: unrealized(p, m), realizedPnl: p.realizedPnl, fees: p.fees, riskAmount: p.riskAmount, rMultiple: p.riskAmount ? (p.realizedPnl - p.fees + unrealized(p, m)) / p.riskAmount : null,
    levelsSource: p.levelsSource, leverage: p.leverage, marginLeverage: p.marginLeverage, liqPrice: p.liqPrice, signalId: p.signalId, status: p.status,
    notional: p.qtyOpen * p.contractValue * m, notionalEntry: p.qty * p.contractValue * p.entryPrice, mlProb: p.mlProb ?? null,
    margin: (p.marginLeverage ?? p.leverage) > 0 ? notionalOf(p) / (p.marginLeverage ?? p.leverage) : null,
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
