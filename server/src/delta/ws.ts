import { EventEmitter } from 'node:events';
import { logger } from '../log.ts';

const log = logger.scoped('delta.ws');

export const DELTA_INDIA_WS = 'wss://public-socket.india.delta.exchange';
export const DELTA_INDIA_LEGACY_WS = 'wss://socket.india.delta.exchange';
export const DELTA_INDIA_PUBLIC_TESTNET_WS = 'wss://socket-ind-pub.testnet.deltaex.org';
const GLOBAL_CHANNELS = new Set(['product_updates', 'system_status']);

export interface WsCandle {
  symbol: string;
  resolution: string; // '1m', '15m', ...
  candleStartMs: number;
  open: number; high: number; low: number; close: number; volume: number;
  updatedMs: number;
}
/** `v2/ticker` channel. Delta carries the top of book here (`quotes.best_bid` / `best_ask`), not on `mark_price`. */
export interface WsTicker { symbol: string; price: number; markPrice: number; timeMs: number; bestBid: number | null; bestAsk: number | null }
/** L1 publication time is freshness; bookTimeMs can remain unchanged on an unchanged book. */
export interface WsQuote { symbol: string; bestBid: number; bestAsk: number; bidSize: number; askSize: number; timeMs: number; bookTimeMs: number; receivedAt: number }
/** One print from the `all_trades` channel (the tape). `qty` is in contracts. */
export interface WsTrade { symbol: string; price: number; qty: number; timeMs: number; aggressor: 'buy' | 'sell' | null }
/** `mark_price` channel (Delta sends symbols as `MARK:BTCUSD`; `symbol` here is the bare product symbol). */
export interface WsMark { symbol: string; markPrice: number; timeMs: number; bestBid: number | null; bestAsk: number | null }
/** `funding_rate` channel. Rates are Delta's percent-per-interval figures (0.01 = 0.01 % per 8 h). */
export interface WsFunding { symbol: string; ratePct: number; predictedRatePct: number | null; intervalSec: number; nextAt: number; timeMs: number }

/** Channels whose subscription symbols carry a prefix on the wire. */
const WIRE_PREFIX: Record<string, string> = { mark_price: 'MARK:' };
const PREFIXES = new Set(Object.values(WIRE_PREFIX));
function toWire(channel: string, symbols: string[]): string[] { const p = WIRE_PREFIX[channel]; return p ? symbols.map(s => (s.startsWith(p) ? s : p + s)) : symbols; }
function fromWire(symbol: string): string { const i = symbol.indexOf(':'); return i > 0 && PREFIXES.has(symbol.slice(0, i + 1)) ? symbol.slice(i + 1) : symbol; }
/** Delta timestamps are epoch microseconds on the socket; normalise anything that looks like µs/ms/s to ms. */
export function toMs(ts: unknown, fallback = Date.now()): number {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  if (n > 1e15) return Math.floor(n / 1000);   // µs
  if (n > 1e12) return Math.floor(n);          // ms
  return Math.floor(n * 1000);                 // s
}

/**
 * Delta Exchange public websocket feed with auto-reconnect and subscription replay.
 * Emits: 'candle' (WsCandle), 'ticker' (WsTicker), 'trade' (WsTrade, live prints only),
 * 'tradeSnapshot' ({symbol, trades: WsTrade[]}), 'mark' (WsMark), 'funding' (WsFunding), 'status' ({connected}).
 */
