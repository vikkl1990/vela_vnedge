import test from 'node:test'
import assert from 'node:assert/strict'
import { QueryClient } from '@tanstack/react-query'
import { mergePositionEvent } from '../src/sse/positionCache.ts'
import type { Position } from '../src/api/types/trading.ts'
import type { PositionEvent } from '../src/api/types/events.ts'

const a = { id: 1, entryAt: 1000 } as Position
const b = { id: 2, entryAt: 2000 } as Position

test('every delta leaves an unknown full list unknown', () => {
  for (const type of ['opened', 'updated', 'closed', 'voided'] as PositionEvent['type'][]) {
    assert.equal(mergePositionEvent(undefined, { type, position: a }), undefined)
  }
})

test('updates keep other held trades and original fill timestamps; closes remove only their row', () => {
  const original = [a, b]
  const updated = { ...a, sl: 10 }
  const result = mergePositionEvent(original, { type: 'updated', position: updated })!
  assert.equal(result[1], b)
  assert.equal(result[0].entryAt, 1000)
  assert.equal(original[0], a)
  assert.deepEqual(mergePositionEvent(result, { type: 'closed', position: b }), [updated])
  assert.deepEqual(mergePositionEvent([], { type: 'opened', position: a }), [a])
})

test('a single event cannot create a successful empty query or renew full-list freshness', () => {
  const client = new QueryClient()
  const key = ['positions']
  client.setQueryData(key, (prev: Position[] | undefined) =>
    mergePositionEvent(prev, { type: 'closed', position: a }),
  )
  assert.equal(client.getQueryData(key), undefined)
  client.setQueryData(key, [a, b], { updatedAt: 1000 })
  client.setQueryData(
    key,
    (prev: Position[] | undefined) => mergePositionEvent(prev, { type: 'closed', position: a }),
    {
      updatedAt: client.getQueryState(key)?.dataUpdatedAt,
    },
  )
  assert.deepEqual(client.getQueryData(key), [b])
  assert.equal(client.getQueryState(key)?.dataUpdatedAt, 1000)
  client.clear()
})
