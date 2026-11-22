import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strategyFamily, variantSupersedes } from './variantFamily.ts';

test('the base script wins over its variant on the same market', () => {
  const variant = 'trend-impulse-channels-zeiierman-native';
  const base = 'trend-impulse-channels-zeiierman';
  assert.equal(strategyFamily(variant), base);
  assert.equal(variantSupersedes(variant, base), true);
  assert.equal(variantSupersedes(base, variant), false);
  assert.equal(variantSupersedes(base, 'some-other-script'), false);
});
