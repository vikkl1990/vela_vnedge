import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choppiness, efficiencyRatio } from './backtest.ts';

const bar = (o: number, h: number, l: number, c: number, i: number) => ({ time: i * 900_000, open: o, high: h, low: l, close: c, volume: 1 });

test('efficiency ratio: a straight line is 1, a saw is near 0; choppiness is high in a range and low in a trend', () => {
  const trend = Array.from({ length: 40 }, (_, i) => bar(100 + i, 101 + i, 99.5 + i, 100.8 + i, i));
  const saw = Array.from({ length: 40 }, (_, i) => bar(100, 101, 99, i % 2 ? 100.8 : 99.2, i));
  assert.ok(efficiencyRatio(trend, 39)! > 0.9);
  assert.ok(efficiencyRatio(saw, 39)! < 0.1);
  assert.ok(choppiness(saw, 39)! > 61.8, `saw should read as consolidation: ${choppiness(saw, 39)}`);
  assert.ok(choppiness(trend, 39)! < 50, `trend should read as trend: ${choppiness(trend, 39)}`);
  assert.equal(efficiencyRatio(trend, 5), null, 'not enough bars → no opinion');
});
