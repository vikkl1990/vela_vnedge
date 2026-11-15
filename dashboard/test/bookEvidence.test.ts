import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quietShadowCount, screenMeanR } from '../src/lib/bookEvidence.ts'
const DAY = 86400000,
  now = 60 * DAY

test('new and recently re-admitted cells are not labelled silent for thirty days', () => {
  const cells = [
    { stage: 'shadow', since: now - DAY },
    { stage: 'shadow', since: now - DAY, lastTradeAt: DAY },
    { stage: 'shadow', since: now - 31 * DAY, lastTradeAt: now - DAY },
    { stage: 'live', since: DAY },
    { stage: 'shadow', since: now - 30 * DAY },
    { stage: 'shadow', since: DAY, lastTradeAt: now - 31 * DAY },
  ]
  assert.equal(quietShadowCount(cells, now), 2)
  assert.equal(quietShadowCount(cells, 0), 0)
})

test('screen R per trade is weighted by valid trade counts', () => {
  assert.equal(
    screenMeanR([
      { avgR: 2, trades: 1 },
      { avgR: -0.1, trades: 100 },
    ]),
    -8 / 101,
  )
  assert.equal(
    screenMeanR([
      { avgR: 1, trades: 0 },
      { avgR: null, trades: 100 },
      { avgR: Infinity, trades: 1 },
    ]),
    null,
  )
  assert.equal(
    screenMeanR([
      { avgR: 1, trades: 2 },
      { avgR: -1, trades: 2 },
    ]),
    0,
  )
})
