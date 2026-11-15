import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalPath, legacyPath, HUB_ROUTES } from '../src/lib/routeHubs.ts'
import { routeMeta, GROUPS } from '../src/components/shell/navModel.ts'
import { bookControlsForPath } from '../src/lib/bookNavigation.ts'
import { fmtUsd, fmtPnlUsd, fmtR, fmtFractionPct, fmtRecordedMoney } from '../src/lib/format.ts'
import { batchedInvalidation } from '../src/lib/batchedInvalidation.ts'

test('all legacy routes keep their identity inside hubs, including scanner details', () => {
  for (const [oldPath, path] of Object.entries(HUB_ROUTES)) {
    assert.equal(canonicalPath(oldPath), path)
    assert.equal(legacyPath(path), oldPath)
    assert.deepEqual(routeMeta(path), routeMeta(oldPath))
  }
  assert.equal(canonicalPath('/scanners/abc'), '/strategies/scanners/abc')
  assert.equal(legacyPath('/strategies/scanners/abc'), '/scanners/abc')
  assert.equal(canonicalPath('/scanners-other'), '/scanners-other')
  assert.equal(GROUPS.flatMap((g) => g.items).filter((i) => !HUB_ROUTES[i.to]).length, 12)
  assert.equal(bookControlsForPath('/strategies/scanners/abc').mlLens, true)
  assert.equal(bookControlsForPath('/strategies/scanners').scope, false)
})
test('shared financial labels distinguish missing values, measured zero, signs and fractions', () => {
  assert.equal(fmtUsd(null), '–')
  assert.equal(fmtRecordedMoney(null), 'Unknown')
  assert.equal(fmtRecordedMoney(0), '0.00')
  assert.equal(fmtPnlUsd(-1.25), '−$1.25')
  assert.equal(fmtPnlUsd(2), '+$2.00')
  assert.equal(fmtPnlUsd(-0.0001), '$0.00')
  assert.equal(fmtR(-0.0001), '0.00R')
  assert.equal(fmtR(null), '–')
  assert.equal(fmtFractionPct(0.125), '12.5%')
})
test('continuous signal bursts refresh within 400 ms and cleanup drops pending work', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const seen: unknown[] = []
  const batch = batchedInvalidation((key) => seen.push(key))
  batch.request(['signals'])
  t.mock.timers.tick(100)
  batch.request(['signals'])
  t.mock.timers.tick(100)
  batch.request(['signals'])
  t.mock.timers.tick(200)
  assert.deepEqual(seen, [['signals']])
  batch.request(['signals'])
  batch.request(['trades'])
  batch.dispose()
  t.mock.timers.tick(1000)
  assert.equal(seen.length, 1)
})
