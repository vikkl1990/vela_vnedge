import { DeltaRest, DELTA_INDIA_PROD } from '../delta/rest.ts';
import { feeDetails } from '../execution/accountAudit.ts';

type Row = Record<string, any>;
export type HistoryKind = 'fills' | 'wallet';
export type ObservedBalance = { asset: string; balance: string | null; available: string | null; tradingFeeCredit: string | null };
export type ObservedPosition = { productId: string; symbol: string | null; size: number; entryPrice: string | null };
export type ObservedOrder = { id: string; productId: string; symbol: string | null; side: string; size: number; unfilled: number; state: string; reduceOnly: boolean | null; stopPrice: string | null };
export type AccountSnapshot = { balances: ObservedBalance[]; positions: ObservedPosition[]; orders: ObservedOrder[] };
export type HistoryRow = { id: string; at: number; payload: Record<string, unknown> };
/** This capability has no order writer, arbitrary URL or method parameter. */
export interface AccountReader {
  identity(): Promise<string>;
  snapshot(accountId: string, knownProducts: string[]): Promise<AccountSnapshot>;
  history(kind: HistoryKind, start: number, end: number, accountId: string): Promise<HistoryRow[]>;
}

export function identifier(v: unknown): string {
  if ((typeof v === 'number' && Number.isSafeInteger(v) && v > 0) ||
    (typeof v === 'string' && /^[1-9]\d{0,39}$/.test(v))) return String(v);
  throw Error('invalid identifier');
}
export function decimal(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.length <= 128 && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v) && Number.isFinite(Number(v)) ? v : null;
}
function label(v: unknown): string | null { return typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(v) ? v : null; }
function rows(v: unknown): Row[] {
  if (!Array.isArray(v) || v.some(r => !r || typeof r !== 'object' || Array.isArray(r))) throw Error('invalid rows');
  return v;
}
function quantity(v: unknown, signed = false): number {
  const d = decimal(v), n = d === null ? NaN : Number(d);
  if (!Number.isSafeInteger(n) || (!signed && n < 0)) throw Error('invalid quantity');
  return n;
}
function sameAccount(row: Row, accountId: string): void {
  if (row.user_id != null && identifier(row.user_id) !== accountId) throw Error('account identity mismatch');
}
function timestamp(v: unknown): number {
  const numeric = decimal(v);
  const n = numeric !== null ? Math.floor(Number(numeric) / 1000) : typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw Error('invalid history timestamp');
  return n;
}

/** Production India only. Each sync gets a fresh bounded reader; all calls are authenticated GETs. */
export function productionReader(apiKey: string, apiSecret: string, current: () => boolean = () => true): AccountReader {
  const rest = new DeltaRest({ baseUrl: DELTA_INDIA_PROD, apiKey, apiSecret, timeoutMs: 8_000 });
  const deadline = Date.now() + 90_000;
  async function get(path: string, query?: Record<string, string | number>) {
    if (!current()) throw Error('observation invalidated');
    if (Date.now() >= deadline) throw Error('observer time budget exceeded');
    const envelope = await rest.request<any>('GET', path, { query, auth: true, retries: 0, raw: true });
    if (!current()) throw Error('observation invalidated');
    if (!envelope || envelope.success !== true) throw Error('incomplete response');
    return envelope;
  }
  async function pages(path: string, query: Record<string, string | number>): Promise<Row[]> {
    const found = new Map<string, Row>(), cursors = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page < 100; page++) {
      const response = await get(path, { ...query, ...(after ? { after } : {}) });
      for (const row of rows(response.result)) {
        const id = identifier(row.id), old = found.get(id);
        if (old && JSON.stringify(old) !== JSON.stringify(row)) throw Error('conflicting duplicate history');
        found.set(id, row);
      }
      // An absent pagination envelope cannot prove the final page was received.
      if (!response.meta || typeof response.meta !== 'object' || Array.isArray(response.meta)) throw Error('missing pagination');
      const next = response.meta.after;
      if (next == null || next === '') return [...found.values()];
      if (typeof next !== 'string' || next.length > 2048 || cursors.has(next)) throw Error('invalid pagination cursor');
      cursors.add(next); after = next;
    }
    throw Error('pagination limit exceeded');
  }
  return {
    async identity() { return identifier((await get('/v2/users/trading_preferences')).result?.user_id); },
    async snapshot(accountId, knownProducts) {
      const balances = rows((await get('/v2/wallet/balances')).result).map(r => {
        sameAccount(r, accountId);
        const asset = label(r.asset_symbol);
        if (!asset) throw Error('missing wallet asset');
        return { asset, balance: decimal(r.balance), available: decimal(r.available_balance), tradingFeeCredit: decimal(r.trading_fee_credit) };
      });
      if (new Set(balances.map(b => b.asset)).size !== balances.length) throw Error('duplicate wallet asset');
      const orders = (await pages('/v2/orders', { states: 'open,pending', page_size: 100 })).map(r => {
        sameAccount(r, accountId);
        if (!['buy', 'sell'].includes(r.side) || !['open', 'pending'].includes(r.state)) throw Error('invalid open order');
        const size = quantity(r.size), unfilled = quantity(r.unfilled_size);
        if (unfilled > size) throw Error('invalid remaining quantity');
        return { id: identifier(r.id), productId: identifier(r.product_id), symbol: label(r.product_symbol ?? r.product?.symbol), side: r.side as string,
          size, unfilled, state: r.state as string, reduceOnly: typeof r.reduce_only === 'boolean' ? r.reduce_only : null, stopPrice: decimal(r.stop_price) };
      });
      // Margined positions may lag. Discover products there, then confirm each known product using realtime positions.
      const inventory = rows((await get('/v2/positions/margined')).result);
      const products = new Set([...knownProducts, ...orders.map(o => o.productId)]);
      for (const r of inventory) { sameAccount(r, accountId); products.add(identifier(r.product_id)); }
      const positions: ObservedPosition[] = [];
      for (const productId of products) {
        const r = (await get('/v2/positions', { product_id: productId })).result;
        if (!r || identifier(r.product_id) !== productId) throw Error('position identity mismatch');
        sameAccount(r, accountId);
        const size = quantity(r.size, true);
        if (size !== 0) positions.push({ productId, symbol: label(r.product_symbol ?? r.product?.symbol), size, entryPrice: decimal(r.entry_price) });
      }
      return { balances, orders, positions };
    },
    async history(kind, start, end, accountId) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end <= start || end - start > 3600_000) throw Error('invalid history window');
      const result = await pages(kind === 'fills' ? '/v2/fills' : '/v2/wallet/transactions', { start_time: start * 1000, end_time: end * 1000, page_size: 100 });
      return result.map(r => {
        sameAccount(r, accountId);
        const id = identifier(r.id), at = timestamp(r.created_at);
        if (at < start || at > end) throw Error('history outside requested window');
        const payload = kind === 'fills' ? {
          id, orderId: identifier(r.order_id), productId: identifier(r.product_id), symbol: label(r.product_symbol ?? r.product?.symbol),
          side: label(r.side), size: quantity(r.size), price: decimal(r.price), commission: decimal(r.commission),
          asset: label(r.settling_asset_symbol ?? r.settling_asset?.symbol), role: label(r.role), feeDetails: feeDetails(r.meta_data),
        } : { id, amount: decimal(r.amount), asset: label(r.asset_symbol), assetId: r.asset_id == null ? null : identifier(r.asset_id), transactionType: label(r.transaction_type) };
        return { id, at, payload };
      });
    },
  };
}
