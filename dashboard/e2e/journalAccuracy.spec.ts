import { test, expect } from './fixtures'

test('journal makes archive scope and simulated fills visible without changing history defaults', async ({
  page,
  writes,
  faults,
}, info) => {
  void faults
  const seen: string[] = []
  await page.route('**/api/journal?**', async (route) => {
    const history = new URL(route.request().url()).searchParams.get('history') ?? 'current'
    seen.push(history)
    const archived = history !== 'current'
    await route.fulfill({
      json: {
        at: Date.now(),
        book: 'paper',
        total: 1,
        offset: 0,
        limit: 50,
        summary: {
          archived: archived ? 1 : 0,
          closed: 1,
          open: 0,
          pending: 0,
          cancelled: 0,
          net: archived ? -18.27 : 116.25,
          commission: 2,
          funding: 0,
          grossTrading: 118.25,
          wins: 1,
          losses: 0,
          winRate: 100,
          profitFactor: null,
          noLosses: true,
          sumR: 0.4,
          avgR: 0.4,
          unknownFunding: 0,
          unknownNet: 0,
          unknownRisk: 0,
          accountingPending: 0,
        },
        rows: [
          {
            id: 701,
            book: 'paper',
            archived,
            status: 'closed',
            scannerId: 'scanner-0',
            scannerName: 'Maker scanner',
            symbol: 'SOLUSD',
            tf: '15m',
            side: 'long',
            evidenceScope: 'account',
            entryAt: Date.now() - 60000,
            exitAt: Date.now(),
            entryPrice: 100,
            exitPrice: 101,
            qty: 1,
            qtyOpen: 0,
            net: 0.4,
            risk: 1,
            margin: 50,
            slOriginal: 99,
            targets: [102, 104, 106],
            r: 0.4,
            peakR: 0.7,
            commission: 0.2,
            funding: 0,
            mlProbability: null,
            exitReason: 'trail',
            source: 'limit-candle-model',
            fleetSource: archived ? 'unknown' : 'copy',
            entrySizeScale: archived ? null : 1 / 3,
            accountingPending: false,
          },
        ],
      },
    })
  })
  await page.goto('/trades?book=paper')
  const history = page.getByRole('combobox', { name: 'Journal history', exact: true })
  await expect(history).toBeVisible()
  await expect(history).toHaveValue('current')
  await expect(page.getByRole('combobox', { name: 'Closing period' })).toHaveValue('all')
  await expect(page.getByRole('option', { name: 'All dates', exact: true })).toBeAttached()
  await expect(page.getByRole('note', { name: 'Journal history scope' })).toContainText(
    'archived by account resets are excluded',
  )
  await expect(page.getByText('Candle model · tick/queue unverified')).toBeVisible()
  await expect(page.getByText('Copy ⅓', { exact: true })).toBeVisible()
  await expect(page.getByText('Copy ½', { exact: true })).toHaveCount(0)
  await expect(page.getByText(/comparing it with net R does not measure profit retained/)).toBeVisible()
  await history.selectOption('all')
  await expect(page.getByRole('note', { name: 'Journal history scope' })).toContainText(
    'totals include retained trades',
  )
  await expect(page.getByText('−18.27', { exact: true })).toBeVisible()
  await expect(page.getByText('Origin unknown', { exact: true }).filter({ visible: true })).toBeVisible()
  expect(seen).toContain('current')
  expect(seen).toContain('all')
  expect(writes).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('journal-accuracy.png'), fullPage: true })
})
