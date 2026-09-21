import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConsensusFilter } from './consensus.ts';

const T0 = Date.UTC(2026, 8, 1);
const cand = (scannerId: string, extra: Partial<{ side: 'long' | 'short'; barTime: number; symbol: string; tf: string }> = {}) => ({ scannerId, scannerName: scannerId, symbol: 'BTCUSD', tf: '15m', side: 'long' as const, barTime: T0, price: 100, at: T0 + 1000, ...extra });

test('consensus off: every candidate passes but agreement is still counted', () => {
  const cfg = { enabled: false, minScanners: 2, windowBars: 1 };
  const f = new ConsensusFilter(() => cfg);
  assert.deepEqual(f.shouldEnter(cand('a')), { ok: true, agreeing: 1, scanners: ['a'] });
  assert.equal(f.shouldEnter(cand('b')).agreeing, 2);
});

test('consensus on: the N-th agreeing scanner within the window passes; other side/symbol/bar do not count', () => {
  const cfg = { enabled: true, minScanners: 2, windowBars: 1 };
  const f = new ConsensusFilter(() => cfg);
  const first = f.shouldEnter(cand('a'));
  assert.equal(first.ok, false); assert.equal(first.reason, 'consensus 1/2');
  assert.equal(f.shouldEnter(cand('a')).ok, false, 'same scanner again is not agreement');
  assert.equal(f.shouldEnter(cand('x', { side: 'short' })).ok, false);
  assert.equal(f.shouldEnter(cand('y', { symbol: 'ETHUSD' })).ok, false);
  assert.equal(f.shouldEnter(cand('z', { barTime: T0 + 3 * 900_000 })).ok, false, 'three bars later is outside a 1-bar window');
  const second = f.shouldEnter(cand('b', { barTime: T0 + 900_000 }));
  assert.equal(second.ok, true); assert.deepEqual(second.scanners.sort(), ['a', 'b']);
  cfg.minScanners = 3;
  assert.equal(f.shouldEnter(cand('c')).ok, true, 'config is read live');
  assert.equal(f.status().votes, 6);
});
