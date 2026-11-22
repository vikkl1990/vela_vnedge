import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { IncubatorView } from '../src/api/types.ts'
import { gateLine, stageGuide } from '../src/lib/stageGuide.ts'

const config = {
  screen: { minTrades: 20, minProfitFactor: 1.2, minWindowsUp: 5, stressBps: 10, slices: 7 },
  gate: {
    minTrades: 30,
    minDays: 14,
    minPfR: 1.2,
    minPositiveWeeksPct: 60,
    minAvgR: 0.1,
    maxOverlapPct: 50,
    maxDays: 45,
    failPfR: 1,
    minTradesByTf: { '1h': 20 },
  },
  promote: { maxPerWeek: 1000, maxFleet: 1000, auto: true, reviewMinutes: 15 },
  demote: { window: 20, minTrades: 12, maxPfR: 0.9 },
} as unknown as IncubatorView['config']

test('the guide walks the stages in order and ends with tracked, which sits outside the path', () => {
  assert.deepEqual(
    stageGuide(config).map((s) => s.id),
    ['candidate', 'shadow', 'proposed', 'live', 'demote_proposed', 'retired', 'tracked'],
  )
})

test('the gate line and the stage text carry the settings, not fixed numbers', () => {
  assert.match(
    gateLine(config.gate),
    /30 trades over 14 days, profit factor 1.2 or better, average R of 0.1 or more, and 60% of weeks positive/,
  )
  assert.match(gateLine(config.gate), /Some timeframes have their own minimums/)
  const g = stageGuide({ ...config, gate: { ...config.gate, minTrades: 50 } })
  assert.match(g[1].how, /At least 50 trades/)
  assert.match(g[4].how, /last 20 trades \(at least 12\).*below 0.9/)
  assert.match(g[5].how, /within 45 days/)
})

test('a proposal is said to move on by itself only when auto-promotion is on', () => {
  const on = stageGuide(config)[2].how
  assert.match(on, /moves to the account by itself at the next review \(every 15 minutes\)/)
  const off = stageGuide({ ...config, promote: { ...config.promote, auto: false } })[2].how
  assert.match(off, /waits here until you approve or reject/)
  assert.doesNotMatch(off, /by itself/)
})

test('a missing setting shows a dash rather than undefined or NaN', () => {
  const g = stageGuide({ ...config, demote: {} } as unknown as IncubatorView['config'])
  assert.doesNotMatch(JSON.stringify(g), /undefined|NaN/)
  assert.match(g[4].how, /last – trades/)
})
