import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MoverStore } from '../src/markets/movers.ts';

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const tick = (s: MoverStore, minute: number, prices: Record<string, number>) =>
  s.record(T0 + minute * MIN, Object.entries(prices).map(([symbol, price]) => ({ symbol, price })));

test('a pump shows in the 5 and 15 minute windows and is ranked first', () => {
  const s = new MoverStore();
  for (let m = 0; m <= 20; m++) tick(s, m, { AAAUSD: 100, BBBUSD: 50 + (m >= 16 ? (m - 15) * 2 : 0) });
  const rows = s.movers(T0 + 20 * MIN);
  assert.equal(rows[0].symbol, 'BBBUSD');
  assert.ok(Math.abs((rows[0].ch5 ?? 0) - 20) < 1e-9, '5 min: 50 at minute 15 to 60 at minute 20');
  assert.ok(Math.abs((rows[0].ch15 ?? 0) - 20) < 1e-9);
  assert.equal(rows[0].ch60, null, 'only 20 minutes of history: no 60 minute figure');
  assert.equal(rows.find((r) => r.symbol === 'AAAUSD')?.ch5, 0);
});

test('a dump is negative, and ranking is by size not sign', () => {
  const s = new MoverStore();
  for (let m = 0; m <= 10; m++) tick(s, m, { DNUSD: m < 6 ? 10 : 8, UPUSD: m < 6 ? 10 : 10.5 });
  const rows = s.movers(T0 + 10 * MIN);
  assert.equal(rows[0].symbol, 'DNUSD');
  assert.ok((rows[0].ch5 ?? 0) < -19);
});

test('a window is reported only when the ring reaches back far enough', () => {
  const s = new MoverStore();
  tick(s, 0, { XUSD: 1 });
  tick(s, 3, { XUSD: 1.1 });
  assert.deepEqual(s.movers(T0 + 3 * MIN), [], 'three minutes of history answers no window');
  assert.equal(s.historyMinutes(T0 + 3 * MIN), 3);
});

test('a market that stopped updating shows no change at all', () => {
  const s = new MoverStore();
  for (let m = 0; m <= 10; m++) tick(s, m, { OLDUSD: 1 + m * 0.01 });
  assert.equal(s.movers(T0 + 10 * MIN).length, 1);
  assert.equal(s.movers(T0 + 20 * MIN).length, 0, 'ten minutes of silence: stale, not a live mover');
});

test('bad prices are skipped and close samples replace each other', () => {
  const s = new MoverStore();
  s.record(T0, [{ symbol: 'ZUSD', price: 0 }, { symbol: 'ZUSD', price: Number.NaN }, { symbol: 'ZUSD', price: -3 }]);
  assert.equal(s.movers(T0 + 10 * MIN).length, 0);
  s.record(T0, [{ symbol: 'ZUSD', price: 1 }]);
  s.record(T0 + 5_000, [{ symbol: 'ZUSD', price: 2 }]); // inside the gap: replaces, not appended
  s.record(T0 + 6 * MIN, [{ symbol: 'ZUSD', price: 3 }]);
  const row = s.movers(T0 + 6 * MIN)[0];
  assert.ok(Math.abs((row.ch5 ?? 0) - 50) < 1e-9, 'base was the replaced sample, 2');
});

test('the ring forgets what is older than the longest window', () => {
  const s = new MoverStore();
  for (let m = 0; m <= 200; m++) tick(s, m, { LUSD: 1 + m * 0.001 });
  const rows = s.movers(T0 + 200 * MIN);
  assert.ok(rows[0].ch60 !== null);
  assert.ok(s.historyMinutes(T0 + 200 * MIN) <= 66);
});
