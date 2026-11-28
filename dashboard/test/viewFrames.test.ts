import { test } from 'node:test'
import assert from 'node:assert/strict'
import { viewFrames } from '../src/lib/viewFrames.ts'

test('the Terminal shows the selected timeframe with higher-timeframe context', () => {
  assert.deepEqual(viewFrames('5m', 1), ['5m'])
  assert.deepEqual(viewFrames('5m', 2), ['5m', '1h'])
  assert.deepEqual(viewFrames('4h', 2), ['1h', '4h'])
  assert.deepEqual(viewFrames('1m', 4), ['5m', '15m', '1h', '4h'])
})
