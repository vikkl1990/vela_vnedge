import { test, expect } from './fixtures'

test('Signals render bounded rows, preserve filters, and sort every result', async ({
  page,
  faults,
  writes,
}, info) => {
  void faults
  const phone = info.project.name === 'phone'
  await page.goto('/signals?view=flat')
  const rows = phone ? page.locator('.data-card') : page.locator('tbody tr')
  await expect(rows).toHaveCount(phone ? 10 : 25)
  await expect(page.getByRole('button', { name: 'Next signals page' })).toBeEnabled()
  const before = await rows.first().innerText()
  await page.getByRole('button', { name: 'Next signals page' }).click()
  await expect(rows.first()).not.toHaveText(before)
  await page.getByLabel('Scanner', { exact: true }).selectOption('scanner-205')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Scanner 205')
  await page.goBack()
  await expect(rows).toHaveCount(phone ? 10 : 25)
  if (phone) {
    await page.getByLabel('Sort Signals', { exact: true }).selectOption('price')
    await page.getByRole('button', { name: 'Ascending', exact: true }).click()
  } else await page.getByRole('button', { name: 'Price', exact: true }).click()
  await expect(rows.first()).toContainText('Scanner 205')
  expect(writes).toEqual([])
  await expect(page.locator('body')).not.toContainText('Something went wrong')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  if (phone) {
    await expect(rows.first().getByText('SL', { exact: true })).not.toBeVisible()
    await rows.first().locator('summary').click()
    await expect(rows.first().getByText('SL', { exact: true })).toBeVisible()
  }
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: info.outputPath('signals.png'), fullPage: true })
})

test('Grouped signals expose one inspector and real filter buttons', async ({ page, faults }, info) => {
  void faults
  await page.goto('/signals')
  await expect(page.getByRole('group', { name: 'View', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /View 1 signals/ })).toHaveCount(
    info.project.name === 'phone' ? 10 : 25,
  )
  await page
    .getByRole('button', { name: /View 1 signals/ })
    .first()
    .click()
  await expect(page.locator('#signal-cell-details')).toHaveCount(1)
  await expect(page.locator('#signal-cell-details')).toBeVisible()
  await page.getByRole('tab', { name: 'What became of them' }).click()
  await expect(page.getByRole('tabpanel')).toContainText('What became of the last 206 signals')
  await page.keyboard.press('g')
  await page.keyboard.press('s')
  await expect(page).toHaveURL(/\/strategies\/scanners/)
})

test('Heatmap pages every pair with keyboard selection and one detail pane', async ({
  page,
  faults,
}, info) => {
  void faults
  await page.goto('/monitor')
  const cells = page.getByRole('gridcell')
  await expect(cells).toHaveCount(48)
  await cells.first().focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('complementary', { name: 'PAIR001USD details' })).toBeVisible()
  await page.getByRole('button', { name: 'Next pairs page' }).click()
  await expect(cells.first()).toHaveAttribute('aria-label', /PAIR048USD/)
  await page.getByRole('searchbox', { name: 'Find a pair' }).fill('PAIR271')
  await expect(cells).toHaveCount(1)
  await cells.first().click()
  await expect(page.getByRole('complementary', { name: 'PAIR271USD details' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('monitor.png'), fullPage: true })
})

test('Legacy scanner links preserve filters; bulk changes require a dialog', async ({
  page,
  faults,
  writes,
}, info) => {
  void faults
  await page.goto('/scanners?section=catalogue&q=Scanner%20000#directory')
  await expect(page).toHaveURL(/\/strategies\/scanners\?/)
  const url = new URL(page.url())
  expect(url.searchParams.get('q')).toBe('Scanner 000')
  expect(url.hash).toBe('#directory')
  await page.getByRole('button', { name: 'Bulk actions', exact: true }).click()
  await info.attach('menu-bounds', {
    body: JSON.stringify(
      await page.getByRole('menu').evaluate((el) => ({
        rect: el.getBoundingClientRect().toJSON(),
        innerHeight,
        scrollY,
        scale: visualViewport?.scale,
        body: document.body.getBoundingClientRect().toJSON(),
      })),
    ),
    contentType: 'application/json',
  })
  await page.screenshot({ path: info.outputPath('menu-open.png') })
  await page.getByRole('menuitem', { name: 'Disable all', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  expect(writes).toEqual([])
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(writes).toEqual([])
  if (info.project.name === 'phone') {
    const small = await page
      .locator('.route button:visible')
      .evaluateAll((nodes) =>
        nodes
          .filter((n) => n.getBoundingClientRect().height < 43)
          .map((n) => ({ text: n.textContent, height: n.getBoundingClientRect().height })),
      )
    expect(small).toEqual([])
  }
})

test('All navigation destinations render through unavailable endpoint states', async ({
  page,
  faults,
  writes,
}) => {
  void faults
  for (const route of [
    '/',
    '/chart',
    '/settings',
    '/strategies/scanners/scanner-0',
    '/trades/1/replay',
    '/overview',
    '/strategies',
    '/lab',
    '/live',
    '/signals/radar',
    '/trades',
    '/analytics',
    '/analytics/daily',
    '/strategies/trackers',
    '/strategies/library',
    '/strategies/incubator',
    '/strategies/decisions',
    '/signals/gates',
    '/lab/learn',
    '/exchange',
    '/settings/logs',
    '/profile',
    '/users',
  ]) {
    await page.goto(route)
    await expect(page.locator('main')).toBeVisible()
    await expect(page.locator('.route')).toBeVisible()
    await expect(page.locator('main')).not.toContainText('Something went wrong')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), route).toBe(true)
  }
  expect(writes).toEqual([])
})
