import { test, expect } from './fixtures'

test('asset-class values fit their panel with large shadow balances', async ({
  page,
  faults,
  writes,
}, info) => {
  void faults
  await page.route('**/api/analytics/performance*', (route) =>
    route.fulfill({
      json: {
        byGroup: ['majors', 'large_alts', 'alts', 'meme', 'tradfi'].map((key, i) => ({
          key,
          paper: { trades: 36, avgR: 0.02, net: 9.42 },
          shadow: { trades: 2247, avgR: -0.06, net: i === 2 ? -13514104.92 : 325912.2 },
        })),
      },
    }),
  )
  await page.goto('/overview')
  const table = page.getByRole('table', { name: 'shadow results by asset class' })
  await expect(table.getByText(/13,514,104.92/)).toBeVisible()
  for (const width of info.project.name === 'phone' ? [375] : [1440, 1024, 900]) {
    await page.setViewportSize({ width, height: 1000 })
    const overflow = await table.evaluate((el) => {
      const box = el.getBoundingClientRect()
      return [...el.querySelectorAll('.class-row > *')]
        .filter((n) => getComputedStyle(n).display !== 'none')
        .filter((n) => {
          const r = n.getBoundingClientRect()
          return r.left < box.left - 1 || r.right > box.right + 1 || n.scrollWidth > n.clientWidth + 1
        })
        .map((n) => n.textContent)
    })
    expect(overflow).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  if (info.project.name === 'phone') {
    await expect(table.getByRole('columnheader', { name: 'Share', exact: true })).toBeHidden()
    await expect(table.getByRole('columnheader', { name: 'Net $', exact: true })).toBeVisible()
  }
  await table.screenshot({ path: info.outputPath('asset-classes.png') })
  expect(writes).toEqual([])
})
