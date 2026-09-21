import { EventEmitter } from 'node:events';
import { TF_SECONDS } from '../config.ts';
import type { DeltaRest, DeltaProduct } from '../delta/rest.ts';
import type { DeltaFeed, WsCandle, WsTicker } from '../delta/ws.ts';
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
  /** Highest bar time for which `closed` has been emitted (exactly-once guard). */
  lastClosedEmitted: number;
  /** Wall-clock time of the last `closed` emission (staleness checks). */
  lastClosedAt: number;
  loadedAt: number;
  /** Gap start times that REST could not fill (no trades on Delta → no candle); not retried or re-reported. */
  unfillable: Set<number>;
  backfilling: Promise<number> | null;
}

/** One integrity finding, also emitted as an `integrity` event. */
export interface IntegrityEvent {
  at: number;
  type: 'gap' | 'gap-filled' | 'gap-unfillable' | 'clock-drift' | 'delisted' | 'tick-size' | 'backfill-error';
  symbol?: string;
  tf?: string;
  /** Missing bar start times (ms) for gap events. */
  missing?: number[];
  filled?: number;
  driftMs?: number;
  detail?: string;
}

export interface IntegrityStatus {
  gapsFound: number;
  gapsFilled: number;
  gapsUnfillable: number;
  barsBackfilled: number;
  backfillErrors: number;
  /** Local clock minus exchange time (ms, positive = we are ahead); null until measured. */
  driftMs: number | null;
  driftCheckedAt: number | null;
  driftWarnings: number;
  delisted: string[];
  tickSizeChanges: number;
  symbolsCheckedAt: number | null;
  lastEvent: IntegrityEvent | null;
}

/**
 * Missing bar start times strictly between consecutive bars of a `tfMs` series. Bars are
 * expected ascending; out-of-order input is sorted first. Duplicates are ignored. A bar whose
 * time is not on the timeframe grid is snapped to the grid for the purpose of the check.
 */
export function findGaps(times: number[], tfMs: number, maxPerGap = 5000): number[] {
  if (!(tfMs > 0) || times.length < 2) return [];
  const sorted = [...new Set(times.map(t => Math.floor(t / tfMs) * tfMs))].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i];
    const n = Math.round((cur - prev) / tfMs) - 1;
    if (n <= 0) continue;
    for (let k = 1; k <= Math.min(n, maxPerGap); k++) out.push(prev + k * tfMs);
  }
  return out;
}

/** Normalise an exchange timestamp given in s, ms or µs to milliseconds. */
export function toMs(ts: number): number {
  if (!Number.isFinite(ts) || ts <= 0) return NaN;
  if (ts > 1e15) return Math.floor(ts / 1000);   // microseconds
  if (ts > 1e11) return Math.floor(ts);          // milliseconds
  return Math.floor(ts * 1000);                  // seconds
}

/**
 * In-memory OHLCV store per (symbol, timeframe). Backfills from REST, merges websocket
 * candle updates, and emits `bar` ({symbol, tf, bar, closed}) plus `closed` ({symbol, tf, bar})
 * exactly once per finished bar.
 *
 * Integrity (Phase 4): gaps between consecutive bars are detected on every bar close and after
 * a reconnect resync, backfilled from REST, and reported as `integrity` events; the local clock
 * is compared with exchange timestamps; tracked symbols are checked against `/v2/products`.
 */
export class CandleStore extends EventEmitter {
  private series = new Map<string, Series>();
  private rest: DeltaRest;
  private feed: DeltaFeed;
  private maxBars: number;
  private status: IntegrityStatus = { gapsFound: 0, gapsFilled: 0, gapsUnfillable: 0, barsBackfilled: 0, backfillErrors: 0, driftMs: null, driftCheckedAt: null, driftWarnings: 0, delisted: [], tickSizeChanges: 0, symbolsCheckedAt: null, lastEvent: null };
  private products = new Map<string, { tickSize: string; contractValue: string }>();
  private delisted = new Set<string>();
  private maintenance: ReturnType<typeof setInterval> | null = null;
  private lastDriftWarnAt = 0;
  driftWarnMs = 2000;

  constructor(rest: DeltaRest, feed: DeltaFeed, maxBars = 1500) {
    super();
    this.rest = rest; this.feed = feed; this.maxBars = maxBars;
    feed.on('candle', (c: WsCandle) => this.onWsCandle(c));
    feed.on('ticker', (t: WsTicker) => this.noteExchangeTime(t.timeMs, 'ws'));
  }

