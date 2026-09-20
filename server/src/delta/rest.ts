import { createHmac } from 'node:crypto';
import { logger } from '../log.ts';

const log = logger.scoped('delta.rest');

export const DELTA_INDIA_PROD = 'https://api.india.delta.exchange';
export const DELTA_INDIA_TESTNET = 'https://cdn-ind.testnet.deltaex.org';

export interface DeltaCandle { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface DeltaProduct {
  id: number; symbol: string; description: string; contract_type: string; state: string;
  tick_size: string; contract_value: string; underlying_asset?: { symbol: string }; quoting_asset?: { symbol: string };
}
export interface DeltaTicker {
  symbol: string; product_id: number; close: number; mark_price: string; spot_price?: string; open?: number; high?: number; low?: number;
  volume?: number; turnover_usd?: number; mark_change_24h?: string; tick_size?: string; contract_value?: string; description?: string;
  timestamp?: number; contract_type?: string;
}

export interface DeltaRestOptions {
  baseUrl?: string;
  apiKey?: string;
  apiSecret?: string;
  userAgent?: string;
  timeoutMs?: number;
}

/** Thin, dependency-free Delta Exchange (India) REST client. Public endpoints need no keys. */
export class DeltaRest {
  readonly baseUrl: string;
  private apiKey?: string;
  private apiSecret?: string;
  private ua: string;
  private timeoutMs: number;
  private productCache: Map<string, DeltaProduct> | null = null;
  private productCacheAt = 0;

