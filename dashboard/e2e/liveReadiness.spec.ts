import { test, expect } from './fixtures'

test('Live readiness separates historical halt advice from its six required checks', async ({
  page,
  faults,
  writes,
}) => {
  void faults
  await page.route('**/api/learning', async (route) => {
    await route.fulfill({
      json: {
        golive: {
          ok: false,
          checks: ['trades', 'risk', 'expectancy', 'survival', 'drawdown', 'alerts'].map((key) => ({
            key,
            label: key,
            ok: !['trades', 'alerts'].includes(key),
            value: key === 'trades' ? '11' : '1',
            need: key === 'trades' ? '≥ 200' : 'pass',
          })),
          advisories: [
            {
              key: 'halts',
              label: 'Historical halts in the evaluation window',
              value: '1',
              note: 'Advisory history: past halts do not block readiness. Active loss limits, drawdown controls and the kill switch still apply.',
            },
            {
              key: 'capacity-evidence',
              label: 'Readiness evidence in the last 30 days',
              value: '0 exact + 11 capacity-compatible trades',
              note: 'Compatible trades differ only in stricter global position-count ceilings. Their actual fills, costs, size, exits and returns are retained. This history does not establish performance at higher concurrency; promotion and leverage rules are unchanged.',
            },
          ],
          sim: null,
        },
      },
    })
  })
  await page.goto('/live')
  await expect(page.locator('.live-checks tbody tr')).toHaveCount(6)
  await expect(page.locator('.live-count')).toHaveText('4 of 6 pass')
  await expect(page.getByText('Historical halts in the evaluation window: 1')).toBeVisible()
  await expect(
    page.getByText(/Active loss limits, drawdown controls and the kill switch still apply/),
  ).toBeVisible()
  await expect(page.locator('.live-checks')).not.toContainText('Historical halts')
  await expect(
    page.getByText('Readiness evidence in the last 30 days: 0 exact + 11 capacity-compatible trades'),
  ).toBeVisible()
  await expect(page.getByText(/does not establish performance at higher concurrency/)).toBeVisible()
  await expect(page.locator('body')).toContainText('Off')
  expect(writes).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('Evidence details explain every excluded paper trade and separate same-size replay', async ({
  page,
  faults,
  writes,
}) => {
  void faults
  const { incubator } = await import('./incubatorFixture')
  await page.route('**/api/incubator', (route) => route.fulfill({ json: incubator }))
  await page.route('**/api/policy-health', (route) =>
    route.fulfill({
      json: {
        at: Date.now(),
        windowDays: 30,
        haltEvents: 1,
        boundExits: { failures: 0 },
        allocation: { widthMs: 1000, pending: 0 },
        books: [
          {
            book: 'paper',
            matching: 24,
            capacityCompatible: 14,
            sizingCompatible: 9,
            scopeCompatible: 0,
            changed: 271,
            legacy: 746,
            quarantined: 0,
            pending: 0,
            reservedMargin: 0,
            adoptedOpen: 0,
            totalClosed: 1091,
            outsideWindow: 50,
            exclusions: [
              { reason: 'missing-policy', label: 'No bound execution policy', trades: 744 },
              { reason: 'adopted-policy', label: 'Original policy unknown at adoption', trades: 2 },
              { reason: 'execution-version', label: 'Different execution model', trades: 163 },
              {
                reason: 'different-size',
                label: 'Recorded size not proven equivalent to current sizing',
                trades: 51,
              },
              {
                reason: 'missing-sizing-proof',
                label: 'Insufficient entry evidence to prove unchanged sizing',
                trades: 57,
              },
            ],
          },
        ],
      },
    }),
  )
  await page.goto('/incubator?section=operations#incubator-evidence')
  await expect(page.getByRole('heading', { name: 'Why other paper trades do not count' })).toBeVisible()
  await expect(page.getByText('9 same-size replay', { exact: true })).toBeVisible()
  await expect(page.getByText(/No bound execution policy:.*744/)).toBeVisible()
  await expect(page.getByText(/1091 closed paper trades.*50 are outside/)).toBeVisible()
  expect(writes).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('Live reconciles the compatible count with the full journal without passing the 200-trade requirement', async ({
  page,
  faults,
  writes,
}) => {
  void faults
  await page.route('**/api/learning', (route) =>
    route.fulfill({
      json: {
        golive: {
          ok: false,
          checks: [
            {
              key: 'trades',
              label: 'Policy-compatible closed paper trades (last 30 days)',
              ok: false,
              value: '28',
              need: '≥ 200',
            },
          ],
          advisories: [],
          sim: null,
        },
      },
    }),
  )
  await page.route('**/api/policy-health', (route) =>
    route.fulfill({
      json: {
        at: Date.now(),
        windowDays: 30,
        books: [
          {
            book: 'paper',
            matching: 28,
            totalClosed: 1095,
            outsideWindow: 51,
            capacityCompatible: 15,
            scopeCompatible: 0,
            sizingCompatible: 9,
            exclusions: [
              { reason: 'missing-policy', label: 'No bound execution policy', trades: 743 },
              { reason: 'adopted-policy', label: 'Original policy unknown at adoption', trades: 2 },
              { reason: 'execution-version', label: 'Different execution model', trades: 163 },
              {
                reason: 'different-size',
                label: 'Recorded size not proven equivalent to current sizing',
                trades: 51,
              },
              {
                reason: 'missing-sizing-proof',
                label: 'Insufficient entry evidence to prove unchanged sizing',
                trades: 57,
              },
            ],
          },
        ],
      },
    }),
  )
  await page.goto('/live')
  const row = page.locator('.live-checks tbody tr')
  await expect(row).toContainText('Policy-compatible closed paper trades (last 30 days)')
  await expect(row.locator('.live-now')).toHaveText('28')
  await expect(row).toContainText('≥ 200')
  await expect(page.locator('.live-count')).toHaveText('0 of 1 pass')
  await page.getByRole('link', { name: 'See counted trades and exclusions below' }).click()
  const history = page.locator('#readiness-history')
  await expect(history).toContainText('1095 closed paper trades in the journal; 51 are outside')
  await expect(history).toContainText('Within the window, 28 qualify.')
  await expect(history).toContainText(
    'Included: 4 exact matches + 15 capacity-compatible + 0 unrelated-cell settings + 9 same-size replay.',
  )
  await expect(history.locator('li')).toHaveCount(5)
  await expect(history).toContainText('No bound execution policy: 743')
  await expect(history).toContainText('Different execution model: 163')
  expect(writes).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('Missing readiness coverage is shown as unavailable rather than zero or fully eligible', async ({
  page,
  faults,
  writes,
}) => {
  void faults
  await page.route('**/api/policy-health', (route) =>
    route.fulfill({ json: { at: Date.now(), windowDays: 30, books: [] } }),
  )
  await page.goto('/live')
  const history = page.locator('#readiness-history')
  await expect(history).toContainText('Paper readiness history is unavailable.')
  await expect(history).not.toContainText('All closed paper trades within this window qualify.')
  expect(writes).toEqual([])
})
