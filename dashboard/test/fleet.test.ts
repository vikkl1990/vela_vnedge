import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PaperFleet } from '../src/api/paperFleet.ts'
import { copyRuleText, copySharePct, sizeLabel, sourceLabel } from '../src/lib/fleet.ts'

const fleet: PaperFleet = {
  at: 1,
  own: { scanners: 1, pairs: 2 },
  ownCells: [
    { scannerId: 'a', symbol: 'BTCUSD', tf: '15m' },
    { scannerId: 'a', symbol: 'ETHUSD', tf: '1h' },
  ],
  idle: ['b'],
  window: {
    days: 14,
    entries: { own: 196, copy: 425, unknown: 0, total: 621 },
    ownScanners: 14,
    copyScanners: 101,
  },
  copy: { enabled: true, sizeScale: 1 / 3, minTrades: 5, minNetR: 0 },
}

test('pilot sizes read as people say them', () => {
  assert.equal(sizeLabel(1 / 3), '⅓')
  assert.equal(sizeLabel(0.5), '½')
  assert.equal(sizeLabel(0.1), '×0.1')
  assert.equal(sizeLabel(1), 'full size')
  assert.equal(sizeLabel(null), '')
  assert.equal(sizeLabel(0), '')
  assert.equal(sourceLabel('copy', 1 / 3), 'Copy ⅓')
  assert.equal(sourceLabel('copy', null), 'Copy')
  assert.equal(sourceLabel('own', 1 / 3), 'Own list')
})

test('the copy rule is stated from the settings, not from a fixed sentence', () => {
  assert.match(copyRuleText(fleet.copy), /at least 5 shadow closes and net R above 0, shared evidence checks/)
  assert.match(
    copyRuleText({ enabled: true, sizeScale: null, minTrades: 0, minNetR: null }),
    /shared evidence requirements/,
  )
  assert.match(copyRuleText({ ...fleet.copy, enabled: false }), /only the own list trades/)
})

test('the copy share is a whole percent, and absent when nothing traded', () => {
  assert.equal(copySharePct(fleet.window), 68)
  assert.equal(copySharePct({ ...fleet.window, entries: { own: 0, copy: 0, unknown: 0, total: 0 } }), null)
})

test('unknown entry origin is explicit and is never called a copy', () => {
  assert.equal(sourceLabel('unknown', 1 / 3), 'Origin unknown')
})
