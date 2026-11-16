import { test, expect, monitor } from './fixtures'

test('ARIA shadow evaluation distinguishes fewer stops from fewer losing trades and reports capture gaps', async ({
  page,
  writes,
  faults,
}) => {
  void faults
  void writes
  await page.route('**/api/trade-monitor', (route) =>
    route.fulfill({
      json: {
        ...monitor,
        invalidationStudy: {
          rule: 'aria-wick-confirmed-1m-v1',
          startedAt: Date.now(),
          mode: 'shadow-advisory',
          promotionEligible: false,
          description: 'Prospective shadow only. No orders or promotion evidence.',
          groups: [
            {
              policyId: 'frozen-policy-123',
              enrolled: 5,
              closed: 4,
              covered: 3,
              unavailable: 1,
              triggered: 2,
              deltaR: 0.7,
              stressDeltaR: 0.5,
              stopsBefore: 2,
              stopsAfter: 0,
              losersBefore: 2,
              losersAfter: 2,
              winnersCut: 0,
            },
          ],
        },
        replay: {
          entryInvalidationStudy: {
            ready: true,
            symbols: ['ARIAUSD', 'INITUSD', 'PARTIUSD'],
            bytes: 1024,
            lastSyncAt: Date.now(),
            lastError: 'capture paused: free disk reserve reached',
            failures: 1,
            dropped: 0,
          },
        },
      },
    }),
  )
  await page.goto('/monitor')
  await page.getByRole('tab', { name: /hypothetical|what-if|exit/i }).click()
  await expect(page.getByRole('heading', { name: 'ARIA · prospective shadow comparison' })).toBeVisible()
  await expect(page.getByText('3 / 4 / 5', { exact: true })).toBeVisible()
  await expect(page.getByText('2 → 0', { exact: true })).toBeVisible()
  await expect(page.getByText('2 → 2', { exact: true })).toBeVisible()
  await expect(page.getByText(/Capture needs attention: capture paused/)).toBeVisible()
  await expect(page.getByText(/These results never count toward promotion/)).toBeVisible()
})

test('ARIA has an explicit waiting state before any new shadow entries', async ({ page, writes, faults }) => {
  void faults
  void writes
  await page.route('**/api/trade-monitor', (route) =>
    route.fulfill({
      json: {
        ...monitor,
        invalidationStudy: {
          rule: 'aria-wick-confirmed-1m-v1',
          startedAt: Date.now(),
          mode: 'shadow-advisory',
          promotionEligible: false,
          description: 'Prospective shadow only.',
          groups: [],
        },
      },
    }),
  )
  await page.goto('/monitor')
  await page.getByRole('tab', { name: /hypothetical|what-if|exit/i }).click()
  await expect(
    page.getByText('Waiting for a new eligible ARIA shadow trade. Earlier trades are not enrolled.'),
  ).toBeVisible()
})
