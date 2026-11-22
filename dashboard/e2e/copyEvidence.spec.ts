import { test, expect } from './fixtures'
import { incubator } from './incubatorFixture'
import type { IncubatorStats } from '../src/api/types'

const stat = (trades: number, netR: number): IncubatorStats => ({
  trades,
  netR,
  avgR: trades ? netR / trades : 0,
  days: 7,
  wins: trades,
  winRatePct: 100,
  pfR: null,
  weeks: 1,
  positiveWeeks: 1,
  positiveWeeksPct: 100,
  tStat: 0,
})

for (const pool of ['pair', 'cohort'] as const)
  test(`Incubator ${pool} distinguishes restored history, qualification and overdue collection`, async ({
    page,
    faults,
    writes,
  }) => {
    void faults
    const data = structuredClone(incubator)
    data.config.gate.pool = pool
    data.pairs = data.pairs.map((p, i) => ({
      ...p,
      scannerId: 'reader',
      scannerName: 'Reader',
      stats: stat(90, 30),
      paperCopy: {
        eligible: false,
        reason: i
          ? 'restored cell in forward shadow evaluation: 1/20 trades'
          : 'mirror held: 4/5 shadow closes',
        evidence: {
          at: Date.now(),
          minTrades: 5,
          minNetR: 0,
          stats: stat(i ? 0 : 4, i ? 0 : 0.19),
          exact: 0,
          replayed: i ? 0 : 4,
          feeCompatible: 0,
          available: i ? 1 : 4,
          availableReplayed: i ? 1 : 4,
        },
      },
      restoration: i ? { state: 'evaluating', passed: false, reasons: ['1/20 trades'] } : null,
      collection: {
        active: true,
        status: 'scan overdue',
        lastSuccessBar: 1,
        nextCloseAt: Date.now(),
        scan: {
          bar_time: 2,
          at: 3,
          status: 'expired',
          reason: 'unchanged deadline',
          last_success_bar: 1,
          last_success_at: 2,
          entry_signals: 0,
        },
        entries: { filled: 0, open: 0, pending: 0 },
        funnel: p.funnel!,
      },
    }))
    await page.route('**/api/incubator', (route) => route.fulfill({ json: data }))
    await page.goto('/incubator')
    await page.getByText('Why other cells do not qualify', { exact: true }).click()
    await expect(page.getByText('1 need more compatible closes · 1 need forward evaluation')).toBeVisible()
    await expect(
      page.getByText(/Replay restored compatible history for 2 cells; 0 of those pass/),
    ).toBeVisible()
    const sample = page.getByLabel('Paper-copy evidence for reader ETHUSD 15m', { exact: true })
    await expect(sample).toContainText('4/5 qualifying closes')
    await expect(sample).toContainText('4 replay-verified')
    await expect(sample).toContainText('Journal in this stage: 90 closes across recorded policies.')
    await expect(sample).toContainText('Scan: scan overdue · last attempt expired')
    const held = page.getByLabel('Paper-copy evidence for reader SOLUSD 15m', { exact: true })
    await expect(held).toContainText('0/5 qualifying closes')
    await expect(held).toContainText('1 compatible closes held for forward evaluation')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(writes).toEqual([])
  })
