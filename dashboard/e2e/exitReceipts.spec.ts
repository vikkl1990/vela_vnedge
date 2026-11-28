import { test, expect, signals } from './fixtures'

test('exit receipts cannot present an unfilled instruction as reduced exposure', async ({
  page,
  writes,
  faults,
}, info) => {
  void faults
  const rows = [
    { ...signals[0], kind: 'exit' as const, action: 'exit-requested', label: 'Script close' },
    { ...signals[1], kind: 'exit' as const, action: 'stop-update-requested', label: 'Stop amendment' },
  ]
  await page.route(/\/api\/signals(?:\?.*)?$/, (route) => route.fulfill({ json: rows }))
  await page.goto('/signals?view=flat&kind=exit')
  await expect(page.getByText('exit requested', { exact: true })).toBeVisible()
  await expect(page.getByText('stop update requested', { exact: true })).toBeVisible()
  await expect(page.getByText('reduced', { exact: true })).toHaveCount(0)
  await page.getByRole('tab', { name: /What became of them/ }).click()
  const outcomes = page.getByRole('tabpanel', { name: /What became of them/ })
  await expect(outcomes).toContainText('exit requested')
  await expect(outcomes).toContainText('stop update requested')
  expect(writes).toEqual([])
  await page.screenshot({ path: info.outputPath('exit-receipts.png'), fullPage: true })
})