  constructor(opts: DeltaRestOptions = {}) {
    this.baseUrl = (opts.baseUrl || DELTA_INDIA_PROD).replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.ua = opts.userAgent || 'vnedge-bot/0.1';
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  get hasAuth(): boolean { return Boolean(this.apiKey && this.apiSecret); }

  private sign(method: string, path: string, query: string, body: string, ts: string): string {
    const prehash = method + ts + path + query + body;
    return createHmac('sha256', this.apiSecret!).update(prehash).digest('hex');
  }

  async request<T = any>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts: { query?: Record<string, any>; body?: any; auth?: boolean; retries?: number } = {}): Promise<T> {
    const qs = opts.query ? '?' + new URLSearchParams(Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString() : '';
    const bodyStr = opts.body ? JSON.stringify(opts.body) : '';
    const headers: Record<string, string> = { 'User-Agent': this.ua, 'Content-Type': 'application/json', Accept: 'application/json' };
    if (opts.auth) {
      if (!this.hasAuth) throw new Error('Delta API key/secret not configured');
      const ts = String(Math.floor(Date.now() / 1000));
      headers['api-key'] = this.apiKey!;
      headers['timestamp'] = ts;
      headers['signature'] = this.sign(method, path, qs, bodyStr, ts);
    }
    const retries = opts.retries ?? 2;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(this.baseUrl + path + qs, { method, headers, body: bodyStr || undefined, signal: ctrl.signal });
        const text = await res.text();
        let json: any;
        try { json = JSON.parse(text); } catch { json = { success: false, error: { code: 'bad_json', message: text.slice(0, 200) } }; }
        if (res.status === 429) { lastErr = new Error('rate limited'); await sleep(1000 * (attempt + 1)); continue; }
        if (!res.ok || json?.success === false) {
          const msg = `Delta ${method} ${path} → ${res.status} ${JSON.stringify(json?.error ?? json).slice(0, 300)}`;
          if (res.status >= 500 && attempt < retries) { lastErr = new Error(msg); await sleep(500 * (attempt + 1)); continue; }
          throw new Error(msg);
        }
        return (json.result ?? json) as T;
      } catch (e: any) {
        lastErr = e;
        if (e?.name === 'AbortError' || /fetch failed|ECONNRESET|ETIMEDOUT/.test(String(e?.message))) {
          if (attempt < retries) { await sleep(500 * (attempt + 1)); continue; }
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  // ---- public market data ----

  /** Perpetual futures products (cached 10 min). */
  async products(force = false): Promise<Map<string, DeltaProduct>> {
    if (!force && this.productCache && Date.now() - this.productCacheAt < 600_000) return this.productCache;
    const map = new Map<string, DeltaProduct>();
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await this.request<any>('GET', '/v2/products', { query: { contract_types: 'perpetual_futures', states: 'live', page_size: 200, after } });
      const list: DeltaProduct[] = Array.isArray(res) ? res : res?.result ?? [];
      for (const p of list) map.set(p.symbol, p);
      after = undefined;
      break; // the API returns meta.after only inside the raw envelope; 200 covers all live perps today
    }
    this.productCache = map; this.productCacheAt = Date.now();
    return map;
  }

  async product(symbol: string): Promise<DeltaProduct | undefined> {
    const m = await this.products();
    if (m.has(symbol)) return m.get(symbol);
    try { return await this.request<DeltaProduct>('GET', `/v2/products/${symbol}`); } catch { return undefined; }
  }

  async tickers(contractTypes = 'perpetual_futures'): Promise<DeltaTicker[]> {
    return this.request<DeltaTicker[]>('GET', '/v2/tickers', { query: { contract_types: contractTypes } });
  }

  async ticker(symbol: string): Promise<DeltaTicker> {
    return this.request<DeltaTicker>('GET', `/v2/tickers/${symbol}`);
  }

  /**
   * Historical candles, ascending by time. `start`/`end` in epoch **seconds**.
   * Delta returns at most ~4000 candles per call and newest-first; this pages backwards until `start`.
   */
  async candles(symbol: string, resolution: string, startSec: number, endSec: number, maxBars = 20_000): Promise<DeltaCandle[]> {
    const out: DeltaCandle[] = [];
    let end = endSec;
    for (let i = 0; i < 20 && end > startSec; i++) {
      const res = await this.request<DeltaCandle[]>('GET', '/v2/history/candles', { query: { symbol, resolution, start: startSec, end } });
      if (!Array.isArray(res) || res.length === 0) break;
      out.push(...res);
      const oldest = Math.min(...res.map(c => c.time));
      if (res.length < 100 || oldest <= startSec || out.length >= maxBars) break;
      end = oldest - 1;
    }
    const seen = new Set<number>();
    const nowSec = Math.floor(Date.now() / 1000);
    const list = out.filter(c => c.time <= nowSec && (seen.has(c.time) ? false : (seen.add(c.time), true))).sort((a, b) => a.time - b.time);
    log.debug(`candles ${symbol} ${resolution}: ${list.length} bars`);
    return list;
  }

  /** Fetch the most recent `bars` candles for a resolution. */
  async recentCandles(symbol: string, resolution: string, bars: number, tfSeconds: number): Promise<DeltaCandle[]> {
    // NOTE: a window that extends past "now" makes Delta return an empty placeholder candle for the
    // next period, so the window always ends at the current second and future bars are dropped.
    const end = Math.floor(Date.now() / 1000);
    const start = end - tfSeconds * (bars + 5);
    const list = await this.candles(symbol, resolution, start, end, bars + 10);
    return list.filter(c => c.time <= end).slice(-bars);
  }

  // ---- authenticated (only used by the optional testnet executor) ----

  async wallet(): Promise<any> { return this.request('GET', '/v2/wallet/balances', { auth: true }); }
  async positions(): Promise<any> { return this.request('GET', '/v2/positions/margined', { auth: true }); }
  async placeOrder(order: { product_id: number; size: number; side: 'buy' | 'sell'; order_type: 'market_order' | 'limit_order'; limit_price?: string; reduce_only?: boolean; client_order_id?: string; stop_order_type?: string; stop_price?: string; time_in_force?: string }): Promise<any> {
    return this.request('POST', '/v2/orders', { auth: true, body: order, retries: 0 });
  }
  async cancelAll(product_id: number): Promise<any> { return this.request('DELETE', '/v2/orders/all', { auth: true, body: { product_id }, retries: 0 }); }
  /** Open (resting / untriggered) orders, optionally for one product. */
  async openOrders(product_id?: number): Promise<any> { return this.request('GET', '/v2/orders', { auth: true, query: { states: 'open,pending', product_ids: product_id, page_size: 200 } }); }
  async cancelOrder(id: number | string, product_id: number): Promise<any> { return this.request('DELETE', '/v2/orders', { auth: true, body: { id, product_id }, retries: 0 }); }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
