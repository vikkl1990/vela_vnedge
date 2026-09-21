/** Property tests for candle gap detection (`findGaps`) and timestamp normalisation (`toMs`). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findGaps, toMs } from '../src/data/candleStore.ts';
import { TF_SECONDS } from '../src/config.ts';

/** Small deterministic PRNG so failures are reproducible. */
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

const TFS = Object.values(TF_SECONDS).map(s => s * 1000);

test('a complete series has no gaps, for every timeframe and length', () => {
  for (const tfMs of TFS) for (const n of [0, 1, 2, 7, 100]) {
    const times = Array.from({ length: n }, (_, i) => 1_700_000_000_000 - (1_700_000_000_000 % tfMs) + i * tfMs);
    assert.deepEqual(findGaps(times, tfMs), [], `tf ${tfMs} n ${n}`);
  }
});

test('property: removing bars from a complete series returns exactly the removed times, ascending', () => {
  const r = rng(42);
  for (let round = 0; round < 300; round++) {
    const tfMs = TFS[Math.floor(r() * TFS.length)];
    const n = 2 + Math.floor(r() * 120);
    const start = Math.floor((1_600_000_000_000 + r() * 1e11) / tfMs) * tfMs;
    const full = Array.from({ length: n }, (_, i) => start + i * tfMs);
    const removed = new Set<number>();
    for (let i = 1; i < n - 1; i++) if (r() < 0.3) removed.add(full[i]);
    const kept = full.filter(t => !removed.has(t));
    const gaps = findGaps(kept, tfMs);
    assert.deepEqual(gaps, [...removed].sort((a, b) => a - b), `round ${round} tf ${tfMs}`);
    // ascending and strictly increasing
    for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] > gaps[i - 1]);
    // filling the gaps restores a complete series
    assert.deepEqual(findGaps([...kept, ...gaps], tfMs), []);
  }
});

test('property: order and duplicates do not matter', () => {
  const r = rng(7);
  for (let round = 0; round < 100; round++) {
    const tfMs = TFS[Math.floor(r() * TFS.length)];
    const n = 3 + Math.floor(r() * 50);
    const start = 1_650_000_000_000 - (1_650_000_000_000 % tfMs);
    const times = Array.from({ length: n }, (_, i) => start + i * tfMs).filter(() => r() < 0.7);
    const shuffled = [...times, ...times.slice(0, 5)].sort(() => r() - 0.5);
    assert.deepEqual(findGaps(shuffled, tfMs), findGaps(times, tfMs));
  }
});

test('leading and trailing bars never count as gaps; off-grid times snap to the grid', () => {
  const tf = 60_000;
  assert.deepEqual(findGaps([0, 60_000, 120_000], tf), []);
  assert.deepEqual(findGaps([0, 180_000], tf), [60_000, 120_000]);
  assert.deepEqual(findGaps([1_000, 180_500], tf), [60_000, 120_000]);
  assert.deepEqual(findGaps([0, 10 * tf], tf, 3), [tf, 2 * tf, 3 * tf], 'maxPerGap caps long outages');
  assert.deepEqual(findGaps([5, 3], 0), []);
});

test('toMs normalises seconds, milliseconds and microseconds', () => {
  assert.equal(toMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(toMs(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(toMs(1_700_000_000_000_000), 1_700_000_000_000);
  assert.ok(Number.isNaN(toMs(0))); assert.ok(Number.isNaN(toMs(NaN)));
});
