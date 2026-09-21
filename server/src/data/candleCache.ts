/**
 * SQLite-backed candle cache for deep history (validation / long backtests).
 *
 * Pages Delta REST backwards in `chunkBars` chunks (Delta serves at most ~4000 candles per
 * request), stores every bar in the `candles` table and serves later requests from disk, so
 * 60–90 days of 15m bars per symbol are fetched once. Requests for the same symbol run
 * sequentially with a small delay between chunks (rate-limit courtesy); different symbols
 * may overlap up to `concurrency`.
 *
 * Coverage invariant: fetched ranges are always adjacent to what is already stored, so the
 * stored range [min(time), max(time)] is contiguous (apart from exchange gaps). Missing head
 * (older) and tail (newer) ranges are fetched on demand. When the exchange returns nothing
 * for an older range the floor is remembered (kv) so it is not requested again.
 */
import type { Db } from '../db.ts';
import { TF_SECONDS } from '../config.ts';
import type { DeltaCandle } from '../delta/rest.ts';
import { logger } from '../log.ts';
import type { Bar } from './candleStore.ts';

const log = logger.scoped('candlecache');

export interface CandleRestLike { candles(symbol: string, resolution: string, startSec: number, endSec: number, maxBars?: number): Promise<DeltaCandle[]> }

export interface CandleCacheOptions {
  chunkBars?: number;
  delayMs?: number;
  concurrency?: number;
  now?: () => number;
}

export interface CacheProgress {
  symbol: string; tf: string;
  status: 'idle' | 'fetching' | 'done' | 'error';
  bars: number; from: number | null; to: number | null;
  /** Fetch progress of the current/last request. */
  chunks: number; fetched: number; requestedFrom: number | null; requestedTo: number | null;
  startedAt: number | null; finishedAt: number | null; error: string | null;
}

export type HistoryRange = number | { from: number; to?: number };

export class CandleCache {
  private db: Db;
  private rest: CandleRestLike;
  readonly chunkBars: number;
  readonly delayMs: number;
  private concurrency: number;
  private now: () => number;
  private progress = new Map<string, CacheProgress>();
  /** Per-symbol promise chain: requests for one symbol never overlap. */
  private chains = new Map<string, Promise<unknown>>();
  private active = 0;
  private waiters: Array<() => void> = [];
  /** Total REST requests issued (for tests and the status endpoint). */
  requests = 0;

  constructor(db: Db, rest: CandleRestLike, opts: CandleCacheOptions = {}) {
    this.db = db; this.rest = rest;
    this.chunkBars = Math.max(100, Math.min(4000, opts.chunkBars ?? 4000));
    this.delayMs = Math.max(0, opts.delayMs ?? 250);
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.now = opts.now ?? (() => Date.now());
    db.db.exec(`CREATE TABLE IF NOT EXISTS candles (
      symbol TEXT NOT NULL, tf TEXT NOT NULL, time INTEGER NOT NULL, o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL,
      PRIMARY KEY (symbol, tf, time)
    );`);
  }

  static key(symbol: string, tf: string) { return `${symbol}:${tf}`; }

  /** Stored coverage for a series (times in ms). */
  coverage(symbol: string, tf: string): { bars: number; from: number | null; to: number | null } {
    const r = this.db.get<{ n: number; mn: number | null; mx: number | null }>('SELECT COUNT(*) n, MIN(time) mn, MAX(time) mx FROM candles WHERE symbol=? AND tf=?', symbol, tf);
    return { bars: r?.n ?? 0, from: r?.mn ?? null, to: r?.mx ?? null };
  }

  /** Every series held in the cache with its coverage and fetch state. */
  status(): CacheProgress[] {
    const rows = this.db.all<{ symbol: string; tf: string; n: number; mn: number; mx: number }>('SELECT symbol, tf, COUNT(*) n, MIN(time) mn, MAX(time) mx FROM candles GROUP BY symbol, tf ORDER BY symbol, tf');
    const out = new Map<string, CacheProgress>();
    for (const r of rows) out.set(CandleCache.key(r.symbol, r.tf), { ...this.blankProgress(r.symbol, r.tf), bars: r.n, from: r.mn, to: r.mx });
    for (const [k, p] of this.progress) { const cov = out.get(k); out.set(k, { ...p, bars: cov?.bars ?? p.bars, from: cov?.from ?? p.from, to: cov?.to ?? p.to }); }
    return [...out.values()];
  }

  /** Bars stored for [from, to] (ms, inclusive), ascending. Serves only what is cached. */
  read(symbol: string, tf: string, from: number, to: number, limit?: number): Bar[] {
    const rows = this.db.all<any>('SELECT time, o, h, l, c, v FROM candles WHERE symbol=? AND tf=? AND time>=? AND time<=? ORDER BY time ASC', symbol, tf, from, to);
    const bars = rows.map(r => ({ time: r.time, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v }));
    return limit !== undefined && bars.length > limit ? bars.slice(-limit) : bars;
  }

  /**
   * Closed bars for a range: a bar count (newest N closed bars) or `{from, to}` in ms.
   * Fetches missing head/tail ranges from REST first, then serves from SQLite.
   */
  async getHistory(symbol: string, tf: string, range: HistoryRange): Promise<Bar[]> {
    const secs = TF_SECONDS[tf];
    if (!secs) throw new Error(`unsupported timeframe ${tf}`);
    const tfMs = secs * 1000;
    const lastClosed = Math.floor(this.now() / tfMs) * tfMs - tfMs;
    const to = Math.min(lastClosed, typeof range === 'number' ? lastClosed : (range.to ?? lastClosed));
    const from = typeof range === 'number' ? to - (Math.max(1, range) - 1) * tfMs : Math.floor(range.from / tfMs) * tfMs;
    if (from > to) return [];
    await this.ensure(symbol, tf, from, to);
    const bars = this.read(symbol, tf, from, to);
    return typeof range === 'number' ? bars.slice(-range) : bars;
  }

