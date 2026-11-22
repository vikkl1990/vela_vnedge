/**
 * The market as it was when a trade opened, kept with the trade.
 *
 * Shadow positions carried no entry features, so every later question of the form "did longs taken in a falling market do
 * worse?" had to rebuild each entry's state from candles. The enricher (decision 108) does that for the bars still in memory
 * and keeps 6,000 results; the shadow book alone closes about 480 trades a day. This records the state once, at the moment a
 * position opens, for both books: the trade's own features (the engine's, when it carried them, else the same arithmetic on
 * the bars closed at the entry), and a market block (BTC and ETH bias, funding skew, session, and BTC's own trend when those
 * bars are tracked).
 *
 * It only observes. It never changes a decision, a size or a fill, and a failure here is counted and logged, never thrown.
 */
import type { Bar } from '../data/candleStore.ts';
import type { Db } from '../db.ts';
import { lastAtr } from '../data/indicators.ts';
import type { GlobalContext } from '../context/collector.ts';
import { TF_SECONDS } from '../config.ts';
import { logger } from '../log.ts';
import { ema, type Features } from './features.ts';
import type { FeatureEnricher } from './enrich.ts';

const log = logger.scoped('entry-state');

export const ENTRY_STATE_VERSION = 1;
/** Rows older than this go; positions and trades are kept separately and much longer. */
export const ENTRY_STATE_KEEP_MS = 180 * 86_400_000;
const PRUNE_EVERY_MS = 6 * 3_600_000;
/** The context collector's global row is read from the database; once a minute is plenty for an hourly record. */
const CTX_CACHE_MS = 60_000;
const SEEN_MAX = 20_000;

/** Where the trade's own features came from. `none` rows are kept so coverage can be measured. */
export type FeaturesFrom = 'engine' | 'bars' | 'none';

export interface MarketState {
  /** When the context collector's record was taken, and how old it was at the entry (minutes). */
  ctxAt: number | null;
  ctxAgeMin: number | null;
  session: string | null;
  /** −1, 0 or +1: the collector's reading of BTC and ETH against their own trend on 4h and 1d. */
  btcBiasH4: number | null;
  btcBiasD1: number | null;
  ethBiasH4: number | null;
  ethBiasD1: number | null;
  /** Fleet-average funding, percent per interval: positive means longs pay, the crowd is long. */
  fundingSkewPct: number | null;
  /** BTC against its EMA50 in ATRs on the closed 1h and 4h bars before the entry; null when those bars are not tracked. */
  btcH1Trend50: number | null;
  btcH4Trend50: number | null;
  /** BTC's move over the 24 closed 1h bars before the entry, percent. */
  btcRet24h: number | null;
}

export interface EntryStatePosition {
  id: number;
  symbol: string;
  tf: string;
  side: string;
  entryAt: number;
  entryPrice: number;
  sl?: number | null;
  tp?: number[] | null;
  levelsSource?: string | null;
  features?: Record<string, number> | null;
}

export interface EntryStateRow {
  positionId: number;
  book: number;
  scannerId: string;
  symbol: string;
  tf: string;
  side: string;
  entryAt: number;
  features: Record<string, number> | null;
  featuresFrom: FeaturesFrom;
  missing: string | null;
  market: MarketState;
  /** The outcome, when the position has closed: net R and why it ended. */
  status: string;
  exitAt: number | null;
  exitReason: string | null;
  r: number | null;
}

export interface EntryStateQuery {
  book: number;
  from?: number;
  to?: number;
  symbol?: string;
  side?: string;
  limit?: number;
}

interface Deps {
  db: Db;
  enricher: Pick<FeatureEnricher, 'compute'>;
  candles: { get(symbol: string, tf: string, opts: { to?: number; limit?: number; closedOnly?: boolean }): Bar[] };
  /** The latest global market context, or null when there is none yet. */
  context: () => GlobalContext | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Distance from the EMA50 in ATRs at the last bar, or null without enough closed bars. */
export function trendInAtr(bars: Bar[], len = 50): number | null {
  if (bars.length < len + 15) return null;
  const i = bars.length - 1;
  const e = ema(bars, i, len);
  const atr = lastAtr(bars, 14);
  if (e === undefined || !atr || !(atr > 0)) return null;
  return (bars[i].close - e) / atr;
}

export class EntryStateRecorder {
  private d: Deps;
  private seen = new Set<number>();
  private ctxCache: { at: number; value: GlobalContext | null } | null = null;
  private lastPrune = 0;
  private failedCount = 0;
  private lastError: string | null = null;

