import { test, expect, scanners } from './fixtures'

test('scanner reviews distinguish historical refusals, current evidence and duplicate imports', async ({
  page,
  faults,
  writes,
}, info) => {
  void faults
  const at = Date.now() - 2 * 86400000
  const book = { account: [], shadow: ['AIOTUSD 15m'], proposed: [] }
  const week = {
    entries: 3,
    opened: 0,
    pending: 0,
    gate: 0,
    fee: 0,
    regime: 1,
    guard: 1,
    other: 1,
    lastEntryAt: at,
    reasons: [
      {
        action: 'rejected:risk daily loss 15.07% exceeds 15%',
        symbol: 'AIOTUSD',
        tf: '15m',
        n: 1,
        lastAt: at,
      },
    ],
  }
  const ready = {
    at: Date.now(),
    copyEnabled: true,
    shadow: 1,
    eligible: 0,
    tracked: 0,
    candidates: 0,
    holds: [
      { symbol: 'AIOTUSD', tf: '15m', reason: 'restored cell: 19 of 30 trades; forward evidence required' },
    ],
  }
  const sample = [
    {
      ...scanners[0],
      id: 'amit-eth-strategy',
      name: 'Amit Eth Strategy',
      enabled: false,
      scheduledCells: 0,
      books: book,
      week,
      paperReadiness: ready,
    },
    {
      ...scanners[1],
      id: 'amit-eth-strategy-tv-strategies',
      name: 'Amit Eth Strategy',
      enabled: false,
      scheduledCells: 0,
      books: book,
      week,
      paperReadiness: ready,
    },
    {
      ...scanners[2],
      id: 'alphamojo',
      name: 'Alphamojo',
      scheduledCells: 0,
      books: book,
      week: null,
      paperReadiness: {
        ...ready,
        shadow: 4,
        holds: [{ symbol: 'TIAUSD', tf: '15m', reason: '2 of 5 qualified closes' }],
      },
    },
    {
      ...scanners[3],
      id: 'rsi-volume-ladder',
      name: 'RSI Volume Ladder',
      scheduledCells: 0,
      week: null,
      books: { account: [], shadow: [], proposed: [], tracked: ['ETHUSD'] },
      paperReadiness: { ...ready, shadow: 0, tracked: 32, candidates: 1, holds: [] },
    },
    {
      ...scanners[4],
      id: 'native-stop',
      name: 'Native stop scanner',
      enabled: false,
      scheduledCells: 0,
      books: book,
      week: {
        ...week,
        protection: 3,
        regime: 0,
        guard: 0,
        other: 0,
        reasons: [
          {
            action: "rejected:the scanner's own stop: the account takes only the ATR stop",
            symbol: 'ZECUSD',
            tf: '1h',
            n: 3,
            lastAt: at,
          },
        ],
      },
      paperReadiness: { ...ready, eligible: 1, holds: [] },
    },
  ]
  await page.route('**/api/scanners', (route) => route.fulfill({ json: sample }))
  await page.goto('/scanners?section=trading&view=list')
  const panel = page.locator('.needs').filter({ hasText: 'Setup and entry reviews' })
  await expect(panel.locator('.sc-todo-item')).toHaveCount(5)
  await expect(panel).not.toContainText('Most were held')
  await expect(panel).not.toContainText('Assign pairs')
  await expect(panel).toContainText('Past refusals are historical outcomes')
  await expect(panel).toContainText('amit-eth-strategy-tv-strategies')
  await expect(panel).toContainText('32 watch-only cells')
  await expect(panel).toContainText('1 of 1 shadow cells pass paper-copy checks')
  await expect(panel).toContainText('3 native-stop policy')
  await panel.getByText('Evidence and recorded reasons', { exact: true }).first().click()
  await expect(
    panel
      .locator('.sc-todo-item')
      .first()
      .getByText(/AIOTUSD 15m: risk daily loss 15.07%/),
  ).toBeVisible()
  await expect(panel.getByText(/Current evidence · AIOTUSD 15m/).first()).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await panel.screenshot({ path: info.outputPath('scanner-attention.png') })
  await panel.getByRole('link', { name: 'Review evidence', exact: true }).first().click()
  await expect(page).toHaveURL(/\/incubator\?q=alphamojo/)
  expect(writes).toEqual([])
})