export class DeltaFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string;
  private subs = new Map<string, Set<string>>(); // channel -> symbols
  private closed = false;
  private reconnectDelay = 1000;
  private lastMessageAt = 0;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private quoteSeen = new Map<string, number>();
  private protocol: 'compact' | 'legacy';
  connected = false;

  constructor(url = DELTA_INDIA_WS, protocol?: 'compact' | 'legacy') {
    super();
    this.url = url;
    this.protocol = protocol ?? (url === DELTA_INDIA_LEGACY_WS || url === 'wss://socket-ind.testnet.deltaex.org' ? 'legacy' : 'compact');
    for (const channel of GLOBAL_CHANNELS) this.subs.set(channel, new Set());
  }

  get endpoint(): string { return this.url; }

  get lastTickAt(): number { return this.lastMessageAt; }

  get subscriptions(): string[] {
    const out: string[] = [];
    for (const [ch, syms] of this.subs) for (const s of syms) out.push(`${s}:${ch}`);
    return out;
  }

  start(): void {
    if (this.hbTimer) return;
    this.closed = false;
    this.connect();
    this.hbTimer = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.lastMessageAt > 60_000) {
        // decision 184: a dead TCP connection never completes a close handshake; drop it and reconnect now
        log.warn('no messages for 60s, reconnecting');
        const dead = this.ws; this.ws = null;
        this.connected = false; this.emit('status', { connected: false });
        try { (dead as any)?.terminate?.(); dead?.close?.(); } catch { /* already gone */ }
        this.scheduleReconnect();
      } else {
        try { this.ws?.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
        this.refreshSilentQuotes();
      }
    }, 20_000);
  }

  stop(): void {
    this.closed = true;
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws; this.ws = null;
    this.connected = false; this.quoteSeen.clear();
    ws?.close();
    this.emit('status', { connected: false });
  }

  subscribe(channel: string, symbols: string[]): void {
    const isNew = !this.subs.has(channel);
    const set = this.subs.get(channel) ?? new Set<string>();
    const fresh = symbols.filter(s => !set.has(s));
    for (const s of symbols) set.add(s);
    if (channel === 'ob_l1') for (const s of fresh) this.quoteSeen.set(s, Date.now());
    this.subs.set(channel, set);
    if ((fresh.length || (isNew && GLOBAL_CHANNELS.has(channel))) && this.connected) this.send({ type: 'subscribe', payload: { channels: [this.wireChannel(channel, fresh)] } });
  }

  unsubscribe(channel: string, symbols: string[]): void {
    const set = this.subs.get(channel);
    if (!set) return;
    for (const s of symbols) set.delete(s);
    if (channel === 'ob_l1') for (const s of symbols) this.quoteSeen.delete(s);
    if (this.connected) this.send({ type: 'unsubscribe', payload: { channels: [this.wireChannel(channel, symbols)] } });
  }

  /** Replace all subscriptions so exactly `wanted` (channel → symbols) remain. */
  setSubscriptions(wanted: Record<string, string[]>): void {
    for (const [ch, syms] of this.subs) {
      const keep = new Set(wanted[ch] ?? []);
      const drop = [...syms].filter(s => !keep.has(s));
      if (drop.length) this.unsubscribe(ch, drop);
    }
    for (const [ch, syms] of Object.entries(wanted)) this.subscribe(ch, syms);
  }

  private wireChannel(name: string, symbols: string[]) {
    const wireName = this.protocol === 'compact' ? ({ 'v2/ticker': 'ticker', all_trades: 'trades' }[name] ?? name) : name;
    return GLOBAL_CHANNELS.has(name) ? { name: wireName } : { name: wireName, symbols: toWire(name, symbols) };
  }

  private send(obj: unknown) {
    try { this.ws?.send(JSON.stringify(obj)); } catch (e) { log.warn('send failed', String(e)); }
  }

  private connect() {
    if (this.closed) return;
    log.info(`connecting ${this.url}`);
    let ws: WebSocket;
    try { ws = new WebSocket(this.url); } catch (e) { log.error('ws ctor failed', String(e)); this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws || this.closed) return;
      this.connected = true; this.reconnectDelay = 1000; this.lastMessageAt = Date.now();
      for (const s of this.subs.get('ob_l1') ?? []) this.quoteSeen.set(s, Date.now());
      log.info('connected');
      this.emit('status', { connected: true });
      const channels = [...this.subs.entries()].filter(([name, s]) => s.size || GLOBAL_CHANNELS.has(name)).map(([name, s]) => this.wireChannel(name, [...s]));
      if (channels.length) this.send({ type: 'subscribe', payload: { channels } });
      this.send({ type: 'enable_heartbeat' });
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws || this.closed) return;
      this.lastMessageAt = Date.now();
      let msg: any;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      for (const normalized of normalizePublicMessage(msg)) this.handle(normalized);
    };
    ws.onerror = (ev: any) => { log.warn('socket error', ev?.message ?? ''); };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const was = this.connected;
      this.connected = false;
      if (was) { log.warn('disconnected'); this.emit('status', { connected: false }); }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const d = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, d);
  }

  /** A heartbeat on another channel must not hide a stalled L1 subscription. */
  private refreshSilentQuotes(now = Date.now()) {
    const stale = [...(this.subs.get('ob_l1') ?? [])].filter(s => now - (this.quoteSeen.get(s) ?? 0) > 15_000);
    if (!stale.length) return;
    this.emit('quoteGap', { symbols: stale, at: now });
    this.send({ type: 'unsubscribe', payload: { channels: [this.wireChannel('ob_l1', stale)] } });
    this.send({ type: 'subscribe', payload: { channels: [this.wireChannel('ob_l1', stale)] } });
    for (const s of stale) this.quoteSeen.set(s, now);
  }

  private handle(msg: any) {
    const type: string = msg?.type ?? '';
    if (type === 'ob_l1') {
      const q = parseQuote(msg);
      if (q) { if (q.receivedAt - q.timeMs <= 10_000) this.quoteSeen.set(q.symbol, q.receivedAt); this.emit('quote', q); }
      return;
    }
    if (type === 'ob_updates') { this.emit('depth', msg); return; }
    if (type.startsWith('candlestick_')) {
      const c: WsCandle = {
        symbol: msg.symbol,
        resolution: msg.resolution ?? type.slice('candlestick_'.length),
        candleStartMs: Math.floor(Number(msg.candle_start_time) / 1000),
        open: Number(msg.open), high: Number(msg.high), low: Number(msg.low), close: Number(msg.close), volume: Number(msg.volume ?? 0),
        updatedMs: Math.floor(Number(msg.last_updated ?? msg.timestamp ?? Date.now() * 1000) / 1000),
      };
      if (Number.isFinite(c.candleStartMs) && Number.isFinite(c.close)) this.emit('candle', c);
      return;
    }
    if (type === 'v2/ticker') {
      const q = msg.quotes ?? {};
      const t: WsTicker = {
        symbol: msg.symbol,
        price: Number(msg.close ?? msg.mark_price),
        markPrice: Number(msg.mark_price ?? msg.close),
        timeMs: Math.floor(Number(msg.timestamp ?? Date.now() * 1000) / 1000),
        bestBid: num(q.best_bid), bestAsk: num(q.best_ask),
      };
      if (Number.isFinite(t.price)) this.emit('ticker', t);
      return;
    }
    if (type === 'all_trades') {
      const t = parseTrade(msg.symbol, msg);
      if (t) this.emit('trade', t);
      return;
    }
    if (type === 'all_trades_snapshot') {
      const trades = (Array.isArray(msg.trades) ? msg.trades : []).map((x: any) => parseTrade(msg.symbol, x)).filter(Boolean) as WsTrade[];
      trades.sort((a, b) => a.timeMs - b.timeMs);
      this.emit('tradeSnapshot', { symbol: msg.symbol, trades });
      return;
    }
    if (type === 'mark_price') {
      const m: WsMark = { symbol: fromWire(String(msg.symbol ?? '')), markPrice: Number(msg.price), timeMs: toMs(msg.timestamp), bestBid: num(msg.best_bid), bestAsk: num(msg.best_ask) };
      if (m.symbol && Number.isFinite(m.markPrice) && m.markPrice > 0) this.emit('mark', m);
      return;
    }
    if (type === 'funding_rate') {
      const f: WsFunding = { symbol: String(msg.symbol ?? ''), ratePct: Number(msg.funding_rate), predictedRatePct: num(msg.predicted_funding_rate), intervalSec: Number(msg.funding_interval ?? 28800) || 28800, nextAt: toMs(msg.next_funding_realization, 0), timeMs: toMs(msg.timestamp) };
      if (f.symbol && Number.isFinite(f.ratePct)) this.emit('funding', f);
      return;
    }
    if (type === 'product_updates' || type === 'system_status') { this.emit(type, msg); return; }
    if (type === 'subscriptions') { log.debug('subscriptions ack', msg.channels); return; }
    if (type === 'error') { log.warn('feed error', msg); }
  }
}

