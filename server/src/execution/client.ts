/**
 * Exchange transport for the execution layer (phase 5).
 *
 * Host selection is deliberately hard to get wrong: `resolveHost()` returns the Delta India
 * DEMO host unless BOTH `execution.allowProduction: true` is configured AND the process runs
 * with `DELTA_LIVE=1`. Even then `RestTransport` refuses anything but plain market orders and
 * requires every non-entry order to be reduce-only, so production can never hold resting
 * limit/stop orders placed by this bot. `DryRunTransport` never sends a write: it records the
 * exact payloads (and can still read positions/orders through a real transport for reconciliation).
 */
import { DELTA_INDIA_PROD, DELTA_INDIA_TESTNET, DeltaRest, DeltaRequestError, type DeltaProduct } from '../delta/rest.ts';
import type { ExecutionConfig } from '../config.ts';
import { logger } from '../log.ts';

const log = logger.scoped('execution');

export type ExchangeHost = 'testnet' | 'production';

export interface OrderPayload {
  product_id: number;
  size: number;
  side: 'buy' | 'sell';
  order_type: 'market_order' | 'limit_order';
  limit_price?: string;
  reduce_only?: boolean;
  client_order_id?: string;
  stop_order_type?: 'stop_loss_order' | 'take_profit_order';
  stop_price?: string;
  stop_trigger_method?: 'mark_price' | 'last_traded_price';
  time_in_force?: 'gtc' | 'ioc';
  post_only?: boolean;
  /** Executor annotation (stripped before sending): what this order is for. */
  purpose?: 'entry' | 'exit' | 'stop' | 'tp' | 'close-all';
}

export interface ExchangePosition { symbol: string; product_id: number; size: number; entry_price: number; raw?: any }
export interface ExchangeOrder { id: number | string; product_id: number; symbol?: string; side: 'buy' | 'sell'; size: number; unfilled_size?: number; order_type: string; stop_order_type?: string | null; stop_trigger_method?: string | null; limit_price?: string | null; stop_price?: string | null; reduce_only?: boolean; client_order_id?: string | null; state?: string; average_fill_price?: number | null; paid_commission?: number | null; raw?: any }
export interface EditOrder { id: number | string; product_id: number; stop_price?: string; limit_price?: string; size?: number }

export interface ExchangeTransport {
  readonly host: ExchangeHost;
  readonly baseUrl: string;
  readonly hasAuth: boolean;
  readonly dryRun: boolean;
  products(): Promise<Map<string, DeltaProduct>>;
  positions(productIds?: number[]): Promise<ExchangePosition[]>;
  openOrders(product_id?: number): Promise<ExchangeOrder[]>;
  placeOrder(o: OrderPayload): Promise<{ id: number | string; state?: string; dryRun?: boolean }>;
  cancelOrder(id: number | string, product_id: number): Promise<unknown>;
  cancelAll(product_id: number): Promise<unknown>;
  wallet(): Promise<unknown>;
  accountHistory?(kind: 'fills'|'wallet', startMs:number,endMs:number): Promise<any[]>;
  /** One order by exchange id; null when the exchange does not know it. */
  order(id: number | string): Promise<ExchangeOrder | null>;
  /** One order by the client id this bot stamped on it; null when the exchange never received it. */
  orderByClientId(clientOrderId: string): Promise<ExchangeOrder | null>;
  /** Edit a resting order in place. */
  editOrder(e: EditOrder): Promise<{ id: number | string; state?: string }>;
  /** Set a product's order leverage; resolves to the leverage the exchange now holds for it. */
  setLeverage(product_id: number, leverage: number): Promise<{ leverage: number }>;
}

/** Demo host unless production is explicitly double-opted-in (config flag AND env var). */
export function resolveHost(cfg: Pick<ExecutionConfig, 'allowProduction'> | undefined, env: NodeJS.ProcessEnv = process.env): ExchangeHost {
  return cfg?.allowProduction === true && env.DELTA_LIVE === '1' ? 'production' : 'testnet';
}
export function hostUrl(host: ExchangeHost): string { return host === 'production' ? DELTA_INDIA_PROD : DELTA_INDIA_TESTNET; }

/** The one rule production must obey: market orders only, and everything that is not an entry is reduce-only. */
export class OrderValidationError extends Error {}
export function assertProductionSafe(o: OrderPayload): void {
  if (o.order_type !== 'market_order' || o.stop_order_type || o.limit_price !== undefined || o.stop_price !== undefined) throw new OrderValidationError(`production refuses ${o.stop_order_type ?? o.order_type}: only market orders are allowed`);
  if (o.purpose !== 'entry' && o.reduce_only !== true) throw new OrderValidationError('production refuses a non-entry order that is not reduce-only');
}

