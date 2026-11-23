import { test, expect, monitor } from './fixtures'

test('protection below 0.5R shows profit, SLs and winner damage as a separate shadow comparison', async ({
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
        earlyProfitStudy: {
          rule: 'early-net-profit-retreat-v1',
          startedAt: Date.now(),
          mode: 'shadow-advisory',
          promotionEligible: false,
          description: 'Net profit includes fees and funding. Five seconds of pressure; no paper activation.',
          groups: [
            {
              key: 'early:ALTUSD:policy',
              scanner: 'Test scanner',
              symbol: 'ALTUSD',
              tf: '15m',
              policyId: 'frozen-early-policy',
              enrolled: 9,
              closed: 8,
              covered: 7,
              unavailable: 1,
              triggered: 4,
              samples: 300,
              usable: 200,
              quiet: 0,
              dataUnavailable: 100,
              baselineNet: -30,
              candidateNet: -20,
              baselineR: -3,
              candidateR: -2,
              stressDeltaR: 0.6,
              stopsBefore: 5,
              stopsAfter: 2,
              losersBefore: 5,
              losersAfter: 4,
              stressLosers: 5,
              winnersCut: 2,
              winnersLost: 1,
              stressWinnersCut: 3,
              winnerGivebackR: 0.8,
            },
          ],
          recent: [
            {
              positionId: 1,
              symbol: 'ALTUSD',
              status: 'unverified',
              reason: 'Observer gap exceeds three seconds',
            },
          ],
        },
      },
    }),
  )
  await page.goto('/monitor')
  await page.getByRole('tab', { name: /what-if exits/i }).click()
  await expect(page.getByRole('heading', { name: 'Profit protection before 0.5R' })).toBeVisible()
  await expect(page.getByText('7 / 8 / 9', { exact: true })).toBeVisible()
  await expect(page.getByText('5 → 2', { exact: true })).toBeVisible()
  await expect(page.getByText('2 / 3 / 1', { exact: true })).toBeVisible()
  await expect(page.getByText(/Fewer SL labels alone do not establish an improvement/)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
})
