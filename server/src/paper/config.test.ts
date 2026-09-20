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
