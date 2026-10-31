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
  sourceOrderId: number | null;
  adoptionPending: boolean;
  id: number; positionId: number; purpose: Purpose; reason: string | null; leg: number | null; clientOrderId: string;
  productId: number; symbol: string; side: 'buy' | 'sell'; size: number; orderType: string; stopPrice: number | null; limitPrice: number | null;
  state: LedgerState; exchangeId: string | null; filledSize: number; avgPrice: number | null; fee: number | null; error: string | null;
  createdAt: number; updatedAt: number;
}

const OPEN_STATES: LedgerState[] = ['intent', 'submitted', 'acknowledged', 'unknown'];

export class OrderLedger {
  private db: Db;
  private now: () => number;
  private host:string;
  constructor(db: Db, now: () => number = () => Date.now(), host = 'unknown') { this.db = db; this.now = now; this.host=host; }

  /** Record the intent to send an order. Returns the row; the caller sends it and reports what happened. */
  intent(o: OrderPayload, positionId: number, symbol: string, leg: number | null = null, reason: string | null = null, sourceOrderId?: number | null): LedgerRow {
    const at = this.now();
    sourceOrderId ??= this.db.get<{id:number}>('SELECT source_order_id id FROM execution_commands WHERE client_order_id=? AND scope=?',o.client_order_id??'',this.host)?.id ?? null;
    const r = this.db.run(
      'INSERT INTO exchange_orders(position_id, purpose, reason, leg, client_order_id, product_id, symbol, side, size, order_type, stop_price, limit_price, state, created_at, updated_at, host, source_order_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      positionId, o.purpose ?? 'exit', reason, leg, o.client_order_id ?? `vnedge-${positionId}-${at.toString(36)}`, o.product_id, symbol, o.side, o.size, o.stop_order_type ?? o.order_type,
      o.stop_price !== undefined ? Number(o.stop_price) : null, o.limit_price !== undefined ? Number(o.limit_price) : null, 'intent', at, at, this.host, sourceOrderId,
    );
    return this.get(Number(r.lastInsertRowid))!;
  }

  submitted(id: number, exchangeId: number | string | null, state: LedgerState = 'submitted') { this.set(id, { state, exchange_id: exchangeId === null ? null : String(exchangeId) }); }
  acknowledged(id: number, exchangeId?: number | string) { this.set(id, { state: 'acknowledged', ...(exchangeId !== undefined ? { exchange_id: String(exchangeId) } : {}) }); }
  filled(id: number, f: { filledSize: number; avgPrice: number | null; fee: number | null }) {
    const r=this.get(id);
    this.set(id, { state: 'filled', filled_size: f.filledSize, avg_price: f.avgPrice, fee: f.fee,
      adoption_pending:r && r.sourceOrderId===null && (r.purpose==='stop'||r.purpose==='tp') && f.filledSize>0?1:0 });
  }
  /** Cumulative snapshots, never incremental charges. An older quantity cannot erase a fill. */
  observed(id: number, f: { filledSize: number; avgPrice: number | null; fee: number | null }): void {
    const r=this.get(id);
    if(!r || !Number.isSafeInteger(f.filledSize) || f.filledSize<r.filledSize || f.filledSize>r.size)throw new Error('invalid or regressing cumulative fill quantity');
    if(f.avgPrice!==null && (!Number.isFinite(f.avgPrice)||f.avgPrice<=0) || f.fee!==null && !Number.isFinite(f.fee))throw new Error('invalid cumulative price or commission');
    this.set(id,{filled_size:f.filledSize,avg_price:f.avgPrice??(f.filledSize===r.filledSize?r.avgPrice:null),fee:f.fee??(f.filledSize===r.filledSize?r.fee:null)});
  }
  link(id:number, sourceOrderId:number):void {
    const r=this.get(id), source=this.db.get<any>('SELECT position_id,side FROM orders WHERE id=? AND bt=0',sourceOrderId);
    if(!r || !source || source.position_id!==r.positionId || source.side!==r.side || (r.sourceOrderId!==null && r.sourceOrderId!==sourceOrderId))throw new Error('exchange fill source mismatch');
    this.set(id,{source_order_id:sourceOrderId,adoption_pending:0});
  }
  cancelled(id: number, note?: string) { this.set(id, { state: 'cancelled', ...(note ? { error: note } : {}) }); }
  rejected(id: number, error: string) { this.set(id, { state: 'rejected', error: error.slice(0, 300) }); }
  unknown(id: number, error: string) { this.set(id, { state: 'unknown', error: error.slice(0, 300) }); }
  /** A resting order edited in place keeps its row; its price and size move with it. */
  edited(id: number, e: { stopPrice?: number; limitPrice?: number; size?: number }) {
    this.set(id, { ...(e.stopPrice !== undefined ? { stop_price: e.stopPrice } : {}), ...(e.limitPrice !== undefined ? { limit_price: e.limitPrice } : {}), ...(e.size !== undefined ? { size: e.size } : {}) });
  }

