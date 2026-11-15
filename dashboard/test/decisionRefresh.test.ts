import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decisionRefreshKeys } from '../src/sse/decisionRefresh.ts'

test('delayed fills and cancellations refresh decisions without waiting for a new signal', () => {
  for (const event of ['signal', 'order', 'pending', 'trade', 'position']) {
    const keys = decisionRefreshKeys(event, 'opened').flat()
    for (const key of ['signals', 'signal-activity', 'scanners', 'incubator']) assert.ok(keys.includes(key))
  }
  assert.deepEqual(decisionRefreshKeys('position', 'updated'), [])
  assert.deepEqual(decisionRefreshKeys('tick'), [])
})
