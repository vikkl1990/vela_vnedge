import { test, expect } from './fixtures'

test('Terminal shows removed count limits without implying margin and risk are disabled', async ({
  page,
  faults,
  writes,
}) => {
  void faults
  await page.route('**/api/config', (route) =>
    route.fulfill({
      json: {
        symbols: ['ETHUSD'],
        timeframes: ['15m'],
        scanners: {},
        execution: { mode: 'paper' },
        paper: {
          initialEquity: 1000,
          sizingMode: 'margin',
          marginPerTrade: 150,
          maxStopLossPct: 3,
          maxOpenPositions: 0,
        },
        risk: { enabled: true, maxPositionsTotal: 0 },
      },
    }),
  )
  await page.goto('/')
  const strip = page.locator('.terminal-account-strip')
  await expect(strip).toContainText('no count cap')
  await expect(strip).toContainText('Shared account; margin and risk checks apply')
  expect(writes).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
