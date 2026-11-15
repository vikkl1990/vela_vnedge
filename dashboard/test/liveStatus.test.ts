import { test } from 'node:test'
import assert from 'node:assert/strict'
import { liveStatus } from '../src/lib/liveStatus.ts'

test('production is detected from the runtime transport even with the legacy testnet mode name', () => {
  assert.equal(liveStatus({ mode: 'testnet', host: 'production', hasKeys: true, dryRun: false }).armed, true)
  assert.equal(liveStatus({ mode: 'testnet', host: 'testnet', hasKeys: true, dryRun: false }).armed, false)
})

test('production dry run and missing authentication never appear armed', () => {
  assert.equal(
    liveStatus({ mode: 'dry-run', host: 'production', hasKeys: true, dryRun: true }).label,
    'Dry run',
  )
  assert.equal(
    liveStatus({ mode: 'testnet', host: 'production', hasKeys: false, dryRun: false }).label,
    'Unknown',
  )
})

test('unknown status is not an assurance that real money is off', () => {
  assert.equal(liveStatus(undefined).label, 'Unknown')
  assert.equal(liveStatus({ mode: 'live', host: null, hasKeys: false, dryRun: false }).label, 'Unknown')
  const paper = liveStatus({ mode: 'paper', host: null, hasKeys: false, dryRun: false })
  assert.equal(paper.label, 'Off')
  assert.match(paper.detail, /Existing exchange exposure/)
})
