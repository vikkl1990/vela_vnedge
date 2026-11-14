import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gateOf, summarizeOutcomes } from '../src/lib/signalOutcomes.ts'
import type { Signal } from '../src/api/types.ts'

const signal = (action: string, kind: Signal['kind'] = 'entry') => ({ action, kind }) as Signal

test('resting and delayed orders are pending, never counted as opened fills', () => {
  for (const action of ['pending', 'pending:resting limit at 99.4', 'pending:entry delay']) {
    assert.equal(gateOf(action).key, 'pending')
  }
  const result = summarizeOutcomes([
    signal('pending:resting limit at 99.4'), signal('pending'), signal('received:awaiting processing'),
    signal('opened'), signal('reversed'), signal('closed', 'exit'),
  ])
  assert.equal(result.entries, 5)
  assert.equal(result.opened, 2)
  assert.equal(result.buckets.find(b => b.key === 'pending')?.n, 2)
  assert.equal(result.buckets.find(b => b.key === 'received')?.n, 1)
  assert.equal(result.buckets.reduce((n, b) => n + b.n, 0), 6)
})

test('grouped rows and outcome totals agree on filled reversals and market refusals', () => {
  const rows = [signal('opened'), signal('reversed'), signal('rejected:risk market: thin'), signal('rejected:market unavailable')]
  assert.equal(rows.filter(s => gateOf(s.action).key === 'opened').length, summarizeOutcomes(rows).opened)
  assert.equal(summarizeOutcomes(rows).buckets.find(b => b.key === 'market')?.n, 2)
})

test('exit and information events cannot inflate entry conversion', () => {
  const result = summarizeOutcomes([signal('closed', 'exit'), signal('reduced', 'exit'), signal('info', 'info')])
  assert.equal(result.entries, 0)
  assert.equal(result.opened, 0)
})
