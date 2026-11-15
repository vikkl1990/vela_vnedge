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
  await expect(page.locator('body')).toContainText('Off')
  expect(writes).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
