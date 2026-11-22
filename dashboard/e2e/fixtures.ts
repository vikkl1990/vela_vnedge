import { test as base, expect } from '@playwright/test'
import type { Signal, Scanner, Stats, Health } from '../src/api/types'
import type { TradeMonitorView } from '../src/api/tradeMonitor'
const now = Date.now()
export const health: Health = {
  status: 'ok',
  uptimeSec: 120,
  mode: 'paper',
  now,
  feed: { connected: true, lastTickAt: now, subscriptions: [] },
  scanners: { total: 206, runnable: 206, enabled: 206 },
  worker: { size: 4, queued: 0, busy: 0 },
  lastError: null,
}
const scannerStats = {
  trades: 0,
  wins: 0,
  losses: 0,
  pnl: 0,
  pnlPct: 0,
  avgR: 0,
  maxDrawdownPct: 0,
  profitFactor: 0,
  winRatePct: 0,
  open: 0,
  signals: 0,
}
export const scanners: Scanner[] = Array.from({ length: 206 }, (_, i) => ({
  id: `scanner-${i}`,
  name: `Scanner ${String(i).padStart(3, '0')}`,
  file: 'fixture.pine',
  url: 'https://example.invalid',
  status: 'ok',
  reason: null,
  enabled: true,
  active: true,
  overlay: true,
  pineVersion: '6',
  lines: 100,
  symbols: ['ETHUSD'],
  timeframes: ['15m'],
  exitMode: 'both',
  lastRun: null,
  stats: scannerStats,
  books: { account: ['ETHUSD'], shadow: [], proposed: [] },
}))
export const signals: Signal[] = scanners.map((s, i) => ({
  id: i + 1,
  at: now - i * 1000,
  barTime: now - 900000,
  scannerId: s.id,
  scannerName: s.name,
  symbol: 'ETHUSD',
  tf: '15m',
  kind: 'entry',
  side: i % 2 ? 'short' : 'long',
  price: 2000 + i,
  sl: 1900,
  tp: [2100, 2200, 2300],
  score: 72,
  label: 'Confirmed entry',
  message: 'Closed bar entry with recorded price, risk and fees',
  source: 'alert',
  levelsSource: 'native',
  action: i % 3 ? 'rejected: fee risk ratio' : 'opened',
  positionId: i % 3 ? null : i + 1,
}))
export const stats: Stats = {
  equity: 1000,
  initialEquity: 1000,
  closedPnl: 0,
  closedFees: 0,
  openPnl: 0,
  openFees: 0,
  peakEquity: 1000,
  drawdownPct: 0,
  openPositions: 0,
  trades: 0,
  wins: 0,
  losses: 0,
  winRatePct: 0,
  profitFactor: 0,
  maxDrawdownPct: 0,
  byScanner: {},
  bySymbol: {},
}
export const monitor: TradeMonitorView = {
  mode: 'advisory',
  version: 'fixture',
  at: now,
  generatedAt: now,
  marketError: null,
  retention: 'Fixture only',
  rules: [],
  positions: [],
  trials: [],
  summary: [],
  connections: { symbols: 272, connections: 2, connected: 2 },
  pairs: Array.from({ length: 272 }, (_, i) => ({
    symbol: `PAIR${String(i).padStart(3, '0')}USD`,
    active: true,
    change24hPct: 1,
    volume24h: 1e7,
    depthAt: now,
    depthFresh: true,
    priceAt: now,
    flow: { covered: true, imbalance: 0.3, throughAt: now, minutes: 5 },
    paper: { trades: 4, stops: 1, net: 2, r: i % 2 ? -1 : 2 },
    shadow: { trades: 8, stops: 2, net: null, r: 1 },
    paperOpen: 0,
    shadowOpen: 0,
    researchOpen: 0,
    worstOpenR: null,
  })),
}
const fixtures: Record<string, unknown> = {
  '/auth/status': { configured: true, canSetup: false },
  '/auth/me': {
    user: { id: 1, username: 'test-admin', displayName: 'Test', role: 'admin', roleLabel: 'Administrator' },
    permissions: ['read', 'trade', 'backtest', 'admin'],
    sessions: 1,
  },
  '/health': health,
  '/stats': stats,
  '/positions': [],
  '/positions/health': { at: now, positions: [] },
  '/orders': [],
  '/markets': [{ symbol: 'ETHUSD', tickSize: 0.01, name: 'Ethereum' }],
  '/scanners': scanners,
  '/config': {
    symbols: ['ETHUSD'],
    timeframes: ['15m'],
    paper: {
      initialEquity: 1000,
      sizingMode: 'margin',
      marginPerTrade: 150,
      maxStopLossPct: 3,
      riskPerTradePct: 1,
      maxLeverage: 6,
      minLeverage: 5,
      maxOpenPositions: 8,
      liquidation: true,
      maintenanceMarginPct: 0.5,
      minRiskFeeRatio: 6,
      feeRatePct: 0.05,
      makerFeeRatePct: 0.02,
      feeTaxPct: 18,
      slippageBps: 1,
      tpSplit: [0.3, 0.3, 0.4],
      breakEvenAfterTp1: true,
      allowReversal: true,
      fallbackAtrSl: 2,
      fallbackRR: [2, 4, 6],
    },
    scanners: {},
    execution: { mode: 'paper' },
  },
  '/execution': {
    mode: 'paper',
    host: null,
    hasKeys: false,
    dryRun: false,
    bracket: false,
    brackets: [],
    lastReconcile: null,
  },
  '/risk': {
    halted: false,
    drawdown: { multiplier: 1 },
    day: { pnl: 0, pnlPct: 0, limitPct: 6 },
    week: { pnl: 0, pnlPct: 0, limitPct: 12 },
  },
  '/context': { global: null, markets: [] },
  '/signals/activity': {
    at: now,
    since: now - 86400000,
    entries: 206,
    candidates: 206,
    copyHeld: 0,
    held: [],
    copyRecordedSince: now - 86400000,
    paperFilled: 69,
    shadowFilled: 91,
  },
  '/trade-monitor': monitor,
  '/scanner-pipeline': {
    at: now,
    since: now - 86400000,
    cells: [],
    quarantined: 0,
    unallocated: [],
    entryDepth: { enabled: true, requests: 0, checks: 0, blocked: 0, errors: 0, inFlight: 0, queued: 0 },
    shadowDispatch: {
      pending: 0,
      inFlight: 0,
      offered: 0,
      replaced: 0,
      expired: 0,
      finished: 0,
      maxWaitMs: 0,
    },
    queue: { queued: 0, queuedLive: 0, queuedMirror: 0, queuedShadow: 0 },
  },
}
export const test = base.extend<{ writes: string[]; faults: string[] }>({
  writes: async ({ page }, provide) => {
    const writes: string[] = []
    await page.route('**/api/**', async (route) => {
      const req = route.request(),
        url = new URL(req.url()),
        key = url.pathname.replace(/^\/api/, '')
      if (!url.pathname.startsWith('/api/')) {
        await route.continue()
        return
      }
      if (req.method() !== 'GET') {
        writes.push(`${req.method()} ${key}`)
        await route.fulfill({ status: 200, json: { ok: true } })
        return
      }
      if (key === '/events') {
        await route.abort()
        return
      }
      if (key === '/signals') {
        let data = signals
        for (const field of ['scanner', 'symbol', 'tf', 'kind', 'side']) {
          const value = url.searchParams.get(field)
          if (value)
            data = data.filter(
              (s) =>
                s[field === 'scanner' ? 'scannerId' : (field as 'symbol' | 'tf' | 'kind' | 'side')] === value,
            )
        }
        await route.fulfill({ json: data })
        return
      }
      await route.fulfill(
        key in fixtures
          ? { json: fixtures[key] }
          : { status: 503, json: { error: 'Unavailable in isolated UI test' } },
      )
    })
    await provide(writes)
  },
  faults: async ({ page, writes }, provide) => {
    void writes
    const faults: string[] = []
    page.on('pageerror', (e) => faults.push(e.message))
    await page.addInitScript(() => {
      localStorage.setItem('vnedge.theme', 'dark')
      // A deterministic stream: API reads and mutations remain intercepted above.
      class FakeEventSource {
        onopen: (() => void) | null = null
        onerror: (() => void) | null = null
        constructor() {
          setTimeout(() => this.onopen?.(), 0)
        }
        listeners = new Map<string, (e: MessageEvent) => void>()
        receive = (e: Event) => {
          const { name, data } = (e as CustomEvent<{ name: string; data: unknown }>).detail
          this.listeners.get(name)?.(new MessageEvent(name, { data: JSON.stringify(data) }))
        }
        addEventListener(name: string, listener: (e: MessageEvent) => void) {
          this.listeners.set(name, listener)
          window.addEventListener('fixture-sse', this.receive)
        }
        close() {
          window.removeEventListener('fixture-sse', this.receive)
        }
      }
      Object.defineProperty(window, 'EventSource', { value: FakeEventSource })
    })
    await provide(faults)
    expect(faults).toEqual([])
  },
})
export { expect }