  get(id: number): LedgerRow | undefined { const r = this.db.get<any>('SELECT * FROM exchange_orders WHERE id=? AND host=?', id, this.host); return r ? row(r) : undefined; }
  byClientId(cid: string): LedgerRow | undefined { const r = this.db.get<any>('SELECT * FROM exchange_orders WHERE client_order_id=? AND host=?', cid, this.host); return r ? row(r) : undefined; }
  forPosition(positionId: number): LedgerRow[] { return this.db.all<any>('SELECT * FROM exchange_orders WHERE position_id=? AND host=? ORDER BY id ASC', positionId, this.host).map(row); }
  /** Orders that may still be alive on the exchange: sent but not yet settled either way. */
  unsettled(): LedgerRow[] { return this.db.all<any>(`SELECT * FROM exchange_orders WHERE host=? AND state IN (${OPEN_STATES.map(() => '?').join(',')}) ORDER BY id ASC`, this.host, ...OPEN_STATES).map(row); }
  /** Resting protection (stops and targets) believed to be on the exchange for one position. */
  restingFor(positionId: number): LedgerRow[] { return this.forPosition(positionId).filter(r => (r.purpose === 'stop' || r.purpose === 'tp') && r.state === 'acknowledged'); }
  pendingAdoptions(): LedgerRow[] { return this.db.all<any>("SELECT * FROM exchange_orders WHERE host=? AND state='filled' AND adoption_pending=1 ORDER BY id",this.host).map(row); }
  recent(limit = 100): LedgerRow[] { return this.db.all<any>('SELECT * FROM exchange_orders WHERE host=? ORDER BY id DESC LIMIT ?', this.host, limit).map(row); }
  /** Exposure recovery must not lose old entries when recent history exceeds a display limit. */
  filledExposure(): Array<{ positionId: number; qty: number }> {
    return this.db.all<{positionId:number;qty:number}>(`SELECT position_id AS positionId, SUM(CASE WHEN purpose='entry' THEN filled_size ELSE -filled_size END) AS qty FROM exchange_orders WHERE host=? AND filled_size>0 AND position_id>0 GROUP BY position_id`, this.host);
  }

  private set(id: number, fields: Record<string, unknown>) {
    const keys = Object.keys(fields);
    this.db.transaction(()=>{
      this.db.run(`UPDATE exchange_orders SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=? AND host=?`, ...keys.map(k => fields[k]), this.now(), id, this.host);
      this.db.run(`UPDATE execution_accounting SET state='pending' WHERE scope=? AND source_order_id=(SELECT source_order_id FROM exchange_orders WHERE id=? AND host=?)`,this.host,id,this.host);
    });
  }
}

function row(r: any): LedgerRow {
  return {
    sourceOrderId: r.source_order_id ?? null,
    adoptionPending: Boolean(r.adoption_pending),
    id: r.id, positionId: r.position_id, purpose: r.purpose, reason: r.reason ?? null, leg: r.leg ?? null, clientOrderId: r.client_order_id, productId: r.product_id, symbol: r.symbol, side: r.side, size: r.size,
    orderType: r.order_type, stopPrice: r.stop_price ?? null, limitPrice: r.limit_price ?? null, state: r.state, exchangeId: r.exchange_id ?? null, filledSize: r.filled_size ?? 0,
    avgPrice: r.avg_price ?? null, fee: r.fee ?? null, error: r.error ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