/** Invalid exchange data is unknown, never an empty book or a fabricated fill. */
export class ExchangeResponseError extends Error {}
function record(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ExchangeResponseError('invalid exchange object');
  return value;
}
function numberField(value: unknown, field: string, integer = false): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') throw new ExchangeResponseError(`missing or invalid exchange ${field}`);
  const n = Number(value);
  if (!Number.isFinite(n) || (integer && !Number.isSafeInteger(n))) throw new ExchangeResponseError(`invalid exchange ${field}`);
  return n;
}
function productId(value: unknown): number {
  const id = numberField(value, 'product_id', true);
  if (id <= 0) throw new ExchangeResponseError('invalid exchange product_id');
  return id;
}
function orderId(value: unknown): number | string {
  if ((typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
      (typeof value === 'string' && /^[1-9][0-9]*$/.test(value))) return value;
  throw new ExchangeResponseError('missing or invalid exchange order id');
}
function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new ExchangeResponseError('invalid exchange reduce_only');
}
function priceField(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (numberField(value, field) <= 0) throw new ExchangeResponseError(`invalid exchange ${field}`);
  return String(value);
}
export function parseOrder(value: any): ExchangeOrder {
  const o = record(value), id = orderId(o.id), pid = productId(o.product_id);
  const size = numberField(o.size, 'size', true), unfilled = numberField(o.unfilled_size, 'unfilled_size', true);
  if (size <= 0 || unfilled < 0 || unfilled > size) throw new ExchangeResponseError('invalid exchange cumulative quantities');
  if (!['buy', 'sell'].includes(o.side) || !['market_order', 'limit_order'].includes(o.order_type) || !['open', 'pending', 'closed', 'cancelled'].includes(o.state)) throw new ExchangeResponseError('invalid exchange order side, type or state');
  if (o.stop_order_type != null && !['stop_loss_order', 'take_profit_order'].includes(o.stop_order_type)) throw new ExchangeResponseError('invalid exchange stop type');
  const avg = o.average_fill_price == null ? null : numberField(o.average_fill_price, 'average_fill_price');
  if (avg !== null && (avg < 0 || (size > unfilled && avg === 0))) throw new ExchangeResponseError('invalid exchange average fill price');
  if (o.client_order_id != null && (typeof o.client_order_id !== 'string' || o.client_order_id.length > 32)) throw new ExchangeResponseError('invalid exchange client order id');
  return { id, product_id: pid, symbol: o.product_symbol ?? o.symbol, side: o.side, size, unfilled_size: unfilled, order_type: o.order_type, stop_order_type: o.stop_order_type ?? null, stop_trigger_method: o.stop_trigger_method ?? null, limit_price: priceField(o.limit_price, 'limit_price'), stop_price: priceField(o.stop_price, 'stop_price'), reduce_only: optionalBoolean(o.reduce_only), client_order_id: o.client_order_id ?? null, state: o.state, average_fill_price: avg, paid_commission: o.paid_commission == null ? null : numberField(o.paid_commission, 'paid_commission'), raw: o };
}
function orderAbsent(e: unknown): boolean {
  return e instanceof DeltaRequestError && [400, 404].includes(e.status) && ['order_not_found', 'invalid_order_id', 'invalid_client_order_id'].includes(e.code ?? '');
}

export function validatePostOnly(o: OrderPayload): void {
  if(o.post_only && (o.order_type!=='limit_order' || !(Number.isFinite(Number(o.limit_price)) && Number(o.limit_price)>0) || (o.time_in_force && o.time_in_force!=='gtc')))throw new OrderValidationError('post-only requires a positive-priced GTC limit');
}

export function wirePayload(o: OrderPayload): Record<string, unknown> {
  validatePostOnly(o);
  if (!Number.isSafeInteger(o.product_id) || o.product_id <= 0 || !Number.isSafeInteger(o.size) || o.size <= 0) throw new OrderValidationError('order requires positive integer product_id and size');
  if (!['buy', 'sell'].includes(o.side) || !['market_order', 'limit_order'].includes(o.order_type)) throw new OrderValidationError('invalid order side or type');
  if (o.time_in_force !== undefined && !['gtc', 'ioc'].includes(o.time_in_force)) throw new OrderValidationError('unsupported time_in_force; use gtc or ioc');
  for (const name of ['reduce_only', 'post_only'] as const) if (o[name] !== undefined && typeof o[name] !== 'boolean') throw new OrderValidationError(`${name} must be boolean`);
  for (const name of ['limit_price', 'stop_price'] as const) if (o[name] !== undefined && (typeof o[name] !== 'string' || o[name]!.trim() === '' || !Number.isFinite(Number(o[name])) || Number(o[name]) <= 0)) throw new OrderValidationError(`${name} must be a positive finite price`);
  if (o.order_type === 'limit_order' && o.limit_price === undefined) throw new OrderValidationError('limit order requires limit_price');
  if (o.stop_order_type !== undefined && (!['stop_loss_order', 'take_profit_order'].includes(o.stop_order_type) || o.stop_price === undefined)) throw new OrderValidationError('stop order requires a supported type and stop_price');
  if (o.stop_price !== undefined && !o.stop_order_type) throw new OrderValidationError('stop_price requires stop_order_type');
  if (o.stop_trigger_method !== undefined && (!o.stop_order_type || !['mark_price', 'last_traded_price'].includes(o.stop_trigger_method))) throw new OrderValidationError('invalid stop trigger');
  if (o.client_order_id !== undefined && (typeof o.client_order_id !== 'string' || !o.client_order_id.length || o.client_order_id.length > 32)) throw new OrderValidationError('client_order_id must be 1..32 characters');
  const { purpose: _p, ...rest } = o;
  return rest;
}

