import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountPositionLimit } from '../src/lib/positionCapacity.ts'

test('terminal count ceiling follows both enabled limits and never renders zero as a full book', () => {
  assert.equal(accountPositionLimit(0, 0), null)
  assert.equal(accountPositionLimit(0, 8), 8)
  assert.equal(accountPositionLimit(8, 0), 8)
  assert.equal(accountPositionLimit(20, 8), 8)
  assert.equal(accountPositionLimit(0, 8, false), null)
})
