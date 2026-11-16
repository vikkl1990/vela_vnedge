import type { Vela } from '@luxalgo/vela'
import { test, expect, scanners } from './fixtures'
import { DELTA_TIMEFRAMES } from '../src/lib/timeframes'

const M = 900000,
  T = Date.UTC(2026, 10, 12),
  end = T + 199 * M
const bars = Array.from({ length: 200 }, (_, i) => ({
  time: T + i * M,
  open: 100 + i * 0.1,
  high: 102 + i * 0.1,
  low: 99 + i * 0.1,
  close: 101 + i * 0.1,
  volume: 1000,
}))
const source = (title: string) => `//@version=5
strategy("${title}", overlay=true)
if bar_index % 20 == 0
    strategy.entry("Long", strategy.long)
if bar_index % 20 == 5
    strategy.close("Long", comment="author exit")
preview=input.int(10, "Preview input")
plot(preview, "Preview value")
plot(hour, "Session hour")
`
const row = (book = 'paper') => ({
  id: book === 'paper' ? 701 : 801,
  book,
  status: 'closed',
  scannerId: 'scanner-0',
  sourceScannerId: 'scanner-0',
  sourceHash: 'hash-0',
  scannerName: 'New York author',
  symbol: 'ETHUSD',
  tf: '15m',
  side: 'long',
  entryAt: T + 181 * M + 2000,
  exitAt: T + 183 * M,
  entryPrice: 118.1,
  exitPrice: 119,
  qty: 2,
  qtyOpen: 0,
  net: 1.6,
  r: 0.8,
  commission: 0.2,
  funding: 0,
  policyId: 'p1',
  exitReason: 'author "exit"',
  fills: [
    { at: T + 181 * M + 2000, price: 118.1, qty: 2, reason: 'entry', fee: 0.1, pnl: 0 },
    { at: T + 182 * M, price: 118.6, qty: 1, reason: 'tp1', fee: 0.05, pnl: 0.5 },
    { at: T + 183 * M, price: 119, qty: 1, reason: 'trail', fee: 0.05, pnl: 1.3 },
  ],
})

test('all supported frames and every plot value can be shown without a four-frame or six-plot cap', async ({
  page,
  faults,
  writes,
}, info) => {
  test.setTimeout(90000)
  void faults
  await page.route('**/api/scanners', (r) => r.fulfill({ json: scanners.slice(0, 1) }))
  await page.route('**/api/scanners/*/source', (r) =>
    r.fulfill({
      json: {
        id: 'scanner-0',
        name: 'All plots',
        inputs: {},
        timezone: 'UTC',
        sourceHash: 'all-plots',
        patched:
          '//@version=5\nindicator("All plots", overlay=true)\n' +
          Array.from({ length: 8 }, (_, i) => `plot(${i + 1}, "Plot ${i + 1}")`).join('\n'),
      },
    }),
  )
  await page.route('**/api/candles?**', (r) => r.fulfill({ json: bars }))
  await page.goto('/chart?symbol=ETHUSD&tf=15m&add=scanner-0')
  await page.getByRole('button', { name: 'Frames', exact: true }).click()
  const picker = page.getByRole('group', { name: 'Frames', exact: true })
  for (const tf of DELTA_TIMEFRAMES) {
    const button = picker.getByRole('button', { name: tf, exact: true })
    if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click()
  }
  await expect(page.locator('.chart-frame')).toHaveCount(10)
  await page.locator('#chart-values > summary').click()
  const rows = page.locator('#chart-values tbody tr')
  await expect(rows).toHaveCount(10, { timeout: 60000 })
  for (const tf of DELTA_TIMEFRAMES)
    await expect(
      rows.filter({ has: page.locator('td').filter({ hasText: new RegExp(`· ${tf}$`) }) }),
    ).toContainText('Plot 8: 8')
  expect(writes).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('all-chart-frames.png'), fullPage: true })
})

test('real Pine workers apply per-script timezones and compare recorded closed fills with the author ledger', async ({
  page,
  faults,
  writes,
}, info) => {
  void faults
  await page.route('**/api/scanners', (r) =>
    r.fulfill({
      json: scanners.slice(0, 2).map((s, i) => ({ ...s, name: i ? 'UTC author' : 'New York author' })),
    }),
  )
  await page.route('**/api/scanners/*/source', (r) => {
    const i = r.request().url().includes('scanner-0') ? 0 : 1
    return r.fulfill({
      json: {
        id: `scanner-${i}`,
        name: i ? 'UTC author' : 'New York author',
        patched: source(i ? 'UTC author' : 'New York author'),
        sourceHash: `hash-${i}`,
        inputs: {},
        timezone: i ? 'UTC' : 'America/New_York',
      },
    })
  })
  await page.route('**/api/candles?**', (r) => {
    const u = new URL(r.request().url()),
      from = Number(u.searchParams.get('from') ?? 0),
      to = Number(u.searchParams.get('to') ?? Infinity)
    return r.fulfill({ json: bars.filter((b) => b.time >= from && b.time < to) })
  })
  await page.route('**/api/journal?**', (r) => {
    const u = new URL(r.request().url()),
      book = u.searchParams.get('book') ?? 'paper'
    const rows = u.searchParams.get('symbol') === 'ETHUSD' ? [row(book)] : []
    return r.fulfill({
      json: { at: Date.now(), book, total: rows.length, offset: 0, limit: 200, rows, summary: {} },
    })
  })
  await page.goto('/chart?symbol=ETHUSD&tf=15m&add=scanner-0,scanner-1')
  await expect(page.locator('.chart-ledger')).toHaveCount(2, { timeout: 30000 })
  const ny = page
    .locator('.chart-ledger')
    .filter({ has: page.locator('summary').filter({ hasText: 'New York author' }) })
    .first()
  await expect(ny).toContainText('simulated closed')
  await expect(ny).toContainText('same entry bar')
  await expect(ny).toContainText('45.0 min earlier')
  await page.locator('#chart-values > summary').click()
  const utcHour = new Date(end).getUTCHours()
  await expect(page.locator('#chart-values tr').filter({ hasText: 'New York author' })).toContainText(
    `Session hour: ${(utcHour + 19) % 24}`,
  )
  await expect(page.locator('#chart-values tr').filter({ hasText: 'UTC author' })).toContainText(
    `Session hour: ${utcHour}`,
  )
  const marks = await page.evaluate(() => {
    const chart = (window as unknown as { __vnChart: Vela }).__vnChart
    return chart.marks.all()
  })
  expect(marks.filter((m) => m.group === 'bot-fills')).toHaveLength(3)
  expect(marks.filter((m) => m.group === 'author-simulation').length).toBeGreaterThan(0)
  await page.getByLabel('Chart trade book').selectOption('shadow')
  await expect(ny).toContainText('#801')
  await expect(ny).not.toContainText('#701')
  await page.evaluate(() => {
    const chart = (window as unknown as { __vnChart: Vela }).__vnChart
    const h = chart.indicators().find((h) => h.id === 'vn:scanner-0')!
    h.setInputs({ [h.inputs.find((i) => i.title === 'Preview input')!.key]: 20 })
  })
  await expect(ny).toContainText('chart inputs differ from bot configuration')
  await expect(ny).toContainText('chart inputs changed')
  expect(writes).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('chart-comparison.png'), fullPage: true })
})