export class RestTransport implements ExchangeTransport {
  readonly host: ExchangeHost;
  readonly baseUrl: string;
  readonly dryRun = false;
  private rest: DeltaRest;

  constructor(host: ExchangeHost, creds: { apiKey?: string; apiSecret?: string } = { apiKey: process.env.DELTA_API_KEY, apiSecret: process.env.DELTA_API_SECRET }, rest?: DeltaRest) {
    this.host = host;
    this.baseUrl = hostUrl(host);
    this.rest = rest ?? new DeltaRest({ baseUrl: this.baseUrl, apiKey: creds.apiKey, apiSecret: creds.apiSecret });
    if (host === 'production') log.error('PRODUCTION HOST SELECTED (execution.allowProduction + DELTA_LIVE=1): market orders only, exits reduce-only');
  }
  get hasAuth(): boolean { return this.rest.hasAuth; }
  products() { return this.rest.products(); }
  async positions(productIds: number[] = []): Promise<ExchangePosition[]> {
    // Inventory discovers external exposure. Known products cover fills that have
    // not reached that inventory yet. Never use its delayed size for reconciliation.
    const inventory = await this.rest.positions();
    if (!Array.isArray(inventory)) throw new ExchangeResponseError('invalid exchange position inventory');
    const symbols = new Map<number, string>(), ids = new Set(productIds.map(productId));
    for (const item of inventory) {
      const p = record(item), id = productId(p.product_id ?? p.product?.id);
      if (symbols.has(id)) throw new ExchangeResponseError('duplicate exchange position product');
      const symbol = p.product_symbol ?? p.symbol ?? p.product?.symbol;
      if (typeof symbol !== 'string' || !symbol.length) throw new ExchangeResponseError('missing exchange position symbol');
      numberField(p.size, 'position size', true);
      symbols.set(id, symbol); ids.add(id);
    }
    if ([...ids].some(id => !symbols.has(id))) {
      for (const p of (await this.rest.products()).values()) if (ids.has(p.id) && !symbols.has(p.id)) symbols.set(p.id, p.symbol);
    }
    for (const id of ids) if (!symbols.get(id)) throw new ExchangeResponseError('unknown exchange position product');
    const pending = [...ids], result: ExchangePosition[] = [];
    // Bound signed request fan-out; one failure invalidates the whole snapshot.
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      for (;;) {
        const id = pending.shift(); if (id === undefined) return;
        const p = record(await this.rest.position(id));
        if (p.product_id !== undefined && productId(p.product_id) !== id) throw new ExchangeResponseError('exchange position identity mismatch');
        const size = numberField(p.size, 'position size', true);
        const entry = p.entry_price == null && size === 0 ? 0 : numberField(p.entry_price, 'position entry price');
        if (entry < 0 || (size !== 0 && entry === 0)) throw new ExchangeResponseError('invalid exchange position entry price');
        result.push({ symbol: symbols.get(id)!, product_id: id, size, entry_price: entry, raw: p });
      }
    }));
    return result.sort((a, b) => a.product_id - b.product_id);
  }
  async openOrders(product_id?: number): Promise<ExchangeOrder[]> {
    const list = await this.rest.openOrders(product_id);
    return list.map(parseOrder);
  }
  async order(id: number | string): Promise<ExchangeOrder | null> {
    try { const res = await this.rest.order(id); return parseOrder(res); }
    catch (e: any) { if (orderAbsent(e)) return null; throw e; }
  }
  async orderByClientId(clientOrderId: string): Promise<ExchangeOrder | null> {
    try { const res = await this.rest.orderByClientId(clientOrderId); return parseOrder(res); }
    catch (e: any) { if (orderAbsent(e)) return null; throw e; }
  }
  async editOrder(e: EditOrder) {
    const res = await this.rest.editOrder(e), id = orderId(res?.id);
    if (String(id) !== String(e.id)) throw new ExchangeResponseError('edit acknowledgement identity mismatch');
    return { id, state: res?.state }; // The executor independently reads back the edited protection.
  }
  async setLeverage(product_id: number, leverage: number) { const res = await this.rest.setLeverage(product_id, leverage); return { leverage: Number(res?.leverage ?? res?.result?.leverage ?? NaN) }; }
  async placeOrder(o: OrderPayload) {
    validatePostOnly(o);
    if (this.host === 'production') assertProductionSafe(o);
    const res = await this.rest.placeOrder(wirePayload(o) as any);
    return { id: orderId(res?.id), state: res?.state };
  }
  cancelOrder(id: number | string, product_id: number) { return this.rest.cancelOrder(id, product_id); }
  cancelAll(product_id: number) { return this.rest.cancelAll(product_id); }
  wallet() { return this.rest.wallet(); }
  accountHistory(kind: 'fills'|'wallet', startMs:number,endMs:number) {return this.rest.accountHistory(kind,startMs,endMs);}
}

