import { EventEmitter } from 'node:events';
import { logger } from '../log.ts';

const log = logger.scoped('delta.ws');

export const DELTA_INDIA_WS = 'wss://socket.india.delta.exchange';

export interface WsCandle {
  symbol: string;
  resolution: string; // '1m', '15m', ...
  candleStartMs: number;
  open: number; high: number; low: number; close: number; volume: number;
  updatedMs: number;
}
export interface WsTicker { symbol: string; price: number; markPrice: number; timeMs: number }
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
  connected = false;

  constructor(url = DELTA_INDIA_WS) {
    super();
    this.url = url;
  }

  get lastTickAt(): number { return this.lastMessageAt; }

  get subscriptions(): string[] {
    const out: string[] = [];
    for (const [ch, syms] of this.subs) for (const s of syms) out.push(`${s}:${ch}`);
    return out;
  }

  start(): void {
    this.closed = false;
    this.connect();
    this.hbTimer = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.lastMessageAt > 60_000) {
        log.warn('no messages for 60s, reconnecting');
        this.ws?.close();
      } else {
        try { this.ws?.send(JSON.stringify({ type: 'heartbeat' })); } catch { /* ignore */ }
      }
    }, 20_000);
  }

  stop(): void {
    this.closed = true;
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.ws?.close();
  }

  subscribe(channel: string, symbols: string[]): void {
    const set = this.subs.get(channel) ?? new Set<string>();
    const fresh = symbols.filter(s => !set.has(s));
    for (const s of symbols) set.add(s);
    this.subs.set(channel, set);
    if (fresh.length && this.connected) this.send({ type: 'subscribe', payload: { channels: [{ name: channel, symbols: toWire(channel, fresh) }] } });
  }

  unsubscribe(channel: string, symbols: string[]): void {
    const set = this.subs.get(channel);
    if (!set) return;
    for (const s of symbols) set.delete(s);
    if (this.connected) this.send({ type: 'unsubscribe', payload: { channels: [{ name: channel, symbols: toWire(channel, symbols) }] } });
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
      this.connected = true; this.reconnectDelay = 1000; this.lastMessageAt = Date.now();
      log.info('connected');
      this.emit('status', { connected: true });
      const channels = [...this.subs.entries()].filter(([, s]) => s.size).map(([name, s]) => ({ name, symbols: toWire(name, [...s]) }));
      if (channels.length) this.send({ type: 'subscribe', payload: { channels } });
      this.send({ type: 'enable_heartbeat' });
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      let msg: any;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      this.handle(msg);
    };
    ws.onerror = (ev: any) => { log.warn('socket error', ev?.message ?? ''); };
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      if (was) { log.warn('disconnected'); this.emit('status', { connected: false }); }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const d = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    setTimeout(() => this.connect(), d);
  }

  private handle(msg: any) {
    const type: string = msg?.type ?? '';
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
      const t: WsTicker = {
        symbol: msg.symbol,
        price: Number(msg.close ?? msg.mark_price),
        markPrice: Number(msg.mark_price ?? msg.close),
        timeMs: Math.floor(Number(msg.timestamp ?? Date.now() * 1000) / 1000),
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
    if (type === 'subscriptions') { log.debug('subscriptions ack', msg.channels); return; }
    if (type === 'error') { log.warn('feed error', msg); }
  }
}

function num(v: unknown): number | null { const n = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n; }

/** Parse one `all_trades` print (`price` is a string, `size` in contracts, `timestamp` in µs). */
export function parseTrade(symbol: string, x: any): WsTrade | null {
  const price = Number(x?.price), qty = Number(x?.size ?? x?.qty ?? 0);
  if (!symbol || !Number.isFinite(price) || price <= 0) return null;
  const aggressor: WsTrade['aggressor'] = x?.buyer_role === 'taker' ? 'buy' : x?.seller_role === 'taker' ? 'sell' : null;
  return { symbol: String(symbol), price, qty: Number.isFinite(qty) ? qty : 0, timeMs: toMs(x?.timestamp), aggressor };
}
