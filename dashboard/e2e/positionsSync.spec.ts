import { test, expect } from './fixtures'
import type { Position } from '../src/api/types'

const position: Position = {
  id: 18850,
  scannerId: 'scanner-0',
  scannerName: 'Scanner 000',
  symbol: 'ETHUSD',
  tf: '4h',
  side: 'short',
  qty: 11,
  qtyOpen: 11,
  contractValue: 0.01,
  entryPrice: 1778.75,
  entryAt: Date.UTC(2026, 10, 15, 8, 2),
  sl: 1860.65,
  slOriginal: 1860.65,
  tp: [1614.95, 1451.2, 1287.4],
  tpHit: [false, false, false],
  legs: [0, 0, 11],
  breakEven: false,
  markPrice: 1824,
  unrealizedPnl: -4.97,
  realizedPnl: 0,
  fees: 0.046,
  riskAmount: 9.22,
  rMultiple: -0.54,
}

test('a close event before the full list loads must not claim there are no positions', async ({
  page,
  faults,
  writes,
}) => {
  void faults
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  let requested = false
  await page.route('**/api/positions', async (route) => {
    requested = true
    await ready
    await route.fulfill({ json: [position] })
  })
  await page.goto('/')
  await expect.poll(() => requested).toBe(true)
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('fixture-sse', {
        detail: { name: 'position', data: { type: 'closed', position: { id: 999 } } },
      }),
    ),
  )
  // An event about one trade is not a complete snapshot of the account.
  await expect(page.getByText('No open positions', { exact: true })).toHaveCount(0)
  release()
  await expect(page.getByRole('button', { name: /Close ETHUSD position|Close/ }).first()).toBeVisible()
  await expect(page.locator('time[datetime="2026-11-15T08:02:00.000Z"]:visible').first()).toBeVisible()
  await expect(page.getByText('Last full refresh', { exact: false })).toBeVisible()
  expect(writes).toEqual([])
})

test('a failed refresh retains held trades but marks the list unverified', async ({
  page,
  faults,
  writes,
}) => {
  void faults
  let fail = false
  await page.route('**/api/positions', (route) =>
    route.fulfill(fail ? { status: 503, json: { error: 'Temporary disconnect' } } : { json: [position] }),
  )
  await page.goto('/')
  await expect(page.locator('time[datetime="2026-11-15T08:02:00.000Z"]:visible').first()).toBeVisible()
  fail = true
  await page.getByRole('button', { name: 'Refresh positions', exact: true }).click()
  await expect(
    page.getByText(/Showing the last confirmed list; current positions are unverified/),
  ).toBeVisible()
  await expect(page.locator('time[datetime="2026-11-15T08:02:00.000Z"]:visible').first()).toBeVisible()
  await expect(page.getByText('No open positions', { exact: true })).toHaveCount(0)
  expect(writes).toEqual([])
})
