import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { CandleCache } from './candleCache.ts';

const TF = 900; // 15m in seconds
const NOW = 1_800_000_000_000; // fixed clock (ms), aligned to nothing in particular

/** Fake Delta REST: a synthetic history that starts at `listedAt` (seconds), records every request. */
function fakeRest(listedAt: number, perCall = 4000) {
  const calls: Array<{ start: number; end: number }> = [];
  return {
    calls,
    async candles(_symbol: string, _res: string, startSec: number, endSec: number) {
      calls.push({ start: startSec, end: endSec });
      const out = [];
      const first = Math.ceil(Math.max(startSec, listedAt) / TF) * TF;
      for (let t = Math.floor(endSec / TF) * TF; t >= first && out.length < perCall; t -= TF) out.push({ time: t, open: t, high: t + 1, low: t - 1, close: t + 0.5, volume: 1 });
      return out; // newest first, like Delta
    },
  };
}

test('getHistory pages backwards in chunks, stores, and serves the second call from SQLite', async t => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const rest = fakeRest(0);
  const cache = new CandleCache(db, rest, { chunkBars: 1000, delayMs: 0, now: () => NOW });
  const bars = await cache.getHistory('BTCUSD', '15m', 2500);
  assert.equal(bars.length, 2500);
  assert.equal(rest.calls.length, 3, 'three 1000-bar chunks');
  for (let i = 1; i < bars.length; i++) assert.equal(bars[i].time - bars[i - 1].time, TF * 1000, 'contiguous');
  const lastClosed = Math.floor(NOW / (TF * 1000)) * TF * 1000 - TF * 1000;
  assert.equal(bars.at(-1)!.time, lastClosed, 'newest bar is the last closed bar');
  // each chunk window spans at most chunkBars bars
  for (const c of rest.calls) assert.ok(c.end - c.start < 1000 * TF + TF, `window ${c.end - c.start}`);
  // second call: fully served from disk
  const again = await cache.getHistory('BTCUSD', '15m', 2500);
  assert.equal(rest.calls.length, 3);
  assert.deepEqual(again, bars);
  assert.equal(cache.coverage('BTCUSD', '15m').bars, 2500);
});

test('a deeper request only fetches the missing head; a later clock only fetches the tail', async t => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const rest = fakeRest(0);
  let now = NOW;
  const cache = new CandleCache(db, rest, { chunkBars: 1000, delayMs: 0, now: () => now });
  await cache.getHistory('ETHUSD', '15m', 500);
  assert.equal(rest.calls.length, 1);
  const deeper = await cache.getHistory('ETHUSD', '15m', 1500);
  assert.equal(deeper.length, 1500);
  assert.equal(rest.calls.length, 2, 'one extra request for the 1000 older bars');
  assert.ok(rest.calls[1].end < rest.calls[0].start, 'head request lies entirely before the stored range');
  now += 10 * TF * 1000; // 10 new bars closed
  const fresh = await cache.getHistory('ETHUSD', '15m', 1500);
  assert.equal(rest.calls.length, 3);
  assert.equal(rest.calls[2].start, Math.floor(rest.calls[0].end / TF) * TF + TF, 'tail request starts right after the stored range');
  assert.equal(fresh.at(-1)!.time, Math.floor(now / (TF * 1000)) * TF * 1000 - TF * 1000);
  assert.equal(cache.coverage('ETHUSD', '15m').bars, 1510);
});

test('exchange history floor is remembered and not requested again', async t => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const listedAt = Math.floor(NOW / 1000) - 800 * TF; // only ~800 bars exist
  const rest = fakeRest(listedAt);
  const cache = new CandleCache(db, rest, { chunkBars: 500, delayMs: 0, now: () => NOW });
  const bars = await cache.getHistory('NEWUSD', '15m', 3000);
  assert.ok(bars.length >= 799 && bars.length <= 801, `got ${bars.length}`);
  const n = rest.calls.length;
  assert.ok(n >= 2 && n <= 4, `requests ${n}`);
  await cache.getHistory('NEWUSD', '15m', 3000);
  assert.equal(rest.calls.length, n, 'floor prevents re-requesting the empty range');
  assert.ok(db.kvGet('candlecache.floor:NEWUSD:15m') !== undefined);
});

test('from/to ranges and per-symbol sequential requests', async t => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const rest = fakeRest(0);
  let inFlight = 0, maxInFlight = 0;
  const orig = rest.candles.bind(rest);
  rest.candles = async (...a: Parameters<typeof orig>) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise(r => setTimeout(r, 2)); const r = await orig(...a); inFlight--; return r; };
  const cache = new CandleCache(db, rest, { chunkBars: 300, delayMs: 0, now: () => NOW });
  const to = NOW - 100 * TF * 1000, from = to - 999 * TF * 1000;
  const [a, b] = await Promise.all([cache.getHistory('BTCUSD', '15m', { from, to }), cache.getHistory('BTCUSD', '15m', { from: from - 300 * TF * 1000, to })]);
  assert.equal(a.length, 1000); assert.equal(b.length, 1300);
  assert.equal(a[0].time, Math.floor(from / (TF * 1000)) * TF * 1000); assert.equal(a.at(-1)!.time, to);
  assert.equal(maxInFlight, 1, 'same symbol never fetches concurrently');
  const p = cache.status().find(s => s.symbol === 'BTCUSD')!;
  assert.equal(p.status, 'done'); assert.equal(p.bars, 1300);
});
