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
import { DELTA_INDIA_PROD, DELTA_INDIA_TESTNET, DeltaRest, type DeltaProduct } from '../delta/rest.ts';
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
  time_in_force?: 'gtc' | 'ioc' | 'fok';
  /** Executor annotation (stripped before sending): what this order is for. */
  purpose?: 'entry' | 'exit' | 'stop' | 'tp' | 'close-all';
}

export interface ExchangePosition { symbol: string; product_id: number; size: number; entry_price: number; raw?: any }
export interface ExchangeOrder { id: number | string; product_id: number; symbol?: string; side: 'buy' | 'sell'; size: number; unfilled_size?: number; order_type: string; stop_order_type?: string | null; limit_price?: string | null; stop_price?: string | null; reduce_only?: boolean; client_order_id?: string | null; state?: string; raw?: any }

export interface ExchangeTransport {
  readonly host: ExchangeHost;
  readonly baseUrl: string;
  readonly hasAuth: boolean;
  readonly dryRun: boolean;
  products(): Promise<Map<string, DeltaProduct>>;
  positions(): Promise<ExchangePosition[]>;
  openOrders(product_id?: number): Promise<ExchangeOrder[]>;
  placeOrder(o: OrderPayload): Promise<{ id: number | string; state?: string; dryRun?: boolean }>;
  cancelOrder(id: number | string, product_id: number): Promise<unknown>;
  cancelAll(product_id: number): Promise<unknown>;
  wallet(): Promise<unknown>;
}

/** Demo host unless production is explicitly double-opted-in (config flag AND env var). */
export function resolveHost(cfg: Pick<ExecutionConfig, 'allowProduction'> | undefined, env: NodeJS.ProcessEnv = process.env): ExchangeHost {
  return cfg?.allowProduction === true && env.DELTA_LIVE === '1' ? 'production' : 'testnet';
}
export function hostUrl(host: ExchangeHost): string { return host === 'production' ? DELTA_INDIA_PROD : DELTA_INDIA_TESTNET; }

/** The one rule production must obey: market orders only, and everything that is not an entry is reduce-only. */
export function assertProductionSafe(o: OrderPayload): void {
  if (o.order_type !== 'market_order' || o.stop_order_type || o.limit_price !== undefined || o.stop_price !== undefined) throw new Error(`production refuses ${o.stop_order_type ?? o.order_type}: only market orders are allowed`);
  if (o.purpose !== 'entry' && o.reduce_only !== true) throw new Error('production refuses a non-entry order that is not reduce-only');
}

export function wirePayload(o: OrderPayload): Record<string, unknown> {
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
  async positions(): Promise<ExchangePosition[]> {
    const res = await this.rest.positions();
    const list: any[] = Array.isArray(res) ? res : res?.result ?? [];
    return list.map(p => ({ symbol: String(p.product_symbol ?? p.symbol ?? p.product?.symbol ?? ''), product_id: Number(p.product_id ?? p.product?.id), size: Number(p.size ?? 0), entry_price: Number(p.entry_price ?? 0), raw: p }));
  }
  async openOrders(product_id?: number): Promise<ExchangeOrder[]> {
    const res = await this.rest.openOrders(product_id);
    const list: any[] = Array.isArray(res) ? res : res?.result ?? [];
    return list.map(o => ({ id: o.id, product_id: Number(o.product_id), symbol: o.product_symbol ?? o.symbol, side: o.side, size: Number(o.size ?? 0), unfilled_size: Number(o.unfilled_size ?? o.size ?? 0), order_type: o.order_type, stop_order_type: o.stop_order_type ?? null, limit_price: o.limit_price ?? null, stop_price: o.stop_price ?? null, reduce_only: Boolean(o.reduce_only), client_order_id: o.client_order_id ?? null, state: o.state, raw: o }));
  }
  async placeOrder(o: OrderPayload) {
    if (this.host === 'production') assertProductionSafe(o);
    const res = await this.rest.placeOrder(wirePayload(o) as any);
    return { id: res?.id ?? '?', state: res?.state };
  }
  cancelOrder(id: number | string, product_id: number) { return this.rest.cancelOrder(id, product_id); }
  cancelAll(product_id: number) { return this.rest.cancelAll(product_id); }
  wallet() { return this.rest.wallet(); }
}

/** Records every write instead of sending it; reads go to `reader` when one with keys is available. */
export class DryRunTransport implements ExchangeTransport {
  readonly dryRun = true;
  readonly log: Array<{ at: number; action: 'place' | 'cancel' | 'cancelAll'; payload: Record<string, unknown> }> = [];
  private seq = 1;
  private reader: ExchangeTransport | null;
  readonly host: ExchangeHost;
  constructor(reader: ExchangeTransport | null = null, host: ExchangeHost = 'testnet') { this.reader = reader; this.host = host; }
  get baseUrl(): string { return this.reader?.baseUrl ?? hostUrl(this.host); }
  get hasAuth(): boolean { return Boolean(this.reader?.hasAuth); }
  private record(action: 'place' | 'cancel' | 'cancelAll', payload: Record<string, unknown>) {
    this.log.push({ at: Date.now(), action, payload });
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
    log.info(`dry-run ${action} ${JSON.stringify(payload)}`);
  }
  products() { return this.reader?.products() ?? Promise.resolve(new Map<string, DeltaProduct>()); }
  positions() { return this.reader?.hasAuth ? this.reader.positions() : Promise.resolve([]); }
  openOrders(product_id?: number) { return this.reader?.hasAuth ? this.reader.openOrders(product_id) : Promise.resolve([]); }
  async placeOrder(o: OrderPayload) { if (this.host === 'production') assertProductionSafe(o); this.record('place', wirePayload(o)); return { id: `dry-${this.seq++}`, state: 'dry-run', dryRun: true }; }
  async cancelOrder(id: number | string, product_id: number) { this.record('cancel', { id, product_id }); return { dryRun: true }; }
  async cancelAll(product_id: number) { this.record('cancelAll', { product_id }); return { dryRun: true }; }
  wallet() { return this.reader?.hasAuth ? this.reader.wallet() : Promise.resolve(null); }
}
