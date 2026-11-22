import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Signal } from '../src/api/types.ts'
import { decisionMarks } from '../src/chart/decisionMarks.ts'

test('a decision mark sits on the signal bar, and the tooltip keeps the decision time', () => {
  const signal = {
    id: 4,
    at: 120_000,
    barTime: 60_000,
    scannerName: 'Demo',
    tf: '1m',
    kind: 'entry',
    side: 'long',
    action: 'opened',
    symbol: 'BTCUSD',
    price: 100,
    sl: 95,
    tp: [],
    message: '',
    summary: '',
  } as Signal
  const [mark] = decisionMarks([signal])
  assert.equal(mark.time, 60_000)
  assert.match(String(mark.content && 'text' in mark.content ? mark.content.text : ''), /Decision: /)
})