/** Records every write instead of sending it; reads go to `reader` when one with keys is available. */
export class DryRunTransport implements ExchangeTransport {
  readonly dryRun = true;
  readonly log: Array<{ at: number; action: 'place' | 'cancel' | 'cancelAll' | 'edit' | 'leverage'; payload: Record<string, unknown>; id?: string }> = [];
  private seq = 1;
  private reader: ExchangeTransport | null;
  readonly host: ExchangeHost;
  constructor(reader: ExchangeTransport | null = null, host: ExchangeHost = 'testnet') { this.reader = reader; this.host = host; }
  get baseUrl(): string { return this.reader?.baseUrl ?? hostUrl(this.host); }
  get hasAuth(): boolean { return Boolean(this.reader?.hasAuth); }
  private record(action: 'place' | 'cancel' | 'cancelAll' | 'edit' | 'leverage', payload: Record<string, unknown>) {
    this.log.push({ at: Date.now(), action, payload });
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
    log.info(`dry-run ${action} ${JSON.stringify(payload)}`);
  }
  products() { return this.reader?.products() ?? Promise.resolve(new Map<string, DeltaProduct>()); }
  positions(productIds?: number[]) { return this.reader?.hasAuth ? this.reader.positions(productIds) : Promise.resolve([]); }
  openOrders(product_id?: number) { return this.reader?.hasAuth ? this.reader.openOrders(product_id) : Promise.resolve([]); }
  async placeOrder(o: OrderPayload) { if (this.host === 'production') assertProductionSafe(o); const id = `dry-${this.seq++}`; this.record('place', wirePayload(o)); this.log.at(-1)!.id = id; return { id, state: 'dry-run', dryRun: true }; }
  async cancelOrder(id: number | string, product_id: number) { this.record('cancel', { id, product_id }); return { dryRun: true }; }
  async cancelAll(product_id: number) { this.record('cancelAll', { product_id }); return { dryRun: true }; }
  wallet() { return this.reader?.hasAuth ? this.reader.wallet() : Promise.resolve(null); }
  /** A dry-run market order is reported as filled in full at no known price, so the paper price stands; a resting order stays open. */
  async order(id: number | string): Promise<ExchangeOrder | null> {
    const mine = this.log.find(l => l.action === 'place' && l.id === String(id));
    if (!mine) return this.reader?.hasAuth ? this.reader.order(id) : null;
    const p = mine.payload;
    const market = p.order_type === 'market_order' && !p.stop_order_type;
    return { id, stop_price: p.stop_price as string | undefined, stop_order_type: p.stop_order_type as string | undefined, stop_trigger_method: p.stop_trigger_method as string | undefined, limit_price: p.limit_price as string | undefined, product_id: Number(p.product_id), side: p.side as 'buy' | 'sell', size: Number(p.size), unfilled_size: market ? 0 : Number(p.size), order_type: String(p.order_type), state: market ? 'closed' : 'open', average_fill_price: null, paid_commission: null, reduce_only: Boolean(p.reduce_only), client_order_id: String(p.client_order_id ?? '') };
  }
  async orderByClientId(clientOrderId: string): Promise<ExchangeOrder | null> {
    const mine = this.log.find(l => l.action === 'place' && l.payload.client_order_id === clientOrderId);
    return mine?.id ? this.order(mine.id) : null;
  }
  async editOrder(e: EditOrder) { this.record('edit', { ...e }); const mine = this.log.find(l => l.action === 'place' && l.id === String(e.id)); if (mine) Object.assign(mine.payload, e); return { id: e.id, state: 'dry-run' }; }
  async setLeverage(product_id: number, leverage: number) { this.record('leverage', { product_id, leverage }); return { leverage }; }
}