  static key(symbol: string, tf: string) { return `${symbol}:${tf}`; }

  setMaxBars(n: number) { this.maxBars = n; }

  has(symbol: string, tf: string): boolean { return this.series.get(CandleStore.key(symbol, tf))?.loaded ?? false; }

  /** Ensure a series is tracked and backfilled; subscribes the feed. */
  async track(symbol: string, tf: string, bars = this.maxBars): Promise<Bar[]> {
    const key = CandleStore.key(symbol, tf);
    let s = this.series.get(key);
    if (!s) {
      s = { symbol, tf, bars: [], loaded: false, loading: null, maxBars: bars, lastClosedEmitted: 0, lastClosedAt: 0, loadedAt: 0, unfillable: new Set(), backfilling: null };
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

  tracked(): Array<{ symbol: string; tf: string; bars: number; loaded: boolean; lastBarTime: number | null; lastClosedAt: number | null; loadedAt: number | null }> {
    return [...this.series.values()].map(s => ({ symbol: s.symbol, tf: s.tf, bars: s.bars.length, loaded: s.loaded, lastBarTime: s.bars.at(-1)?.time ?? null, lastClosedAt: s.lastClosedAt || null, loadedAt: s.loadedAt || null }));
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

  /** Fetch any bars newer than what we hold (used after reconnects), then scan the series for gaps and fill them. */
  async resync(symbol: string, tf: string): Promise<number> {
    const s = this.series.get(CandleStore.key(symbol, tf));
    if (!s || !s.loaded) return 0;
    const last = s.bars.at(-1);
    const secs = TF_SECONDS[tf];
    const startSec = last ? Math.floor(last.time / 1000) - secs : Math.floor(Date.now() / 1000) - secs * s.maxBars;
    const fresh = await this.rest.candles(symbol, tf, startSec, Math.floor(Date.now() / 1000));
    let n = 0;
    for (const c of fresh) if (this.merge(s, { time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }, 'rest')) n++;
    // bars that closed while we were disconnected never had their close announced: announce the newest one so scanners re-run
    if (n) this.announceLatestClosed(s);
    n += await this.checkGaps(s, 'resync');
    return n;
  }

  // ---- integrity ----

  integrity(): IntegrityStatus { return { ...this.status, delisted: [...this.delisted] }; }

  /** Gaps currently present in a tracked series (pure inspection, no backfill). */
  gapsIn(symbol: string, tf: string): number[] {
    const s = this.series.get(CandleStore.key(symbol, tf));
    return s ? findGaps(s.bars.map(b => b.time), TF_SECONDS[tf] * 1000) : [];
  }

  /**
   * Detect and backfill missing bars in a series. Only one backfill runs per series at a time;
   * gap times REST cannot supply are remembered as unfillable so they are reported once.
   * Returns the number of bars inserted.
   */
  async checkGaps(s: Series, reason: string): Promise<number> {
    if (s.backfilling) return s.backfilling;
    const tfMs = TF_SECONDS[s.tf] * 1000;
    const missing = findGaps(s.bars.map(b => b.time), tfMs).filter(t => !s.unfillable.has(t));
    if (!missing.length) return 0;
    this.status.gapsFound += missing.length;
    this.report({ at: Date.now(), type: 'gap', symbol: s.symbol, tf: s.tf, missing: missing.slice(0, 50), detail: `${missing.length} missing bar(s) detected on ${reason}` });
    s.backfilling = this.backfillGaps(s, missing).finally(() => { s.backfilling = null; });
    return s.backfilling;
  }

  private async backfillGaps(s: Series, missing: number[]): Promise<number> {
    const startSec = Math.floor(missing[0] / 1000) - TF_SECONDS[s.tf];
    const endSec = Math.floor(missing[missing.length - 1] / 1000) + 2 * TF_SECONDS[s.tf];
    let inserted = 0;
    try {
      const fresh = await this.rest.candles(s.symbol, s.tf, startSec, Math.min(endSec, Math.floor(Date.now() / 1000)), missing.length + 10);
      const want = new Set(missing);
      const filledTimes: number[] = [];
      for (const c of fresh) {
        const t = c.time * 1000;
        if (!want.has(t)) continue;
        if (this.merge(s, { time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }, 'rest', true)) { inserted++; filledTimes.push(t); }
        want.delete(t);
      }
      for (const t of want) s.unfillable.add(t);
      if (s.unfillable.size > 500) s.unfillable = new Set([...s.unfillable].slice(-500));
      this.status.gapsFilled += inserted; this.status.barsBackfilled += inserted; this.status.gapsUnfillable += want.size;
      if (inserted) this.report({ at: Date.now(), type: 'gap-filled', symbol: s.symbol, tf: s.tf, filled: inserted, missing: filledTimes.slice(0, 50), detail: `backfilled ${inserted} bar(s) from REST` });
      if (want.size) this.report({ at: Date.now(), type: 'gap-unfillable', symbol: s.symbol, tf: s.tf, missing: [...want].slice(0, 50), detail: `${want.size} bar(s) not available from REST (no trades on the exchange in that period)` });
      // A filled bar that is now the newest closed bar never had its close announced: announce it once so scanners re-run on it.
      if (inserted) this.announceLatestClosed(s);
    } catch (e: any) {
      this.status.backfillErrors++;
      this.report({ at: Date.now(), type: 'backfill-error', symbol: s.symbol, tf: s.tf, detail: String(e?.message ?? e).slice(0, 200) });
    }
    return inserted;
  }

  /** Compare the local clock with an exchange timestamp in milliseconds (ws ticker, REST ticker). */
  noteExchangeTime(ms: number, source: 'ws' | 'rest') {
    if (!Number.isFinite(ms) || ms <= 0) return;
    const drift = Date.now() - ms;
    // network latency makes the exchange look "behind"; keep the value nearest zero over a short window
    const prev = this.status.driftMs;
    this.status.driftMs = prev === null || this.status.driftCheckedAt === null || Date.now() - this.status.driftCheckedAt > 60_000 || Math.abs(drift) < Math.abs(prev) ? drift : prev;
    this.status.driftCheckedAt = Date.now();
    if (Math.abs(this.status.driftMs) > this.driftWarnMs && Date.now() - this.lastDriftWarnAt > 300_000) {
      this.lastDriftWarnAt = Date.now(); this.status.driftWarnings++;
      this.report({ at: Date.now(), type: 'clock-drift', driftMs: this.status.driftMs, detail: `local clock is ${(this.status.driftMs / 1000).toFixed(2)}s ${this.status.driftMs > 0 ? 'ahead of' : 'behind'} Delta (${source})` });
    }
  }

  /** REST-based drift check (used when no websocket tickers arrive). */
  async checkClockDrift(): Promise<number | null> {
    const sym = [...this.series.values()][0]?.symbol ?? 'BTCUSD';
    try {
      const t0 = Date.now();
      const t = await this.rest.ticker(sym);
      const rtt = Date.now() - t0;
      const ms = toMs(Number(t?.timestamp));
      if (Number.isFinite(ms)) this.noteExchangeTime(ms + rtt / 2, 'rest'); // the server stamped it roughly half a round trip ago
    } catch (e: any) { log.debug(`clock check failed: ${e?.message ?? e}`); }
    return this.status.driftMs;
  }

  /** Symbol lifecycle: tracked symbols missing from `/v2/products` (delisted) or with a changed tick size. */
  async checkSymbols(): Promise<{ delisted: string[]; changed: string[] }> {
    const changed: string[] = [];
    let products: Map<string, DeltaProduct>;
    try { products = await this.rest.products(true); } catch (e: any) { log.debug(`product check failed: ${e?.message ?? e}`); return { delisted: [...this.delisted], changed }; }
    if (products.size === 0) return { delisted: [...this.delisted], changed };
    const symbols = new Set([...this.series.values()].map(s => s.symbol));
    for (const sym of symbols) {
      let p = products.get(sym);
      // the list endpoint is paged (200 per page); confirm with the single-product endpoint before calling anything delisted
      if (!p) { try { const single = await this.rest.product(sym); if (single && (single.state ?? 'live') === 'live') p = single; } catch { /* treat as missing */ } }
      if (!p) {
        if (!this.delisted.has(sym)) { this.delisted.add(sym); this.report({ at: Date.now(), type: 'delisted', symbol: sym, detail: `${sym} is no longer listed as a live perpetual on Delta` }); }
        continue;
      }
      if (this.delisted.delete(sym)) log.info(`${sym} is listed again`);
      const prev = this.products.get(sym);
      if (prev && (prev.tickSize !== String(p.tick_size) || prev.contractValue !== String(p.contract_value))) {
        changed.push(sym); this.status.tickSizeChanges++;
        this.report({ at: Date.now(), type: 'tick-size', symbol: sym, detail: `${sym} tick size ${prev.tickSize} → ${p.tick_size}, contract value ${prev.contractValue} → ${p.contract_value} (restart to apply)` });
      }
      this.products.set(sym, { tickSize: String(p.tick_size), contractValue: String(p.contract_value) });
    }
    this.status.symbolsCheckedAt = Date.now();
    return { delisted: [...this.delisted], changed };
  }

  /** Periodic integrity work: gap scan of every series, REST clock check, symbol lifecycle. */
  startMaintenance(opts: { intervalMs?: number; driftWarnMs?: number } = {}) {
    this.stopMaintenance();
    if (opts.driftWarnMs) this.driftWarnMs = opts.driftWarnMs;
    let ticks = 0;
    this.maintenance = setInterval(() => {
      ticks++;
      for (const s of this.series.values()) if (s.loaded) void this.checkGaps(s, 'periodic scan').catch(() => { /* reported inside */ });
      if (ticks % 2 === 1 && (this.status.driftCheckedAt === null || Date.now() - this.status.driftCheckedAt > 120_000)) void this.checkClockDrift();
      if (ticks % 10 === 1) void this.checkSymbols();
    }, opts.intervalMs ?? 60_000);
    this.maintenance.unref();
  }

  stopMaintenance() { if (this.maintenance) { clearInterval(this.maintenance); this.maintenance = null; } }

  private report(ev: IntegrityEvent) {
    this.status.lastEvent = ev;
    const line = `${ev.type} ${ev.symbol ?? ''} ${ev.tf ?? ''}: ${ev.detail ?? ''}`.replace(/\s+/g, ' ').trim();
    if (ev.type === 'gap-filled') log.info(line); else if (ev.type === 'gap') log.warn(line); else log.warn(line);
    this.emit('integrity', ev);
  }

  /** Emit `closed` for the newest closed bar of a series unless it was already announced. */
  private announceLatestClosed(s: Series) {
    if (!s.loaded) return;
    for (let i = s.bars.length - 1; i >= 0; i--) {
      if (this.isClosed(s.tf, s.bars[i].time)) { this.emitClosed(s, s.bars[i]); return; }
    }
  }

  private emitClosed(s: Series, bar: Bar) {
    if (bar.time <= s.lastClosedEmitted) return;
    s.lastClosedEmitted = bar.time; s.lastClosedAt = Date.now();
    this.emit('closed', { symbol: s.symbol, tf: s.tf, bar: { ...bar } });
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
    s.loaded = true; s.loadedAt = Date.now();
    // history already ends in closed bars; never announce those again
    const lastClosedInHistory = [...s.bars].reverse().find(b => this.isClosed(s.tf, b.time));
    if (lastClosedInHistory) s.lastClosedEmitted = Math.max(s.lastClosedEmitted, lastClosedInHistory.time);
    log.info(`backfilled ${s.symbol} ${s.tf}: ${s.bars.length} bars (${new Date(s.bars[0]?.time ?? 0).toISOString().slice(0, 16)} → now)`);
    this.emit('loaded', { symbol: s.symbol, tf: s.tf, bars: s.bars.length });
    const gaps = findGaps(s.bars.map(b => b.time), secs * 1000);
    if (gaps.length) void this.checkGaps(s, 'initial backfill').catch(() => { /* reported inside */ });
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
      // new bar started → previous bar is closed; a jump of more than one timeframe means bars are missing in between
      const announce = Boolean(last) && !quiet && s.loaded && source === 'ws';
      const jumped = Boolean(last) && s.loaded && bar.time - last!.time > TF_SECONDS[s.tf] * 1500;
      if (announce) this.emitClosed(s, last!);
      bars.push(bar);
      if (bars.length > s.maxBars + 50) bars.splice(0, bars.length - s.maxBars);
      if (!quiet && s.loaded) this.emit('bar', { symbol: s.symbol, tf: s.tf, bar: { ...bar }, closed: false });
      if (jumped && !quiet) void this.checkGaps(s, 'bar close').catch(() => { /* reported inside */ });
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
