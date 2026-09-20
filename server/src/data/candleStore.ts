import { EventEmitter } from 'node:events';
import { TF_SECONDS } from '../config.ts';
import type { DeltaRest } from '../delta/rest.ts';
import type { DeltaFeed, WsCandle } from '../delta/ws.ts';
import { logger } from '../log.ts';

const log = logger.scoped('candles');

export interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number }

interface Series {
  symbol: string;
  tf: string;
  bars: Bar[];           // ascending; last bar may be forming
  loaded: boolean;
  loading: Promise<void> | null;
  maxBars: number;
}

/**
 * In-memory OHLCV store per (symbol, timeframe). Backfills from REST, merges websocket
 * candle updates, and emits `bar` ({symbol, tf, bar, closed}) plus `closed` ({symbol, tf, bar})
 * exactly once per finished bar.
 */
export class CandleStore extends EventEmitter {
  private series = new Map<string, Series>();
  private rest: DeltaRest;
  private feed: DeltaFeed;
  private maxBars: number;

  constructor(rest: DeltaRest, feed: DeltaFeed, maxBars = 1500) {
    super();
    this.rest = rest; this.feed = feed; this.maxBars = maxBars;
    feed.on('candle', (c: WsCandle) => this.onWsCandle(c));
  }

  static key(symbol: string, tf: string) { return `${symbol}:${tf}`; }

  setMaxBars(n: number) { this.maxBars = n; }

  has(symbol: string, tf: string): boolean { return this.series.get(CandleStore.key(symbol, tf))?.loaded ?? false; }

  /** Ensure a series is tracked and backfilled; subscribes the feed. */
  async track(symbol: string, tf: string, bars = this.maxBars): Promise<Bar[]> {
    const key = CandleStore.key(symbol, tf);
    let s = this.series.get(key);
    if (!s) {
      s = { symbol, tf, bars: [], loaded: false, loading: null, maxBars: bars };
      this.series.set(key, s);
      this.feed.subscribe(`candlestick_${tf}`, [symbol]);
    }
    s.maxBars = Math.max(s.maxBars, bars);
    if (!s.loaded) {
      if (!s.loading) s.loading = this.backfill(s).finally(() => { s!.loading = null; });
      await s.loading;
    }
    return s.bars;
  }

  untrack(symbol: string, tf: string) {
    const key = CandleStore.key(symbol, tf);
    if (this.series.delete(key)) this.feed.unsubscribe(`candlestick_${tf}`, [symbol]);
  }

  tracked(): Array<{ symbol: string; tf: string; bars: number; loaded: boolean }> {
    return [...this.series.values()].map(s => ({ symbol: s.symbol, tf: s.tf, bars: s.bars.length, loaded: s.loaded }));
  }

  /** Ascending bars (copy). `closedOnly` drops the forming bar. */
  get(symbol: string, tf: string, opts: { limit?: number; from?: number; to?: number; closedOnly?: boolean } = {}): Bar[] {
    const s = this.series.get(CandleStore.key(symbol, tf));
    if (!s) return [];
    let bars = s.bars;
    if (opts.closedOnly) bars = bars.filter(b => this.isClosed(tf, b.time));
    if (opts.from !== undefined) bars = bars.filter(b => b.time >= opts.from!);
    if (opts.to !== undefined) bars = bars.filter(b => b.time <= opts.to!);
    if (opts.limit !== undefined && bars.length > opts.limit) bars = bars.slice(-opts.limit);
    return bars.map(b => ({ ...b }));
  }

  lastPrice(symbol: string): number | undefined {
    for (const s of this.series.values()) if (s.symbol === symbol && s.tf === '1m' && s.bars.length) return s.bars.at(-1)!.close;
    for (const s of this.series.values()) if (s.symbol === symbol && s.bars.length) return s.bars.at(-1)!.close;
    return undefined;
  }

  isClosed(tf: string, barTime: number, now = Date.now()): boolean {
    return barTime + TF_SECONDS[tf] * 1000 <= now;
  }

  /** Fetch any bars newer than what we hold (used after reconnects). */
  async resync(symbol: string, tf: string): Promise<number> {
    const s = this.series.get(CandleStore.key(symbol, tf));
    if (!s || !s.loaded) return 0;
    const last = s.bars.at(-1);
    const secs = TF_SECONDS[tf];
    const startSec = last ? Math.floor(last.time / 1000) - secs : Math.floor(Date.now() / 1000) - secs * s.maxBars;
    const fresh = await this.rest.candles(symbol, tf, startSec, Math.floor(Date.now() / 1000));
    let n = 0;
    for (const c of fresh) if (this.merge(s, { time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }, 'rest')) n++;
    return n;
  }

  private async backfill(s: Series): Promise<void> {
    const secs = TF_SECONDS[s.tf];
    if (!secs) throw new Error(`unsupported timeframe ${s.tf}`);
    const list = await this.rest.recentCandles(s.symbol, s.tf, s.maxBars, secs);
    const bars: Bar[] = list.map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    // merge with anything the websocket delivered while we were loading
    const existing = s.bars;
    s.bars = bars;
    for (const b of existing) this.merge(s, b, 'ws', true);
    s.loaded = true;
    log.info(`backfilled ${s.symbol} ${s.tf}: ${s.bars.length} bars (${new Date(s.bars[0]?.time ?? 0).toISOString().slice(0, 16)} → now)`);
    this.emit('loaded', { symbol: s.symbol, tf: s.tf, bars: s.bars.length });
  }

  private onWsCandle(c: WsCandle) {
    const s = this.series.get(CandleStore.key(c.symbol, c.resolution));
    if (!s) return;
    const bar: Bar = { time: c.candleStartMs, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    this.merge(s, bar, 'ws');
  }

  /**
   * Insert/replace a bar. Returns true if the series changed. Emits `bar` for the
   * updated bar and `closed` for the previous bar when a newer bar first appears.
   */
  private merge(s: Series, bar: Bar, source: 'ws' | 'rest', quiet = false): boolean {
    const bars = s.bars;
    const last = bars.at(-1);
    if (!last || bar.time > last.time) {
      // new bar started → previous bar is closed
      if (last && !quiet && s.loaded && source === 'ws') {
        // The websocket's last update for the old bar is its final state.
        this.emit('closed', { symbol: s.symbol, tf: s.tf, bar: { ...last } });
      }
      bars.push(bar);
      if (bars.length > s.maxBars + 50) bars.splice(0, bars.length - s.maxBars);
      if (!quiet && s.loaded) this.emit('bar', { symbol: s.symbol, tf: s.tf, bar: { ...bar }, closed: false });
      return true;
    }
    if (bar.time === last.time) {
      if (source === 'ws' && s.loaded) {
        // keep the running extremes in case an update arrives out of order
        bar.high = Math.max(bar.high, last.high); bar.low = Math.min(bar.low, last.low);
      }
      bars[bars.length - 1] = bar;
      if (!quiet && s.loaded) this.emit('bar', { symbol: s.symbol, tf: s.tf, bar: { ...bar }, closed: false });
      return true;
    }
    // older bar: binary insert/replace
    let lo = 0, hi = bars.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].time === bar.time) { if (source === 'rest') bars[mid] = bar; return source === 'rest'; }
      if (bars[mid].time < bar.time) lo = mid + 1; else hi = mid - 1;
    }
    bars.splice(lo, 0, bar);
    return true;
  }
}
