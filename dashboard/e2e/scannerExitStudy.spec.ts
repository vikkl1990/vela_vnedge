import { test, expect, monitor } from './fixtures'

test('scanner exit comparison shows losses, winner damage and coverage separately without trading controls', async ({
  page,
  writes,
  faults,
}) => {
  void writes
  void faults
  await page.route('**/api/trade-monitor', (route) =>
    route.fulfill({
      json: {
        ...monitor,
        scannerExitStudy: {
          rule: 'scanner-half-stop-v1',
          startedAt: Date.now(),
          mode: 'shadow-advisory',
          promotionEligible: false,
          description: 'Future filled entries only. No orders or promotion evidence.',
          groups: [
            {
              key: '0:scanner:policy',
              scanner: 'supertrend-cluster-zeiierman',
              symbol: 'EVAAUSD',
              tf: '15m',
              book: 0,
              policyId: 'frozen-policy',
              enrolled: 9,
              closed: 8,
              covered: 7,
              unavailable: 1,
              missingActual: 0,
              baselineNet: -30,
              candidateNet: -20,
              baselineR: -3,
              candidateR: -2,
              stressDeltaR: 0.6,
              stopsBefore: 5,
              stopsAfter: 2,
              losersBefore: 5,
              losersAfter: 6,
              winnersCut: 1,
              winnersLost: 1,
              winnerGivebackR: 0.8,
            },
          ],
        },
      },
    }),
  )
  await page.goto('/monitor')
  await page.getByRole('tab', { name: /what-if exits/i }).click()
  await expect(page.getByRole('heading', { name: 'Scanner-specific earlier exits' })).toBeVisible()
  await expect(page.getByText('7 / 8 / 9', { exact: true })).toBeVisible()
  await expect(page.getByText('5 → 2', { exact: true })).toBeVisible()
  await expect(page.getByText('5 → 6', { exact: true })).toBeVisible()
  await expect(page.getByText('1 / 1', { exact: true })).toBeVisible()
  await expect(page.getByText(/No automatic paper activation/)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
})

test('prospective study shows waiting rather than zero performance', async ({ page, writes, faults }) => {
  void writes
  void faults
  await page.route('**/api/trade-monitor', (route) =>
    route.fulfill({
      json: {
        ...monitor,
        scannerExitStudy: {
          rule: 'scanner-half-stop-v1',
          startedAt: Date.now(),
          mode: 'shadow-advisory',
          promotionEligible: false,
          description: 'Future filled entries only.',
          groups: [],
        },
      },
    }),
  )
  await page.goto('/monitor')
  await page.getByRole('tab', { name: /what-if exits/i }).click()
  await expect(page.getByText(/Waiting for future SuperTrend Cluster/)).toBeVisible()
})
