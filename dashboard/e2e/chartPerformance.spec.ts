import type { Vela } from '@luxalgo/vela'
import type { Position } from '../src/api/types'
import { test, expect } from './fixtures'

const T = Date.UTC(2026, 10, 19),
  M = 900000
const bars = Array.from({ length: 200 }, (_, i) => ({
  time: T + i * M,
  open: 100,
  high: 102,
  low: 98,
  close: 101,
  volume: 1000,
}))
const position: Position = {
  id: 702,
  scannerId: 'not-selected',
  scannerName: 'Recorded strategy',
  symbol: 'ETHUSD',
  tf: '15m',
  side: 'long',
  qty: 2,
  qtyOpen: 2,
  contractValue: 1,
  entryPrice: 100,
  entryAt: T,
  sl: 95,
  slOriginal: 95,
  tp: [105, 110, 130],
  legs: [0, 0, 2],
  tpHit: [false, false, false],
  breakEven: false,
  markPrice: 102,
  unrealizedPnl: 4,
  realizedPnl: 0,
  fees: 0.1,
  riskAmount: 10,
  rMultiple: 0.4,
}
type State = { __vnChart: Vela; __firstChart?: Vela; __firstHandle?: unknown }

test('position updates use native levels with no Pine worker and preserve the chart across timeframe changes', async ({
  page,
  faults,
  writes,
}, info) => {
  void faults
  const workers: string[] = []
  page.on('worker', (w) => workers.push(w.url()))
  await page.route('**/api/positions', (r) => r.fulfill({ json: [position] }))
  await page.route('**/api/positions/702/path', (r) => r.fulfill({ json: { position, path: [] } }))
  await page.route('**/api/candles?**', (r) => r.fulfill({ json: bars }))
  await page.goto('/chart?symbol=ETHUSD&tf=15m')
  await expect
    .poll(() => page.evaluate(() => (window as unknown as State).__vnChart?.inspect().totals.priceLines ?? 0))
    .toBe(5)
  expect(workers).toEqual([])
  await page.evaluate(() => {
    const s = window as unknown as State
    s.__firstChart = s.__vnChart
    s.__firstHandle = s.__vnChart.indicators().find((h) => h.nativeType === 'vnedge.position-levels')
  })
  // Exercise the actual SSE → React Query → chart update path.
  await page.evaluate(async (p) => {
    const modulePath = '/src/sse/bus.ts'
    const { sseBus } = await import(/* @vite-ignore */ modulePath)
    sseBus.emit('position', { type: 'updated', position: { ...p, sl: 101 } })
  }, position)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = window as unknown as State
        const h = s.__vnChart.indicators().find((h) => h.nativeType === 'vnedge.position-levels')!
        return JSON.parse(String(h.inputValues().levels)).levels.find((l: { label: string }) =>
          l.label.startsWith('stop now'),
        )?.price
      }),
    )
    .toBe(101)
  expect(
    await page.evaluate(() => {
      const s = window as unknown as State
      return (
        s.__firstHandle === s.__vnChart.indicators().find((h) => h.nativeType === 'vnedge.position-levels')
      )
    }),
  ).toBe(true)
  await page.getByLabel('Timeframe', { exact: true }).selectOption('1h')
  await expect
    .poll(() => page.evaluate(() => (window as unknown as State).__vnChart.market.timeframe))
    .toBe('60')
  expect(
    await page.evaluate(() => {
      const s = window as unknown as State
      return s.__firstChart === s.__vnChart
    }),
  ).toBe(true)
  expect(workers).toEqual([])
  await page.screenshot({ path: info.outputPath('native-position-levels.png'), fullPage: true })
  await page.evaluate(
    async (from) => {
      const c = (window as unknown as State).__vnChart
      await c.replay.start({ from })
    },
    T + 100 * M,
  )
  // This replay starts after the fill, so the recorded levels stay. A cursor before the fill is covered in the unit test.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as State).__vnChart.inspect().totals.priceLines))
    .toBe(6)
  expect(writes).toEqual([])
})

test('adding a timeframe keeps existing canvases and workers alive', async ({ page, faults, writes }) => {
  void faults
  const workers: string[] = []
  page.on('worker', (w) => workers.push(w.url()))
  await page.route('**/api/candles?**', (r) => r.fulfill({ json: bars }))
  await page.route('**/api/scanners/*/source', (r) =>
    r.fulfill({
      json: {
        id: 'scanner-0',
        name: 'Fixture',
        sourceHash: 'fixture',
        inputs: {},
        timezone: 'UTC',
        patched: '//@version=5\nindicator("Fixture", overlay=true)\nplot(close)',
      },
    }),
  )
  await page.goto('/chart?symbol=ETHUSD&tf=15m&add=scanner-0')
  await page.getByRole('button', { name: 'Frames', exact: true }).click()
  const frame = page.locator('.chart-frame').first()
  await expect(frame.locator('canvas').first()).toBeVisible()
  const canvas = await frame.locator('canvas').first().elementHandle()
  await page.locator('#chart-values > summary').click()
  await expect(page.locator('#chart-values tbody tr')).toHaveCount(4)
  const before = workers.length
  await page
    .getByRole('group', { name: 'Frames', exact: true })
    .getByRole('button', { name: '3m', exact: true })
    .click()
  await expect(page.locator('.chart-frame')).toHaveCount(5)
  expect(await canvas!.evaluate((el) => el.isConnected)).toBe(true)
  await expect.poll(() => workers.length).toBe(before + 1)
  expect(writes).toEqual([])
})
