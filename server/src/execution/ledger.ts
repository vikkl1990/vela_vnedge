/**
 * The order ledger: every order the executor intends to send is written here before it is sent,
 * and every change of its state after. `intent → submitted → acknowledged → filled | cancelled |
 * rejected`, with `unknown` for an order the exchange could not be asked about. A restart rebuilds
 * the executor's view of the exchange from these rows (decision 46), never from memory.
 */
import type { Db } from '../db.ts';
import type { OrderPayload } from './client.ts';

export type LedgerState = 'intent' | 'submitted' | 'acknowledged' | 'filled' | 'cancelled' | 'rejected' | 'unknown';
export type Purpose = 'entry' | 'exit' | 'stop' | 'tp' | 'close-all';

export interface LedgerRow {
  id: number; positionId: number; purpose: Purpose; reason: string | null; leg: number | null; clientOrderId: string;
  productId: number; symbol: string; side: 'buy' | 'sell'; size: number; orderType: string; stopPrice: number | null; limitPrice: number | null;
  state: LedgerState; exchangeId: string | null; filledSize: number; avgPrice: number | null; fee: number | null; error: string | null;
  createdAt: number; updatedAt: number;
}

const OPEN_STATES: LedgerState[] = ['submitted', 'acknowledged', 'unknown'];

export class OrderLedger {
  private db: Db;
  private now: () => number;
  constructor(db: Db, now: () => number = () => Date.now()) { this.db = db; this.now = now; }

  /** Record the intent to send an order. Returns the row; the caller sends it and reports what happened. */
  intent(o: OrderPayload, positionId: number, symbol: string, leg: number | null = null, reason: string | null = null): LedgerRow {
    const at = this.now();
    const r = this.db.run(
      'INSERT INTO exchange_orders(position_id, purpose, reason, leg, client_order_id, product_id, symbol, side, size, order_type, stop_price, limit_price, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      positionId, o.purpose ?? 'exit', reason, leg, o.client_order_id ?? `vnedge-${positionId}-${at.toString(36)}`, o.product_id, symbol, o.side, o.size, o.stop_order_type ?? o.order_type,
      o.stop_price !== undefined ? Number(o.stop_price) : null, o.limit_price !== undefined ? Number(o.limit_price) : null, 'intent', at, at,
    );
    return this.get(Number(r.lastInsertRowid))!;
  }

  submitted(id: number, exchangeId: number | string | null, state: LedgerState = 'submitted') { this.set(id, { state, exchange_id: exchangeId === null ? null : String(exchangeId) }); }
  acknowledged(id: number, exchangeId?: number | string) { this.set(id, { state: 'acknowledged', ...(exchangeId !== undefined ? { exchange_id: String(exchangeId) } : {}) }); }
  filled(id: number, f: { filledSize: number; avgPrice: number | null; fee: number | null }) { this.set(id, { state: 'filled', filled_size: f.filledSize, avg_price: f.avgPrice, fee: f.fee }); }
  cancelled(id: number, note?: string) { this.set(id, { state: 'cancelled', ...(note ? { error: note } : {}) }); }
  rejected(id: number, error: string) { this.set(id, { state: 'rejected', error: error.slice(0, 300) }); }
  unknown(id: number, error: string) { this.set(id, { state: 'unknown', error: error.slice(0, 300) }); }
  /** A resting order edited in place keeps its row; its price and size move with it. */
  edited(id: number, e: { stopPrice?: number; limitPrice?: number; size?: number }) {
    this.set(id, { ...(e.stopPrice !== undefined ? { stop_price: e.stopPrice } : {}), ...(e.limitPrice !== undefined ? { limit_price: e.limitPrice } : {}), ...(e.size !== undefined ? { size: e.size } : {}) });
  }

  get(id: number): LedgerRow | undefined { const r = this.db.get<any>('SELECT * FROM exchange_orders WHERE id=?', id); return r ? row(r) : undefined; }
  byClientId(cid: string): LedgerRow | undefined { const r = this.db.get<any>('SELECT * FROM exchange_orders WHERE client_order_id=?', cid); return r ? row(r) : undefined; }
  forPosition(positionId: number): LedgerRow[] { return this.db.all<any>('SELECT * FROM exchange_orders WHERE position_id=? ORDER BY id ASC', positionId).map(row); }
  /** Orders that may still be alive on the exchange: sent but not yet settled either way. */
  unsettled(): LedgerRow[] { return this.db.all<any>(`SELECT * FROM exchange_orders WHERE state IN (${OPEN_STATES.map(() => '?').join(',')}) ORDER BY id ASC`, ...OPEN_STATES).map(row); }
  /** Resting protection (stops and targets) believed to be on the exchange for one position. */
  restingFor(positionId: number): LedgerRow[] { return this.forPosition(positionId).filter(r => (r.purpose === 'stop' || r.purpose === 'tp') && r.state === 'acknowledged'); }
  recent(limit = 100): LedgerRow[] { return this.db.all<any>('SELECT * FROM exchange_orders ORDER BY id DESC LIMIT ?', limit).map(row); }

  private set(id: number, fields: Record<string, unknown>) {
    const keys = Object.keys(fields);
    this.db.run(`UPDATE exchange_orders SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...keys.map(k => fields[k]), this.now(), id);
  }
}

function row(r: any): LedgerRow {
  return {
    id: r.id, positionId: r.position_id, purpose: r.purpose, reason: r.reason ?? null, leg: r.leg ?? null, clientOrderId: r.client_order_id, productId: r.product_id, symbol: r.symbol, side: r.side, size: r.size,
    orderType: r.order_type, stopPrice: r.stop_price ?? null, limitPrice: r.limit_price ?? null, state: r.state, exchangeId: r.exchange_id ?? null, filledSize: r.filled_size ?? 0,
    avgPrice: r.avg_price ?? null, fee: r.fee ?? null, error: r.error ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
