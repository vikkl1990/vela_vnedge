import { EventEmitter } from 'node:events';
import { exchangeTimeMs } from '../execution/shadow.ts';
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
export interface WsTicker { symbol: string; price: number; markPrice: number; timeMs: number; bid?: number; ask?: number }

/**
 * Delta Exchange public websocket feed with auto-reconnect and subscription replay.
 * Emits: 'candle' (WsCandle), 'ticker' (WsTicker), 'status' ({connected}).
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
    if (fresh.length && this.connected) this.send({ type: 'subscribe', payload: { channels: [{ name: channel, symbols: fresh }] } });
  }

  unsubscribe(channel: string, symbols: string[]): void {
    const set = this.subs.get(channel);
    if (!set) return;
    for (const s of symbols) set.delete(s);
    if (this.connected) this.send({ type: 'unsubscribe', payload: { channels: [{ name: channel, symbols }] } });
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
      const channels = [...this.subs.entries()].filter(([, s]) => s.size).map(([name, s]) => ({ name, symbols: [...s] }));
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
        timeMs: exchangeTimeMs(msg.timestamp),
        bid: Number(msg.quotes?.best_bid), ask: Number(msg.quotes?.best_ask),
      };
      if (Number.isFinite(t.price)) this.emit('ticker', t);
      return;
    }
    if (type === 'subscriptions') { log.debug('subscriptions ack', msg.channels); return; }
    if (type === 'error') { log.warn('feed error', msg); }
  }
}