  constructor(d: Deps) {
    this.d = d;
    d.db.db.exec(`CREATE TABLE IF NOT EXISTS entry_state (
      position_id INTEGER PRIMARY KEY, book INTEGER NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL, side TEXT NOT NULL,
      entry_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL, features TEXT, features_from TEXT NOT NULL, missing TEXT,
      market TEXT NOT NULL, version INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_entry_state_book_at ON entry_state(book, entry_at);`);
  }

  private market(entryAt: number): MarketState {
    const now = Date.now();
    if (!this.ctxCache || now - this.ctxCache.at > CTX_CACHE_MS) {
      let value: GlobalContext | null = null;
      try { value = this.d.context(); } catch { /* no context is a valid, recorded state */ }
      this.ctxCache = { at: now, value };
    }
    // The collector only supplies its latest record. In particular a restart may
    // recover old positions: today's context must never be assigned to their entry.
    const candidate = this.ctxCache.value;
    const g = candidate && Number.isSafeInteger(candidate.at) && candidate.at >= 0 && candidate.at <= entryAt ? candidate : null;
    const btcBars = (tf: string, tfMs: number, limit: number) => {
      try { return this.d.candles.get('BTCUSD', tf, { to: entryAt - tfMs, closedOnly: true, limit }); } catch { return []; }
    };
    const h1 = btcBars('1h', 3_600_000, 260), h4 = btcBars('4h', 14_400_000, 260);
    const ret24 = h1.length >= 25 ? (h1[h1.length - 1].close / h1[h1.length - 25].close - 1) * 100 : null;
    return {
      ctxAt: g ? num(g.at) : null,
      ctxAgeMin: g && num(g.at) !== null ? Math.round((entryAt - g.at) / 60_000) : null,
      session: g?.session ?? null,
      btcBiasH4: num(g?.bias?.BTC?.h4), btcBiasD1: num(g?.bias?.BTC?.d1),
      ethBiasH4: num(g?.bias?.ETH?.h4), ethBiasD1: num(g?.bias?.ETH?.d1),
      fundingSkewPct: num(g?.fundingSkewPct),
      btcH1Trend50: trendInAtr(h1), btcH4Trend50: trendInAtr(h4), btcRet24h: ret24,
    };
  }

  /** Record one newly opened position. Idempotent, and it never throws. */
  record(book: number, pos: EntryStatePosition): void {
    try {
      if (this.seen.has(pos.id)) return;
      if (this.d.db.get('SELECT 1 FROM entry_state WHERE position_id=?', pos.id)) { this.remember(pos.id); return; }
      let features: Features | Record<string, number> | null = null;
      let from: FeaturesFrom = 'none';
      let missing: string | null = null;
      if (pos.features && Object.keys(pos.features).length) { features = pos.features; from = 'engine'; }
      else {
        features = this.d.enricher.compute({ book, id: pos.id, symbol: pos.symbol, tf: pos.tf, side: pos.side, entryAt: pos.entryAt, entryPrice: pos.entryPrice, sl: pos.sl ?? null, tp: pos.tp ?? null, levelsSource: pos.levelsSource ?? null });
        if (features) from = 'bars';
        else missing = TF_SECONDS[pos.tf] === undefined ? 'unknown timeframe' : !(typeof pos.sl === 'number' && pos.sl > 0) ? 'no stop to measure from' : 'too few closed bars in the store';
      }
      const now = Date.now();
      this.d.db.run('INSERT OR IGNORE INTO entry_state(position_id,book,symbol,tf,side,entry_at,recorded_at,features,features_from,missing,market,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        pos.id, book, pos.symbol, pos.tf, pos.side, pos.entryAt, now, features ? JSON.stringify(features) : null, from, missing, JSON.stringify(this.market(pos.entryAt)), ENTRY_STATE_VERSION);
      this.remember(pos.id);
      if (now - this.lastPrune > PRUNE_EVERY_MS) { this.lastPrune = now; this.prune(now); }
    } catch (e: any) {
      this.failedCount++;
      this.lastError = String(e?.message ?? e).slice(0, 200);
      log.warn(`entry state not recorded for position ${pos.id}: ${this.lastError}`);
    }
  }

