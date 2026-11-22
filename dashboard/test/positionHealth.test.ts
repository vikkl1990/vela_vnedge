import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PositionHealth } from '../../shared/positionHealth.ts'
import { healthMatches, quoteFresh } from '../src/lib/positionHealth.ts'
const h: PositionHealth = {
  id: 1,
  at: 1800000000000,
  identity: {
    symbol: 'ETHUSD',
    side: 'long',
    entryAt: 100,
    entryPrice: 100,
    qtyOpen: 5,
    sl: 95,
    realizedPnl: 0,
    fees: 0.1,
  },
  closeNow: {
    netUsd: 2,
    price: 101,
    filledQty: 5,
    requestedQty: 5,
    grossExitFee: 0.3,
    cashExitFee: 0.3,
    feeDiscount: 0,
    validForMs: 900,
    depthAgeMs: 100,
    reason: null,
  },
  stop: { price: 95, state: 'initial', netAtLevel: -25.4, liquidationBeforeStop: false },
  coverage: { policy: 'legacy', entry: 'missing', pendingFunding: 0, replay: null },
}
test('estimates expire by local monotonic time and request latency, never server wall-clock', () => {
  assert.equal(quoteFresh(h, 1000, 100, 1200), true)
  assert.equal(quoteFresh(h, 1000, 100, 1800), false)
  assert.equal(quoteFresh(h, 1000, 1000, 1000), false)
  assert.equal(quoteFresh(h, 1000, 100, 900), false)
  assert.equal(quoteFresh({ ...h, closeNow: { ...h.closeNow, netUsd: null } }, 1000, 10, 1010), false)
})
test('different or amended exposure cannot borrow a stale health snapshot', () => {
  const p = { id: 1, ...h.identity }
  assert.equal(healthMatches(p, h), true)
  for (const diff of [
    { id: 2 },
    { entryAt: 101 },
    { qtyOpen: 4 },
    { sl: 99 },
    { fees: 0.3 },
    { realizedPnl: 1 },
    { entryPrice: 101 },
    { symbol: 'SOLUSD' },
    { side: 'short' },
  ])
    assert.equal(healthMatches({ ...p, ...diff }, h), false)
  assert.equal(healthMatches(p, undefined), false)
})
