import { test, expect } from './fixtures'
import { incubator } from './incubatorFixture'

test('setup invalidation shows queued delivery without claiming fills or profit', async ({
  page,
  writes,
  faults,
}, info) => {
  void faults
  const now = Date.now()
  const cohorts = ['control', 'candidate'].map((role) => ({
    id: role,
    signature: role,
    label: role,
    revision: 1,
    symbol: 'DOGEUSD',
    tf: '1h',
    variant: 'current',
    sourceScannerId: 'maker',
    setupLifecycle: role === 'candidate' ? 'confirmed-exit-v1' : null,
    exitDelivery: role === 'candidate' ? { pending: 1, done: 2, maxAttempts: 3 } : null,
    scannerName: 'Maker source',
    takeProfitLabel: 'Current exits',
    firstAt: now,
    referenceEquity: 1000,
    margin: 150,
    leverage: 5,
    maxStopLossPct: 3,
    scans: 7,
    lastScanAt: now,
    signals: 0,
    placed: 0,
    filled: 0,
    pending: 0,
    open: 0,
    closed: 0,
    stops: 0,
    net: 0,
    fees: 0,
    avgR: null,
    avgWin: null,
    avgLoss: null,
    winRate: null,
    payoffRatio: null,
    breakEvenWinRate: null,
    drawdown: 0,
    positionIds: [],
    reasons: {},
    executionVersion: 2,
  }))
  await page.route('**/api/incubator', (route) => route.fulfill({ json: incubator }))
  await page.route('**/api/execution-plans', (route) =>
    route.fulfill({
      json: {
        configured: cohorts.map((c) => ({
          ...c,
          enabled: true,
          scannerId: 'maker',
          sourceStatus: 'ok',
          lastSourceBar: now - 3600000,
        })),
        cohorts,
        comparisons: [
          {
            kind: 'setup-lifecycle',
            group: 'doge',
            symbol: 'DOGEUSD',
            tf: '1h',
            enabled: true,
            controlId: 'control',
            candidateId: 'candidate',
            controlLabel: 'Current maker',
            candidateLabel: 'Tick/depth maker',
            controlSignature: 'control',
            candidateSignature: 'candidate',
            controlNet: 0,
            candidateNet: 0,
            sharedSignals: 0,
            unresolvedSignals: 0,
            differentAdmissions: 0,
            controlOnly: 0,
            candidateOnly: 0,
            matchedClosed: 0,
            matchedDeltaNet: null,
            matchedControlNet: null,
            matchedCandidateNet: null,
            matchedControlStops: 0,
            matchedCandidateStops: 0,
            matchedControlLosses: 0,
            matchedCandidateLosses: 0,
            matchedWinnersCut: 0,
            matchedEntryMismatch: 0,
            promotionEligible: false,
          },
        ],
        costs: { offer: 'off', effectiveFrom: null, rows: [] },
      },
    }),
  )
  await page.goto('/incubator?view=experiments#execution-plans')
  await expect(page.getByText('DOGEUSD 1h · Setup invalidation comparison')).toBeVisible()
  await expect(page.getByText('7 comparison scans', { exact: false })).toHaveCount(2)
  await expect(page.getByText('Source scanned; no fresh entry signal', { exact: false })).toHaveCount(2)
  await expect(page.getByText(/Source scans: 7 control · 7 candidate/)).toBeVisible()
  await expect(page.getByText(/No closed matched trades yet/)).toBeVisible()
  await expect(page.getByText('SL exits: 0 → 0', { exact: false })).toHaveCount(0)
  await expect(page.getByText('Current maker: – · Tick/depth maker: –', { exact: false })).toBeVisible()
  await expect(page.getByText(/Confirmed exit instructions: 2 delivered · 1 awaiting retry/)).toBeVisible()
  expect(writes).toEqual([])
  await page.screenshot({ path: info.outputPath('setup-lifecycle.png'), fullPage: true })
})