  private remember(id: number) {
    if (this.seen.size >= SEEN_MAX) this.seen.clear();
    this.seen.add(id);
  }

  prune(now = Date.now()): number {
    try { return Number(this.d.db.run('DELETE FROM entry_state WHERE entry_at < ?', now - ENTRY_STATE_KEEP_MS).changes ?? 0); } catch { return 0; }
  }

  /** The recorded own-features of a trade, or null. */
  featuresOf(positionId: number): Record<string, number> | null {
    try {
      const r = this.d.db.get<{ features: string | null }>('SELECT features FROM entry_state WHERE position_id=?', positionId);
      return r?.features ? (JSON.parse(r.features) as Record<string, number>) : null;
    } catch { return null; }
  }

  list(q: EntryStateQuery): EntryStateRow[] {
    const where = ['e.book=?'], args: (string | number)[] = [q.book];
    if (q.from !== undefined) { where.push('e.entry_at>=?'); args.push(q.from); }
    if (q.to !== undefined) { where.push('e.entry_at<?'); args.push(q.to); }
    if (q.symbol) { where.push('e.symbol=?'); args.push(q.symbol); }
    if (q.side) { where.push('e.side=?'); args.push(q.side); }
    const limit = Math.max(1, Math.min(5000, Math.trunc(q.limit ?? 1000)));
    const rows = this.d.db.all<any>(`SELECT e.position_id,e.book,e.symbol,e.tf,e.side,e.entry_at,e.features,e.features_from,e.missing,e.market,
      p.scanner_id,p.status,p.exit_at,p.exit_reason,p.realized_pnl,p.fees,p.risk_amount
      FROM entry_state e JOIN positions p ON p.id=e.position_id WHERE ${where.join(' AND ')} ORDER BY e.entry_at DESC LIMIT ?`, ...args, limit);
    return rows.map(r => ({
      positionId: r.position_id, book: r.book, scannerId: r.scanner_id, symbol: r.symbol, tf: r.tf, side: r.side, entryAt: r.entry_at,
      features: r.features ? JSON.parse(r.features) : null, featuresFrom: r.features_from, missing: r.missing, market: JSON.parse(r.market),
      status: r.status, exitAt: r.exit_at ?? null, exitReason: r.exit_reason ?? null,
      r: r.status === 'closed' && r.risk_amount > 0 ? (r.realized_pnl - r.fees) / r.risk_amount : null,
    }));
  }

  status(now = Date.now()) {
    const since = now - 86_400_000;
    const total = this.d.db.get<{ n: number; last: number | null }>('SELECT COUNT(*) n, MAX(recorded_at) last FROM entry_state');
    const byBook = this.d.db.all<{ book: number; from: string; n: number }>('SELECT book, features_from "from", COUNT(*) n FROM entry_state WHERE recorded_at>? GROUP BY book, features_from', since);
    const noCtx = this.d.db.get<{ n: number }>("SELECT COUNT(*) n FROM entry_state WHERE recorded_at>? AND json_extract(market,'$.ctxAt') IS NULL", since)?.n ?? 0;
    return { rows: total?.n ?? 0, lastRecordedAt: total?.last ?? null, last24h: byBook, last24hWithoutContext: noCtx, failed: this.failedCount, lastError: this.lastError, version: ENTRY_STATE_VERSION };
  }
}

/** Record every position either book opens. Listeners run after the book's transaction has committed. */
export function attachEntryState(engines: Array<{ book: number; on(event: string, fn: (e: any) => void): unknown }>, recorder: EntryStateRecorder): void {
  for (const engine of engines) engine.on('position', (e: any) => { if (e?.type === 'opened' && e.position) recorder.record(engine.book, e.position); });
}
