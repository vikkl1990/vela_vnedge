import { test, expect } from './fixtures'
import type { Position } from '../src/api/types'
import type { PositionHealth } from '../../shared/positionHealth'
const p: Position = {
  id: 4242,
  scannerId: 'scanner-0',
  scannerName: 'Scanner 000',
  symbol: 'ETHUSD',
  tf: '15m',
  side: 'long',
  qty: 10,
  qtyOpen: 10,
  contractValue: 1,
  entryPrice: 100,
  entryAt: Date.now() - 3600000,
  sl: 100.01,
  slOriginal: 95,
  tp: [130],
  tpHit: [false],
  legs: [10],
  breakEven: false,
  markPrice: 102,
  unrealizedPnl: 20,
  realizedPnl: 0,
  fees: 0.59,
  riskAmount: 51,
  rMultiple: 0.38,
  execution: { version: 211, marketQty: 10, desiredStop: 101, ackAt: Date.now() + 2000, pending: null },
}
const h: PositionHealth = {
  id: p.id,
  at: Date.now(),
  identity: {
    symbol: p.symbol,
    side: p.side,
    entryAt: p.entryAt,
    entryPrice: p.entryPrice,
    qtyOpen: p.qtyOpen,
    sl: p.sl,
    realizedPnl: p.realizedPnl,
    fees: p.fees,
  },
  closeNow: {
    netUsd: 13.21,
    price: 101.4,
    filledQty: 10,
    requestedQty: 10,
    grossExitFee: 0.598,
    cashExitFee: 0.598,
    feeDiscount: 0,
    validForMs: 1000,
    depthAgeMs: 0,
    reason: null,
  },
  stop: { price: 100.01, state: 'profit-level', netAtLevel: -1.08, liquidationBeforeStop: false },
  coverage: {
    policy: 'frozen',
    entry: 'depth-recorded',
    pendingFunding: 1,
    replay: {
      capturing: true,
      segments: 2,
      from: p.entryAt + 100,
      to: Date.now(),
      checkpoints: 1,
      segmentsWithGaps: 1,
      failures: 0,
      dropped: 0,
    },
  },
}
test('net close estimate, active stop and coverage render without trading on desktop and phone', async ({
  page,
  writes,
  faults,
}, info) => {
  void faults
  await page.route('**/api/positions', (r) => r.fulfill({ json: [p] }))
  await page.route('**/api/positions/health', (r) => r.fulfill({ json: { at: Date.now(), positions: [h] } }))
  await page.goto('/')
  const cell = page.locator('[data-testid="position-health-4242"]:visible')
  await expect(cell).toContainText('13.21')
  await expect(page.getByText('Profit-level stop · before fees').filter({ visible: true })).toBeVisible()
  await expect(
    page.getByText(/Stop update pending: 101\.00\. Current SL remains active\./).filter({ visible: true }),
  ).toBeVisible()
  await expect(page.getByText('PROTECTED', { exact: false })).toHaveCount(0)
  await cell.getByText('Data & protection').click()
  await expect(page.getByRole('dialog')).toContainText('recorded settlements unresolved')
  await expect(page.getByRole('dialog')).toContainText('Continuity is unverified')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('dialog').screenshot({ path: info.outputPath('protection.png') })
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page
    .locator(info.project.name === 'phone' ? '.position-card:visible' : '.position-desktop:visible')
    .screenshot({ path: info.outputPath('positions.png') })
  expect(writes).toEqual([])
})
test('stale or unavailable depth is never presented as current profit', async ({ page, writes, faults }) => {
  void faults
  await page.route('**/api/positions', (r) => r.fulfill({ json: [p] }))
  await page.route('**/api/positions/health', (r) =>
    r.fulfill({
      json: { at: Date.now(), positions: [{ ...h, closeNow: { ...h.closeNow, validForMs: 0 } }] },
    }),
  )
  await page.goto('/')
  const cell = page.locator('[data-testid="position-health-4242"]:visible')
  await expect(cell).toContainText('Last estimate · stale')
  await page.route('**/api/positions/health', (r) =>
    r.fulfill({
      json: {
        at: Date.now(),
        positions: [
          { ...h, closeNow: { ...h.closeNow, netUsd: null, reason: 'Insufficient depth', filledQty: 2 } },
        ],
      },
    }),
  )
  await expect(cell).toContainText('Unavailable')
  await expect(cell).toContainText('Insufficient depth')
  expect(writes).toEqual([])
})

test('partial exit exposure cannot display a previous full-size estimate', async ({
  page,
  writes,
  faults,
}) => {
  void faults
  const remaining = {
    ...p,
    qtyOpen: 4,
    execution: {
      ...p.execution!,
      pending: {
        status: 'partial',
        reason: 'trail',
        last_error: 'Awaiting fresh depth',
        trigger_at: Date.now(),
        ready_at: Date.now(),
        qty: 10,
        filled_qty: 6,
      },
    },
  }
  await page.route('**/api/positions', (r) => r.fulfill({ json: [remaining] }))
  await page.route('**/api/positions/health', (r) => r.fulfill({ json: { at: Date.now(), positions: [h] } }))
  await page.goto('/')
  const cell = page.locator('[data-testid="position-health-4242"]:visible')
  await expect(cell).toContainText('Unavailable')
  await expect(cell).not.toContainText('13.21')
  await expect(page.getByText('Exit partially filled · trail').filter({ visible: true })).toBeVisible()
  expect(writes).toEqual([])
})