function num(v: unknown): number | null { const n = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n; }

export function parseQuote(m: any, receivedAt = Date.now()): WsQuote | null {
  const symbol = typeof m?.sy === 'string' ? m.sy : '';
  const bid = num(m?.bp), ask = num(m?.ap), bidSize = num(m?.bs), askSize = num(m?.as);
  const timeMs = toMs(m?.ts, 0), bookTimeMs = toMs(m?.lts, 0);
  if (!symbol || bid === null || ask === null || bidSize === null || askSize === null ||
      bid <= 0 || ask < bid || bidSize <= 0 || askSize <= 0 || timeMs <= 0 || bookTimeMs <= 0 ||
      timeMs > receivedAt + 2000 || bookTimeMs > timeMs + 2000) return null;
  return { symbol, bestBid: bid, bestAsk: ask, bidSize, askSize, timeMs, bookTimeMs, receivedAt };
}

/** Parse one `all_trades` print (`price` is a string, `size` in contracts, `timestamp` in µs). */
export function parseTrade(symbol: string, x: any): WsTrade | null {
  const price = Number(x?.price), qty = Number(x?.size ?? x?.qty ?? 0);
  if (!symbol || !Number.isFinite(price) || price <= 0) return null;
  const aggressor: WsTrade['aggressor'] = x?.buyer_role === 'taker' ? 'buy' : x?.seller_role === 'taker' ? 'sell' : null;
  return { symbol: String(symbol), price, qty: Number.isFinite(qty) ? qty : 0, timeMs: toMs(x?.timestamp), aggressor };
}


