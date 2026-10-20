import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyConditionTitles } from './pool.ts';

test('decision 164: every scanner with a record keeps the old condition-title reading', () => {
  const ids = legacyConditionTitles();
  assert.ok(ids.size >= 243, `the list holds the scanners with a record on 20 October 2026: ${ids.size}`);
  for (const id of ['kalman-step-signals', 'money-flow-divergence-zones', 'nadaraya-watson-regression-liquidity-sweeps', 'smart-money-breakout-signals']) assert.ok(ids.has(id), id);
  assert.ok(!ids.has('volume-filtered-all-candlestick-patterns'), 'a script without a record reads its conditions');
});
