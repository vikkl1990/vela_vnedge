import { test, expect } from './fixtures'

test('new pages open at the heading while in-page pagination keeps its position', async ({
  page,
  faults,
  writes,
}) => {
  void faults
  await page.goto('/signals?view=flat')
  await expect(page.getByRole('button', { name: 'Next signals page' })).toBeEnabled()
  await page.evaluate(() => window.scrollTo(0, 500))
  const position = await page.evaluate(() => window.scrollY)
  expect(position).toBeGreaterThan(100)
  await page.getByRole('button', { name: 'Next signals page' }).click()
  // Clicking a paginator may scroll it into view, but must not jump to the heading.
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100)
  const menu = page.getByRole('button', { name: 'Open the menu', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page
    .getByRole('navigation', { name: 'Primary', exact: true })
    .getByRole('link', { name: /^Home/ })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(5)
  expect(writes).toEqual([])
})