/** Normalize the public compact schemas to the existing internal events; legacy payloads remain supported. */
export function normalizePublicMessage(m: any): any[] {
  if (!m || typeof m !== 'object') return [];
  if (m.type === 'ticker' && Array.isArray(m.d)) return m.d.map((t: any) => ({
    type: 'v2/ticker', symbol: t.s ?? m.sy, close: t.ohlc?.[3] ?? t.m, mark_price: t.m,
    timestamp: m.ts, quotes: { best_ask: t.q?.[0], best_bid: t.q?.[2] },
  }));
  if (m.type === 'trades') return [{ type: 'all_trades', symbol: m.sy, price: m.p, size: m.s,
    timestamp: m.t ?? m.ts, buyer_role: m.r === 't' ? 'taker' : 'maker', seller_role: m.r === 'm' ? 'taker' : 'maker' }];
  if (String(m.type).startsWith('candlestick_') && m.sy !== undefined) return [{
    type: m.type, symbol: m.sy, resolution: m.res, candle_start_time: m.cst,
    open: m.o, high: m.h, low: m.l, close: m.c, volume: m.v ?? 0, timestamp: m.ts,
  }];
  if (m.type === 'mark_price' && m.sy !== undefined) return [{ type: m.type, symbol: m.sy, price: m.p, timestamp: m.ts }];
  if (m.type === 'funding_rate' && m.sy !== undefined) return [{ type: m.type, symbol: m.sy, funding_rate: m.fr,
    funding_interval: m.fi, next_funding_realization: m.nfr, predicted_funding_rate: m.pfr, timestamp: m.ts }];
  return [m];
}
