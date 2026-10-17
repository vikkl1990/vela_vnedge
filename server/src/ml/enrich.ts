/**
 * Entry-time features for a trade that was opened without them.
 *
 * The live book has carried features and a probability on every entry since the model existed; the
 * shadow book did not until decision 108, and that book is where the out-of-sample evidence is (its
 * trades never train the model). For those trades the same features are computed after the fact from
 * the closed bars the candle store still holds up to the entry bar — the same arithmetic the engine
 * ran at entry, on the same bars, with the trade's own entry and stop. Cached per position in the kv
 * table so a trade is costed once. A trade whose bars have left the store stays unscored and is
 * counted as such; nothing is guessed.
 */
import { TF_SECONDS } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';
import { lastAtr } from '../data/indicators.ts';
import type { Db } from '../db.ts';
import { computeFeatures, type Features } from './features.ts';

export interface EnrichTrade {
  book: number; id: number; symbol: string; tf: string; side: string; entryAt: number; entryPrice: number;
  sl?: number | null; tp?: number[] | null; levelsSource?: string | null; features?: Record<string, number> | null;
}
type Cache = Record<string, { f: Features | null; at: number }>;

export const ENRICH_KV = 'ml.enriched';
/** Fewer closed bars than this and the slow features (EMA200, the day-range average) are not the ones the engine would have seen. */
export const MIN_BARS = 220;
const MAX_CACHE = 6000;

export class FeatureEnricher {
  private cache: Cache;
  private dirty = false;
  private db: Db;
  private candles: { get(symbol: string, tf: string, opts: { to?: number; limit?: number; closedOnly?: boolean }): Bar[] };

  constructor(db: Db, candles: FeatureEnricher['candles']) {
    this.db = db; this.candles = candles;
    this.cache = db.kvGet<Cache>(ENRICH_KV) ?? {};
  }

  /** The trade's own features when it carries them, else the cached or freshly computed ones; null when the bars are gone. */
  featuresFor(t: EnrichTrade): Features | null {
    if (t.features && Object.keys(t.features).length) return t.features as Features;
    const k = `${t.book}:${t.id}`;
    const hit = this.cache[k];
    if (hit) return hit.f;
    const f = this.compute(t);
    this.cache[k] = { f, at: Date.now() };
    this.dirty = true;
    return f;
  }

  /** Features from the bars closed at the entry, or null when the store no longer reaches back that far. */
  compute(t: EnrichTrade): Features | null {
    const tfMs = (TF_SECONDS[t.tf] ?? 900) * 1000;
    if (!Number.isFinite(t.entryAt) || !(t.entryPrice > 0) || (t.side !== 'long' && t.side !== 'short')) return null;
    // bars whose close is at or before the entry: open time ≤ entry − one bar
    const bars = this.candles.get(t.symbol, t.tf, { to: t.entryAt - tfMs, closedOnly: true, limit: 400 });
    if (bars.length < MIN_BARS) return null;
    const i = bars.length - 1;
    const atr = lastAtr(bars, 14);
    if (!atr || typeof t.sl !== 'number' || !(t.sl > 0)) return null;
    return computeFeatures({ bars, i, ev: { side: t.side, score: undefined, source: 'alert' }, entry: t.entryPrice, sl: t.sl, tp1: t.tp?.[0], atr, levelsSource: t.levelsSource ?? 'atr-fallback' });
  }

  /** How many trades have been costed, and how many of those had no bars left. */
  size(): { cached: number; unscorable: number } {
    const vals = Object.values(this.cache);
    return { cached: vals.length, unscorable: vals.filter(v => v.f === null).length };
  }

  /** Persist the cache when it changed; the oldest entries go first when it is full. */
  flush(): void {
    if (!this.dirty) return;
    const keys = Object.keys(this.cache);
    if (keys.length > MAX_CACHE) {
      for (const k of keys.sort((a, b) => this.cache[a].at - this.cache[b].at).slice(0, keys.length - MAX_CACHE)) delete this.cache[k];
    }
    this.db.kvSet(ENRICH_KV, this.cache);
    this.dirty = false;
  }
}
