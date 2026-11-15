import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PineTS } from 'pinets'
import type { ScriptingEngine, ExecutionMarket } from '@luxalgo/vela/plugin'
import type { JournalRow } from '../src/api/journal'
import type { PathLevels } from '../src/api/types'
import { replayOverlay } from '../src/chart/replayOverlay.ts'
import { withScriptTimezones } from '../src/chart/scriptTimezone.ts'
import {
  authorTradeMarks,
  botTradeMarks,
  compareTrades,
  settledTrades,
  type AuthorLedger,
} from '../src/chart/tradeComparison.ts'

const T = Date.UTC(2026, 10, 15),
  M = 900000
const row = (patch: Partial<JournalRow> = {}): JournalRow =>
  ({
    id: 1,
    book: 'paper',
    status: 'closed',
    scannerId: 's',
    sourceScannerId: 's',
    sourceHash: 'abc',
    symbol: 'ETHUSD',
    tf: '15m',
    side: 'long',
    entryAt: T + 2000,
    exitAt: T + 2 * M,
    entryPrice: 100,
    exitPrice: 102,
    net: 1.8,
    r: 0.18,
    commission: 0.2,
    funding: 0,
    fills: [
      { at: T + 2000, price: 100, qty: 2, reason: 'entry', fee: 0.1, pnl: 0 },
      { at: T + M, price: 101, qty: 1, reason: 'tp1', fee: 0.05, pnl: 1 },
      { at: T + 2 * M, price: 102, qty: 1, reason: 'trail', fee: 0.05, pnl: 1 },
      { at: T + M, price: 100, qty: 0, reason: 'funding', fee: 0, pnl: -0.1 },
    ],
    ...patch,
  }) as JournalRow
const ledger: AuthorLedger = {
  id: 's',
  title: 'Strategy',
  symbol: 'ETHUSD',
  tf: '15m',
  contextKey: 'x',
  sourceHash: 'abc',
  timezone: 'UTC',
  kind: 'strategy',
  from: T - M,
  through: T + 4 * M,
  complete: true,
  updatedAt: T,
  trades: [
    {
      id: 'a',
      side: 'long',
      qty: 2,
      entry: { id: 'Long', time: T, price: 100 },
      exit: { id: 'Exit', time: T + 3 * M, price: 103 },
      open: false,
    },
  ],
}

test('replay labels compile with quotes, backslashes, newlines and non-ASCII author text', async () => {
  const bars = Array.from({ length: 5 }, (_, i) => ({
    openTime: T + i * M,
    closeTime: T + (i + 1) * M - 1,
    open: 100,
    high: 103,
    low: 99,
    close: 102,
    volume: 100,
  }))
  for (const reason of ['trail', 'author "exit"', 'Cierre \\ Long\nnext line', 'Long → Short']) {
    const levels = {
      id: 1,
      side: 'long',
      entryAt: T,
      entryPrice: 100,
      sl: 95,
      slOriginal: 95,
      tp: [],
      exitAt: T + M,
      exitPrice: 102,
      exitReason: reason,
    } as unknown as PathLevels
    const script = replayOverlay(levels, [], M, 0.2)
    const engine = new PineTS(bars)
    await engine.run(script.source)
  }
})

test('timezone metadata stays isolated across scripts, preserves symbol fields and defaults', async () => {
  const seen: ExecutionMarket[] = []
  const engine: ScriptingEngine = {
    language: 'pine',
    capabilities: { streaming: false, visibleRange: false, inputs: false },
    async prepare() {
      return {
        language: 'pine',
        inputs: [],
        meta: { title: 'test', overlay: true },
        reactsToViewport: false,
        token: {},
      }
    },
    execute(req) {
      seen.push(req.market)
      return {} as ReturnType<ScriptingEngine['execute']>
    },
  }
  const adapter = withScriptTimezones(engine, (id) =>
    id === 'ny' ? 'America/New_York' : id === 'utc' ? 'UTC' : undefined,
  )
  const market = {
    symbol: 'ETHUSD',
    timeframe: '15',
    symbolInfo: { ticker: 'ETHUSD', timezone: 'Asia/Kolkata' },
  }
  for (const id of ['ny', 'utc', 'unconfigured']) {
    const prepared = await adapter.engine.prepare('', id)
    adapter.engine.execute(
      {
        prepared,
        market,
        bars: [{ time: T, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
        mode: 'static',
      },
      { onModel() {} },
    )
  }
  assert.deepEqual(
    seen.map((m) => m.symbolInfo?.timezone),
    ['America/New_York', 'UTC', 'Asia/Kolkata'],
  )
  assert.equal(market.symbolInfo.timezone, 'Asia/Kolkata')
  assert.equal(seen[0].symbolInfo?.ticker, 'ETHUSD')
  assert.equal(adapter.firstBar('ny'), T)
})

test('only unambiguous, same-source, same-side, same-frame entry bars are associated', () => {
  assert.equal(compareTrades([row()], ledger)[0].status, 'same entry bar')
  assert.equal(compareTrades([row({ sourceHash: 'old' })], ledger)[0].status, 'source changed')
  assert.equal(compareTrades([row({ sourceHash: null })], ledger)[0].status, 'source unknown')
  assert.equal(compareTrades([row({ side: 'short' })], ledger)[0].status, 'no same-bar entry')
  assert.equal(compareTrades([row({ entryAt: T - 2 * M })], ledger)[0].status, 'outside loaded history')
  assert.equal(compareTrades([row(), row({ id: 2 })], ledger)[0].status, 'ambiguous')
  assert.equal(
    compareTrades([row()], { ...ledger, trades: [...ledger.trades, { ...ledger.trades[0], id: 'b' }] })[0]
      .status,
    'ambiguous',
  )
  assert.equal(compareTrades([row()], { ...ledger, inputsChanged: true })[0].status, 'chart inputs changed')
  assert.deepEqual(compareTrades([row({ tf: '1h' }), row({ symbol: 'BTCUSD' })], ledger), [])
  assert.equal(
    compareTrades([row({ scannerId: 'plan:x', sourceScannerId: 's' })], ledger)[0].status,
    'same entry bar',
  )
})

test('forming fills remain provisional; a not-yet-settled exit cannot leak a result', () => {
  const trades = [
    ...ledger.trades,
    { ...ledger.trades[0], id: 'forming', entry: { id: 'f', time: T + 3 * M, price: 103 } },
  ]
  const settled = settledTrades(trades, T + 3 * M)
  assert.equal(settled.length, 1)
  assert.equal(settled[0].open, true)
  assert.equal(settled[0].exit, undefined)
  assert.equal(ledger.trades[0].open, false)
})

test('timeline uses actual fill times, includes partials, omits funding and distinguishes author simulation', () => {
  const marks = botTradeMarks([row(), row({ id: 2, status: 'pending' })])
  assert.deepEqual(
    marks.map((m) => m.time),
    [T + 2000, T + M, T + 2 * M],
  )
  assert.deepEqual(
    marks.map((m) => m.glyph?.letter),
    ['B', 'P', 'X'],
  )
  assert.match(marks[2].title!, /0.18R/)
  assert.equal(authorTradeMarks([ledger]).length, 2)
  assert.equal(authorTradeMarks([{ ...ledger, complete: false }]).length, 0)
  assert.match(authorTradeMarks([ledger])[0].tooltip!, /AUTHOR SIMULATION/)
  assert.notEqual(botTradeMarks([row()])[0].id, botTradeMarks([row({ book: 'shadow' })])[0].id)
})
