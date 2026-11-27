import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { SignalReceipt } from '../../shared/chartVerification'
import { test, expect, scanners } from './fixtures'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const T = Date.UTC(2026, 10, 12),
  M = 900000
const bars = Array.from({ length: 200 }, (_, i) => ({
  time: T + i * M,
  open: 100,
  high: 102,
  low: 99,
  close: 101,
  volume: 1000,
}))
const source = `//@version=6
indicator("Channel verification", overlay=true, max_labels_count=100)
plot(syminfo.pointvalue, "Signal point value")
plot(syminfo.mincontract, "Signal minimum")
alertcondition(close > open, title="Long condition", message="confirmed condition")
if barstate.isconfirmed
    alert("LONG | Price: 101 | SL: 99 | TP1: 103", alert.freq_all)
    label.new(bar_index - 1, high, "Buy", style=label.style_label_up, tooltip="vn:" + str.tostring(bar_index))
`

test('installed bridge matches real server alerts, conditions, label stamps and signal units on the same closed candles', async ({
  page,
  faults,
  writes,
}, info) => {
  void faults
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vnedge-chart-parity-'))
  try {
    const input = path.join(dir, 'input.json')
    writeFileSync(input, JSON.stringify({ source, bars: bars.slice(0, 199) }), { mode: 0o600 })
    execFileSync(
      process.execPath,
      [
        '--no-warnings=ExperimentalWarning',
        fileURLToPath(new URL('./channelReceipt.mjs', import.meta.url)),
        input,
      ],
      { env: { ...process.env, VNEDGE_DATA_DIR: dir }, timeout: 15000, stdio: 'pipe' },
    )
    const closed = bars.slice(0, 199)
    const receipt = JSON.parse(readFileSync(input + '.receipt.json', 'utf8')) as SignalReceipt
    expect(receipt.channels!.alerts.length).toBeGreaterThan(0)
    expect(receipt.channels!.labels.length).toBeGreaterThan(0)
    await page.route(/\/api\/scanners(?:\?.*)?$/, (r) => r.fulfill({ json: scanners.slice(0, 1) }))
    await page.route('**/api/scanners/*/source', (r) =>
      r.fulfill({
        json: {
          id: 'scanner-0',
          name: 'Channel verification',
          patched: source,
          sourceHash: receipt.sourceHash,
          readingHash: receipt.readingHash,
          inputs: {},
          timezone: 'UTC',
        },
      }),
    )
    await page.route('**/api/candles?**', (r) =>
      r.fulfill({ json: new URL(r.request().url()).searchParams.has('from') ? closed : bars }),
    )
    await page.route('**/api/scanners/*/chart-receipt?**', (r) => r.fulfill({ json: receipt }))
    await page.goto('/chart?symbol=ETHUSD&tf=15m&add=scanner-0')
    const panel = page.getByRole('region', { name: 'Chart versus bot signal checks' })
    await expect(panel).toContainText('Closed-bar plots, alerts and labels agree; bot signals shown', {
      timeout: 25000,
    })
    await expect(panel).toContainText('entry long')
    receipt.channels!.alerts = []
    await page.reload()
    await expect(panel).toContainText('Closed-bar signal outputs differ', { timeout: 25000 })
    await expect(panel).toContainText('alert payloads')
    expect(writes).toEqual([])
    await page.screenshot({ path: info.outputPath('channel-parity.png'), fullPage: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
