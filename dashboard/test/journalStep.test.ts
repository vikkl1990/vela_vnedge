import assert from 'node:assert/strict'
import { test } from 'node:test'
import { journalStep } from '../src/lib/journalStep.ts'

test('stepping moves to the neighbours in the order on screen and stops at both ends', () => {
  const ids = [90, 80, 70]
  assert.deepEqual(journalStep(ids, 80), { position: 2, total: 3, prev: 90, next: 70 })
  assert.deepEqual(journalStep(ids, 90), { position: 1, total: 3, prev: null, next: 80 })
  assert.deepEqual(journalStep(ids, 70), { position: 3, total: 3, prev: 80, next: null })
})

test('a trade that is not on this page starts from the top, and never wraps around', () => {
  assert.deepEqual(journalStep([90, 80], 5), { position: null, total: 2, prev: null, next: 90 })
  assert.deepEqual(journalStep([90, 80], null), { position: null, total: 2, prev: null, next: 90 })
})

test('an empty page has nothing to step to', () => {
  assert.deepEqual(journalStep([], 5), { position: null, total: 0, prev: null, next: null })
})

test('a single trade has no neighbours', () => {
  assert.deepEqual(journalStep([7], 7), { position: 1, total: 1, prev: null, next: null })
})
