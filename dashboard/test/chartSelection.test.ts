import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activeChartKeys, retainChartRecord } from '../src/chart/activeRecords.ts'
import { DELTA_TIMEFRAMES } from '../src/lib/timeframes.ts'

test('all selected scanner/frame records survive beyond 64 while stale contexts are removed', () => {
  const ids = Array.from({ length: 8 }, (_, i) => `scanner-${i}`)
  const active = activeChartKeys('ETHUSD', [...DELTA_TIMEFRAMES], ids, 'vn:')
  let records: Record<string, number> = { 'BTCUSD:15m:vn:old': -1 }
  for (const key of active) records = retainChartRecord(records, key, 1, active)
  assert.equal(Object.keys(records).length, 80)
  assert.equal(records['ETHUSD:1m:vn:scanner-0'], 1)
  assert.equal(records['ETHUSD:1d:vn:scanner-7'], 1)
  assert.equal(records['BTCUSD:15m:vn:old'], undefined)
  const narrowed = activeChartKeys('ETHUSD', ['15m'], ['scanner-0'], 'vn:')
  records = retainChartRecord(records, 'BTCUSD:15m:vn:late', 2, narrowed)
  assert.deepEqual(records, { 'ETHUSD:15m:vn:scanner-0': 1 })
})