  /** Ensure [from, to] (ms) is cached; sequential per symbol. */
  ensure(symbol: string, tf: string, from: number, to: number): Promise<void> {
    const prev = this.chains.get(symbol) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.fill(symbol, tf, from, to));
    this.chains.set(symbol, next.catch(() => undefined));
    return next;
  }

  private blankProgress(symbol: string, tf: string): CacheProgress {
    return { symbol, tf, status: 'idle', bars: 0, from: null, to: null, chunks: 0, fetched: 0, requestedFrom: null, requestedTo: null, startedAt: null, finishedAt: null, error: null };
  }

  private prog(symbol: string, tf: string): CacheProgress {
    const k = CandleCache.key(symbol, tf);
    let p = this.progress.get(k);
    if (!p) { p = this.blankProgress(symbol, tf); this.progress.set(k, p); }
    return p;
  }

  private async fill(symbol: string, tf: string, from: number, to: number): Promise<void> {
    const tfMs = TF_SECONDS[tf] * 1000;
    const cov = this.coverage(symbol, tf);
    const floorKey = `candlecache.floor:${symbol}:${tf}`;
    const floor = this.db.kvGet<number>(floorKey);
    const ranges: Array<[number, number]> = [];
    if (cov.from === null || cov.to === null) ranges.push([from, to]);
    else {
      if (to > cov.to) ranges.push([cov.to + tfMs, to]);
      if (from < cov.from) ranges.push([from, cov.from - tfMs]);
    }
    const wanted = ranges.filter(([a, b]) => b >= a && !(floor !== undefined && b < floor));
    if (!wanted.length) return;
    const p = this.prog(symbol, tf);
    p.status = 'fetching'; p.error = null; p.startedAt = this.now(); p.finishedAt = null; p.chunks = 0; p.fetched = 0; p.requestedFrom = from; p.requestedTo = to;
    await this.acquire();
    try {
      for (const [a, b] of wanted) await this.fetchRange(symbol, tf, Math.max(a, floor ?? -Infinity), b, p);
      p.status = 'done';
    } catch (e: any) {
      p.status = 'error'; p.error = String(e?.message ?? e);
      log.warn(`fetch ${symbol} ${tf} failed: ${p.error}`);
      throw e;
    } finally {
      p.finishedAt = this.now();
      const c = this.coverage(symbol, tf); p.bars = c.bars; p.from = c.from; p.to = c.to;
      this.release();
    }
  }

  /** Page backwards from `to` to `from` (ms) in chunkBars-sized windows, storing as we go. */
  private async fetchRange(symbol: string, tf: string, from: number, to: number, p: CacheProgress): Promise<void> {
    const secs = TF_SECONDS[tf];
    const tfMs = secs * 1000;
    const startSec = Math.floor(from / 1000);
    let endSec = Math.floor((to + tfMs) / 1000) - 1; // include the bar that starts at `to`
    const nowSec = Math.floor(this.now() / 1000);
    endSec = Math.min(endSec, nowSec);
    let chunk = 0;
    while (endSec >= startSec) {
      const chunkStart = Math.max(startSec, endSec - secs * this.chunkBars + 1);
      if (chunk > 0 && this.delayMs) await sleep(this.delayMs);
      this.requests++;
      const list = await this.rest.candles(symbol, tf, chunkStart, endSec, this.chunkBars + 10);
      chunk++; p.chunks = chunk;
      const bars = list.filter(c => c.time * 1000 >= from && c.time * 1000 <= to && c.time <= nowSec);
      if (bars.length) { this.store(symbol, tf, bars); p.fetched += bars.length; }
      log.debug(`${symbol} ${tf} chunk ${chunk}: ${bars.length} bars (${new Date(chunkStart * 1000).toISOString().slice(0, 16)} → ${new Date(endSec * 1000).toISOString().slice(0, 16)})`);
      if (!list.length) {
        // nothing in this window: the exchange has no older data → remember the floor so it is not asked again
        this.db.kvSet(`candlecache.floor:${symbol}:${tf}`, (endSec + 1) * 1000);
        break;
      }
      const oldest = Math.min(...list.map(c => c.time));
      if (oldest <= chunkStart || chunkStart <= startSec) {
        if (chunkStart <= startSec) break;
        endSec = chunkStart - 1;
      } else {
        // the exchange returned fewer bars than the window: treat the oldest returned as the boundary
        endSec = oldest - 1;
      }
      if (chunk > 200) throw new Error('too many chunks');
    }
  }

  private store(symbol: string, tf: string, list: DeltaCandle[]) {
    const stmt = this.db.db.prepare('INSERT OR REPLACE INTO candles(symbol, tf, time, o, h, l, c, v) VALUES (?,?,?,?,?,?,?,?)');
    this.db.transaction(() => { for (const c of list) stmt.run(symbol, tf, c.time * 1000, c.open, c.high, c.low, c.close, c.volume); });
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) { this.active++; return Promise.resolve(); }
    return new Promise(resolve => this.waiters.push(() => { this.active++; resolve(); }));
  }
  private release() { this.active--; const w = this.waiters.shift(); if (w) w(); }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
