import { signalSymbolInfo, signalMetadataText } from '../../shared/signalMetadata'
import { createHash } from 'node:crypto'
import { chartHistoryText } from '../../shared/chartVerification'
import type { Vela } from '@luxalgo/vela'
import { test, expect, scanners } from './fixtures'
import type { SignalReceipt, FillComparison } from '../../shared/chartVerification'

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
const source =
  '//@version=5\nindicator("Signal parity", overlay=true)\nplot(7,"Value")\nplotshape(close > open, title="Buy", style=shape.triangleup)\nplotshape(close < open, title="Buy", style=shape.triangledown)'

test('closed-bar chart checks expose agreement, differences and input context without trading writes', async ({
  page,
  faults,
  writes,
}, info) => {
  void faults
  const receipt: SignalReceipt = {
    scannerId: 'scanner-0',
    symbol: 'ETHUSD',
    tf: '15m',
    barTime: T + 198 * M,
    at: Date.now(),
    sourceHash: 'parity',
    readingHash: 'reading-v1',
    inputs: {},
    timezone: 'UTC',
    historyFrom: T,
    bars: 199,
    historyHash: createHash('sha256')
      .update(chartHistoryText(bars, T + 198 * M))
      .digest('hex'),
    candle: bars[198],
    outputs: {
      Value: { kind: 'plot', value: 7 },
      Buy: { kind: 'shape', value: 1 },
      'Buyplotshape#1': { kind: 'shape', value: 0 },
    },
    signals: [{ kind: 'entry', side: 'long', label: 'Buy', source: 'shape' }],
    signalMetadata: signalMetadataText(signalSymbolInfo('ETHUSD', 0.01, 'UTC')),
    channels: { alerts: [], labels: [], labelsVerified: true, truncated: false },
    signalCoverage: 'shape',
    truncated: false,
  }
  await page.route(/\/api\/scanners(?:\?.*)?$/, (r) => r.fulfill({ json: scanners.slice(0, 1) }))
  await page.route('**/api/scanners/*/source', (r) =>
    r.fulfill({
      json: {
        id: 'scanner-0',
        name: 'Signal parity',
        sourceHash: 'parity',
        readingHash: 'reading-v1',
        patched: source,
        inputs: {},
        timezone: 'UTC',
      },
    }),
  )
  await page.route('**/api/candles?**', (r) =>
    r.fulfill({ json: new URL(r.request().url()).searchParams.has('from') ? bars.slice(0, 199) : bars }),
  )
  await page.route('**/api/scanners/*/chart-receipt?**', (r) => r.fulfill({ json: receipt }))
  await page.goto('/chart?symbol=ETHUSD&tf=15m&add=scanner-0')
  const panel = page.getByRole('region', { name: 'Chart versus bot signal checks' })
  await expect(panel).toContainText('Closed-bar plots, alerts and labels agree; bot signals shown', {
    timeout: 30000,
  })
  await expect(panel).toContainText('entry long · Buy')
  receipt.outputs.Value.value = 9
  await page.reload()
  await expect(panel).toContainText('Closed-bar signal outputs differ', { timeout: 30000 })
  await expect(panel).toContainText('Value')
  receipt.outputs.Value.value = 7
  receipt.historyHash = 'different'
  await page.reload()
  await expect(panel).toContainText('Candle data differs; outputs not comparable', { timeout: 30000 })
  receipt.sourceHash = 'different'
  await page.reload()
  await expect(panel).toContainText('Source, inputs or execution context differs', { timeout: 30000 })
  expect(writes).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('signal-parity.png'), fullPage: true })
})

test('trade replay distinguishes exact depth, public tape and unverified candle fills', async ({
  page,
  faults,
  writes,
}, info) => {
  void faults
  const position = {
    id: 701,
    scannerId: 'scanner-0',
    scannerName: 'Recorded strategy',
    symbol: 'ETHUSD',
    tf: '15m',
    side: 'long',
    status: 'closed',
    qty: 2,
    qtyOpen: 0,
    contractValue: 1,
    entryPrice: 100,
    entryAt: T + 10 * M,
    exitAt: T + 20 * M,
    exitPrice: 99,
    exitReason: 'sl',
    sl: 99,
    slOriginal: 99,
    tp: [102, 104, 106],
    legs: [0, 0, 2],
    tpHit: [false, false, false],
    breakEven: false,
    markPrice: 99,
    unrealizedPnl: 0,
    realizedPnl: -2,
    fees: 0.1,
    riskAmount: 2,
    rMultiple: -1.05,
    fills: [],
  }
  const comparison: FillComparison = {
    positionId: 701,
    symbol: 'ETHUSD',
    book: 0,
    fills: [
      {
        id: 1,
        at: position.entryAt,
        reason: 'entry',
        side: 'buy',
        qty: 2,
        price: 100,
        source: 'limit-candle-model',
        maker: 'Candle-model fill; tick timing and queue unverified',
        depth: {
          status: 'No exact depth retained',
          price: null,
          deltaBps: null,
          receivedAt: null,
          readyAt: null,
        },
        tape: { status: 'No tape benchmark retained', first: null, vwap: null, deltaBps: null },
      },
      {
        id: 2,
        at: position.exitAt,
        reason: 'sl',
        side: 'sell',
        qty: 2,
        price: 99,
        source: 'depth',
        maker: null,
        depth: {
          status: 'Recorded exit depth',
          price: 99,
          deltaBps: 0,
          receivedAt: position.exitAt,
          readyAt: position.exitAt - 1000,
        },
        tape: {
          status: 'Public print benchmark; not executable depth',
          first: 98.9,
          vwap: 98.8,
          deltaBps: 20.2,
        },
      },
    ],
  }
  await page.route('**/api/positions/701/path', (r) => r.fulfill({ json: { position, path: [] } }))
  await page.route('**/api/positions/701/fill-comparison', (r) => r.fulfill({ json: comparison }))
  await page.route('**/api/candles?**', (r) => r.fulfill({ json: bars }))
  await page.goto('/trades/701/replay')
  const panel = page.getByRole('region', { name: 'Tick and depth fill comparison' })
  await expect(panel).toContainText('Candle-model fill; tick timing and queue unverified')
  await expect(panel).toContainText('Recorded exit depth')
  await expect(panel).toContainText('+20.20 bps')
  await expect(panel).toContainText('Public print benchmark; not executable depth')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __vnChart?: Vela }).__vnChart?.marks
            .all()
            .filter((m) => m.group === 'fill-evidence').length ?? 0,
      ),
    )
    .toBe(2)
  expect(writes).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('fill-comparison.png'), fullPage: true })
})
