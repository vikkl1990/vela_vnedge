import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import type { Bar } from '../data/candleStore.ts';
import { ENRICH_KV, FeatureEnricher, MIN_BARS } from './enrich.ts';

const TF = 900_000;
/** A gently trending 15m series starting at `t0`. */
function bars(n: number, t0: number): Bar[] {
  return Array.from({ length: n }, (_, i) => { const c = 100 + i * 0.05 + Math.sin(i / 3); return { time: t0 + i * TF, open: c - 0.1, high: c + 0.4, low: c - 0.4, close: c, volume: 1000 + (i % 7) * 50 }; });
}
function store(series: Bar[]) {
  const calls: Array<{ to?: number; limit?: number }> = [];
  return {
    calls,
    get(_s: string, _tf: string, opts: { to?: number; limit?: number; closedOnly?: boolean } = {}) {
      calls.push({ to: opts.to, limit: opts.limit });
      let b = series; if (opts.to !== undefined) b = b.filter(x => x.time <= opts.to!); if (opts.limit !== undefined && b.length > opts.limit) b = b.slice(-opts.limit);
      return b.map(x => ({ ...x }));
    },
  };
}

test('enricher: features come from the bars closed at the entry, are cached, and survive a restart', () => {
  const db = new Db(':memory:');
  const t0 = Date.UTC(2026, 9, 1);
  const s = store(bars(600, t0));
  const e = new FeatureEnricher(db, s);
  const entryAt = t0 + 400 * TF + 5_000;  // five seconds after bar 400 opened: bar 399 is the last closed one
  const trade = { book: 2, id: 7, symbol: 'ETHUSD', tf: '15m', side: 'long', entryAt, entryPrice: 120, sl: 118, tp: [124], levelsSource: 'atr-fallback' };
  const f = e.featuresFor(trade);
  assert.ok(f, 'features computed');
  assert.equal(f!.side_long, 1);
  assert.ok(Number.isFinite(f!.er20) && Number.isFinite(f!.chop14) && Number.isFinite(f!.hour));
  assert.ok(s.calls[0].to! <= entryAt - TF, 'only bars that closed before the entry are read');
  // the second call is served from the cache: no bars read
  e.featuresFor(trade);
  assert.equal(s.calls.length, 1);
  e.flush();
  const again = new FeatureEnricher(db, store([]));
  assert.deepEqual(again.featuresFor(trade), f, 'the cache persisted');
  assert.deepEqual(again.size(), { cached: 1, unscorable: 0 });
  assert.ok(db.kvGet(ENRICH_KV));
  db.db.close();
});

test('enricher: a trade that already carries features is returned as is; one whose bars are gone is null', () => {
  const db = new Db(':memory:');
  const t0 = Date.UTC(2026, 9, 1);
  const e = new FeatureEnricher(db, store(bars(MIN_BARS - 10, t0)));
  const own = { book: 0, id: 1, symbol: 'BTCUSD', tf: '15m', side: 'short', entryAt: t0 + 100 * TF, entryPrice: 100, sl: 101, features: { side_long: 0, er20: 0.3 } };
  assert.equal(e.featuresFor(own), own.features);
  const gone = { book: 2, id: 2, symbol: 'BTCUSD', tf: '15m', side: 'short', entryAt: t0 + 1000 * TF, entryPrice: 100, sl: 101 };
  assert.equal(e.featuresFor(gone), null);
  assert.equal(e.featuresFor({ ...gone, id: 3, sl: null }), null, 'no stop, no stop-distance feature: unscored');
  assert.deepEqual(e.size(), { cached: 2, unscorable: 2 });
  db.db.close();
});
