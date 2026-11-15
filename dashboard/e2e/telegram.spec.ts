import { test, expect } from './fixtures'
import type { TelegramStatus } from '../src/api/telegram'

test('Telegram setup verifies, pairs and approves a private chat without changing trading configuration', async ({
  page,
  faults,
  writes,
}) => {
  void faults
  let state: TelegramStatus = {
    configured: false,
    ready: false,
    username: null,
    savedAt: null,
    binding: null,
    controlsEnabled: false,
    ownerActive: false,
    mode: 'paper',
    receiverRunning: false,
    lastPollAt: null,
    lastError: null,
    pairing: null,
    recent: [],
  }
  const requests: string[] = []
  const candidate = { chatId: '42', userId: '42', username: 'owner', name: 'Test owner' }
  await page.route('**/api/connections/telegram**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method()
    if (method !== 'GET') requests.push(method + ' ' + url.pathname)
    if (method === 'PUT' && url.pathname.endsWith('/telegram')) {
      expect(request.postDataJSON()).toEqual({ botToken: '123456789:' + 'a'.repeat(35) })
      state = {
        ...state,
        configured: true,
        username: 'vn_edge_test_bot',
        ownerActive: true,
        receiverRunning: true,
        savedAt: Date.now(),
        controlsEnabled: true,
      }
    }
    if (url.pathname.endsWith('/pair')) {
      state = { ...state, pairing: { id: 'pair-1', expiresAt: Date.now() + 300000, candidate } }
      await route.fulfill({
        json: {
          url: 'https://t.me/vn_edge_test_bot?start=one-time-fixture',
          expiresAt: state.pairing!.expiresAt,
          status: state,
        },
      })
      return
    }
    if (url.pathname.endsWith('/approve')) {
      expect(request.postDataJSON()).toEqual({ pairId: 'pair-1' })
      state = {
        ...state,
        ready: true,
        binding: { ...candidate, approvedAt: Date.now(), verifiedAt: Date.now() },
        pairing: null,
      }
    }
    if (url.pathname.endsWith('/controls')) {
      state = { ...state, controlsEnabled: request.postDataJSON().enabled }
    }
    if (method === 'DELETE')
      state = { ...state, configured: false, ready: false, binding: null, receiverRunning: false }
    await route.fulfill({ json: state })
  })
  await page.goto('/settings#telegram-connection')
  const panel = page.getByRole('region', { name: 'Telegram alerts and controls' })
  await expect(panel).toBeVisible()
  const token = panel.getByLabel('Telegram bot token')
  await expect(token).toHaveAttribute('type', 'password')
  await token.fill('123456789:' + 'a'.repeat(35))
  await panel.getByRole('button', { name: 'Save and verify bot' }).click()
  await expect(token).toHaveValue('')
  await panel.getByRole('button', { name: 'Pair private chat', exact: true }).click()
  await expect(panel.getByRole('link', { name: 'Open pairing in Telegram' })).toHaveAttribute(
    'href',
    /https:\/\/t.me\/vn_edge_test_bot/,
  )
  await expect(panel.getByText(/Telegram user ID 42/)).toBeVisible()
  await panel.getByRole('button', { name: 'Approve chat and send test' }).click()
  await expect(panel.getByText('Connected', { exact: true })).toBeVisible()
  await expect(panel.getByText(/Resume preserves loss limits and cooldowns/)).toBeVisible()
  await panel.getByRole('checkbox', { name: /Allow paper pause/ }).uncheck()
  await expect(panel.getByRole('checkbox')).not.toBeChecked()
  await panel.getByRole('button', { name: 'Disconnect Telegram' }).click()
  await expect(page.getByRole('dialog', { name: 'Disconnect Telegram?' })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(panel.getByText('Setup required')).toBeVisible()
  expect(requests).toEqual([
    'PUT /api/connections/telegram',
    'POST /api/connections/telegram/pair',
    'POST /api/connections/telegram/approve',
    'PUT /api/connections/telegram/controls',
    'DELETE /api/connections/telegram',
  ])
  expect(writes).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('non-admins cannot see or fetch the Telegram setup panel', async ({ page, faults }) => {
  void faults
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        user: { id: 2, username: 'viewer', role: 'viewer' },
        permissions: ['read', 'backtest'],
        sessions: 1,
      },
    }),
  )
  let fetched = false
  await page.route('**/api/connections/telegram**', (route) => {
    fetched = true
    return route.fulfill({ status: 403, json: { error: 'Administrator access required' } })
  })
  await page.goto('/settings')
  await expect(page.getByRole('region', { name: 'Telegram alerts and controls' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  expect(fetched).toBe(false)
})
