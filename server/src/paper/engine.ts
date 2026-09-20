import { EventEmitter } from 'node:events';
import type { Db } from '../db.ts';
import type { AppConfig, ExitMode, PaperConfig } from '../config.ts';
import type { Side, ExitType, ScanEvent } from '../scanners/extractor.ts';
import { logger } from '../log.ts';
import {
  type Position, type Fill, applyBar, applyScriptExit, computeStats, fillExit, openPosition, resolveLevels, sizeContracts, unrealized, notionalOf, rMultiple, type TradeStats,
} from './logic.ts';

const log = logger.scoped('paper');

export interface MarketInfo { contractValue: number; tickSize: number }

export interface EntryDecision {
  action: 'opened' | 'ignored' | 'rejected' | 'reversed';
  reason?: string;
  position?: Position;
  closed?: Position;
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
  private lastEquityPoint = 0;
  private lastEquityValue = NaN;

  constructor(db: Db, cfgRef: () => AppConfig) {
    super();
    this.db = db; this.cfgRef = cfgRef;
    for (const row of db.all<any>("SELECT * FROM positions WHERE status='open' AND bt=0")) {
      const p = rowToPosition(row); this.open.set(p.id, p);
    }
    log.info(`loaded ${this.open.size} open paper positions`);
  }

  private get paper(): PaperConfig { return this.cfgRef().paper; }

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

  setMark(symbol: string, price: number) { this.marks.set(symbol, price); }
  mark(symbol: string): number | undefined { return this.marks.get(symbol); }

  // ---- signals → positions ----

  findOpen(scannerId: string, symbol: string, tf: string): Position | undefined {
    for (const p of this.open.values()) if (p.scannerId === scannerId && p.symbol === symbol && p.tf === tf) return p;
    return undefined;
  }

  onEntry(ev: ScanEvent, ctx: { scannerId: string; scannerName: string; symbol: string; tf: string; market: MarketInfo; atr?: number; refPrice: number; at: number; signalId: number | null; exitMode: ExitMode }): EntryDecision {
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
    if (this.open.size >= cfg.maxOpenPositions) return { action: 'rejected', reason: `max open positions (${cfg.maxOpenPositions})`, closed };
    const price = ev.price && ev.price > 0 ? ev.price : ctx.refPrice;
    const levels = resolveLevels({ side: ev.side!, price, sl: ev.sl, tp: ev.tp, atr: ctx.atr }, cfg, ctx.market.tickSize);
    if ('error' in levels) return { action: 'rejected', reason: levels.error, closed };
    const openNotional = [...this.open.values()].reduce((a, p) => a + notionalOf(p), 0);
    const size = sizeContracts(price, levels.sl, { equity: this.equity(), contractValue: ctx.market.contractValue, tickSize: ctx.market.tickSize, cfg }, openNotional, ev.score);
    if (size.qty < 1) return { action: 'rejected', reason: size.reason ?? 'size', closed };
    const id = this.nextId();
    const pos = openPosition({
      id, scannerId: ctx.scannerId, scannerName: ctx.scannerName, symbol: ctx.symbol, tf: ctx.tf, side: ev.side!, qty: size.qty, contractValue: ctx.market.contractValue,
      entryPrice: price, at: ctx.at, sl: levels.sl, tp: levels.tp, riskAmount: size.riskAmount, levelsSource: levels.source, signalId: ctx.signalId, cfg, bt: false, leverage: size.leverage,
    });
    this.open.set(id, pos);
    this.persist(pos);
    this.persistFill(pos, pos.fills[0]);
    this.emit('position', { type: 'opened', position: pos });
    this.emit('order', orderOf(pos, pos.fills[0]));
    this.recordEquity(true);
    log.info(`OPEN ${pos.side.toUpperCase()} ${pos.symbol} x${pos.qty} @ ${pos.entryPrice.toFixed(2)} ${pos.leverage.toFixed(1)}x sl ${pos.sl} tp ${pos.tp.join('/')} liq ${pos.liqPrice?.toFixed(1) ?? '-'} [${ctx.scannerId}]`);
    return { action: closed ? 'reversed' : 'opened', position: pos, closed };
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

  /** Feed a price bar (1m candle or tick) for a symbol; checks SL/TP on every open position of that symbol. */
  onBar(symbol: string, bar: { time: number; high: number; low: number; close: number }): void {
    this.marks.set(symbol, bar.close);
    for (const pos of [...this.open.values()]) {
      if (pos.symbol !== symbol) continue;
      if (bar.time < pos.entryAt) continue; // don't fill on the signal bar itself
      const fills = applyBar(pos, bar, this.paper);
      if (fills.length) this.applyFills(pos, fills);
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

  closeAll(reason = 'manual'): number {
    let n = 0;
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
    this.open.clear(); this.closedCache = null;
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
      openPositions: this.open.size, trades: g.trades, wins: g.wins, losses: g.losses, winRatePct: g.winRatePct, profitFactor: fin(g.profitFactor),
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
      p.realizedPnl, p.fees, p.riskAmount, p.levelsSource, p.exitAt, p.exitPrice, p.exitReason, p.signalId, JSON.stringify({ fills: p.fills, legs: p.legs, leverage: p.leverage, liqPrice: p.liqPrice }), p.bt ? 1 : 0, p.id,
    );
  }

  private persistFill(p: Position, f: Fill) {
    const side = f.reason === 'entry' ? (p.side === 'long' ? 'buy' : 'sell') : (p.side === 'long' ? 'sell' : 'buy');
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
    legs: extra.legs ?? [], leverage: extra.leverage ?? 0, liqPrice: extra.liqPrice ?? null, breakEven: Boolean(r.break_even), realizedPnl: r.realized_pnl, fees: r.fees, riskAmount: r.risk_amount, levelsSource: r.levels_source ?? 'script',
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
    levelsSource: p.levelsSource, leverage: p.leverage, liqPrice: p.liqPrice, signalId: p.signalId, status: p.status,
    notional: p.qtyOpen * p.contractValue * m, notionalEntry: p.qty * p.contractValue * p.entryPrice,
    margin: p.leverage > 0 ? (p.qtyOpen * p.contractValue * p.entryPrice) / p.leverage : null,
  };
}

export function tradeOf(p: Position) {
  const net = p.realizedPnl - p.fees;
  return {
    id: p.id, positionId: p.id, scannerId: p.scannerId, scannerName: p.scannerName, symbol: p.symbol, tf: p.tf, side: p.side, qty: p.qty, entryPrice: p.entryPrice,
    exitPrice: p.exitPrice, entryAt: p.entryAt, exitAt: p.exitAt, pnl: net, pnlPct: p.entryPrice ? net / (p.entryPrice * p.qty * p.contractValue) * 100 : 0, fees: p.fees,
    rMultiple: rMultiple(p), exitReason: p.exitReason, levelsSource: p.levelsSource, leverage: p.leverage, sl: p.slOriginal, tp: p.tp, tpHit: p.tpHit, fills: p.fills, signalId: p.signalId,
  };
}

export function orderOf(p: Position, f: Fill) {
  const side = f.reason === 'entry' ? (p.side === 'long' ? 'buy' : 'sell') : (p.side === 'long' ? 'sell' : 'buy');
  return { at: f.at, positionId: p.id, scannerId: p.scannerId, symbol: p.symbol, side, qty: f.qty, price: f.price, fee: f.fee, reason: f.reason, pnl: f.pnl };
}
