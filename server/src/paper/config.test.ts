import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, validateConfig } from '../config.ts';

test('rejects invalid calculation settings even when split weights sum to one', () => {
  for (const paper of [{ tpSplit: [-1, 1, 1] }, { fallbackRR: [1, 0, -1] }, { slippageBps: -1 }, { slippageBps: Infinity }, { fallbackAtrSl: 0 }]) {
    const cfg = structuredClone(DEFAULT_CONFIG);
    Object.assign(cfg.paper, paper);
    assert.ok(validateConfig(cfg).length > 0);
  }
});

test('give-back trailing is a valid alternative to a fixed trail distance', async () => {
  const { validateConfig, DEFAULT_CONFIG } = await import('../config.ts');
  const base = structuredClone(DEFAULT_CONFIG);
  Object.assign(base.paper, { trailAfterR: 1, trailDistanceR: 0, trailGiveBackPct: 25 });
  assert.deepEqual(validateConfig(base), [], 'give-back supplies the distance');
  Object.assign(base.paper, { trailGiveBackPct: 0 });
  assert.ok(validateConfig(base).some(e => e.includes('trailDistanceR')), 'without either, the trail has no distance');
});
