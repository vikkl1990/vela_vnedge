import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inHorizon, openCapital, workspaceSignals } from '../src/lib/workspace.ts'
import type { Position, Signal } from '../src/api/types.ts'
test('horizon filters have an explicit 1h boundary and do not relabel unknown frames', () => {
  assert.equal(inHorizon('30m', 'scalp'), true)
  assert.equal(inHorizon('1h', 'scalp'), false)
  assert.equal(inHorizon('1h', 'swing'), true)
  assert.equal(inHorizon('unknown', 'scalp'), false)
  assert.equal(inHorizon('unknown', 'swing'), false)
  assert.equal(inHorizon('unknown', 'all'), true)
})
test('workspace lists actual entry events with decisions, excluding exits and context', () => {
  const rows = [
    { id: 1, at: 1, kind: 'entry', tf: '15m', symbol: 'BTCUSD', action: 'rejected:cost' },
    { id: 2, at: 2, kind: 'exit', tf: '15m', symbol: 'BTCUSD' },
    { id: 3, at: 3, kind: 'entry', tf: '1h', symbol: 'ETHUSD', action: 'opened' },
  ] as Signal[]
  assert.deepEqual(
    workspaceSignals(rows, 'scalp').map((s) => s.id),
    [1],
  )
  assert.deepEqual(
    workspaceSignals(rows, 'all', 'ETHUSD').map((s) => s.id),
    [3],
  )
  assert.equal(rows.length, 3)
})
test('open capital uses remaining size and preserves unknown margin', () => {
  const rows = [
    { qtyOpen: 2, contractValue: 1, entryPrice: 100, marginLeverage: 5, riskAmount: 7 },
    { margin: 50, riskAmount: 3 },
    { riskAmount: 4 },
  ] as Position[]
  assert.deepEqual(openCapital(rows), { margin: 90, unknown: 1, risk: 14 })
})
