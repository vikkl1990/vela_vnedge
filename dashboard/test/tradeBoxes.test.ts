import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JournalRow } from '../src/api/journal.ts'
import type { Position } from '../src/api/types.ts'
import { tradeBoxesFrom, tradeBoxesOutput } from '../src/chart/tradeBoxes.ts'

const row = (o: Partial<JournalRow>): JournalRow => ({ id: 1, symbol: 'EVAAUSD', tf: '5m', side: 'long', entryAt: 600_000, exitAt: 1_200_000, entryPrice: 2, exitPrice: 2.1, slOriginal: 1.9, sl: 1.9, targets: [2.1, 2.2], net: 5, realizedNet: 5, r: 1, exitReason: 'tp1', ...o }) as JournalRow
const bars = Array.from({ length: 10 }, (_, i) => ({ time: i * 300_000, open: 2, high: 2.2, low: 1.8, close: 2.05, volume: 1 }))
const ctx = { id: 'tb', symbol: 'delta:EVAAUSD', timeframe: '5', bars: () => bars } as unknown as Parameters<typeof tradeBoxesOutput>[0]

test('closed trades become boxes from entry to exit, coloured by result, with stop and target lines', () => {
  const p = tradeBoxesFrom('EVAAUSD', '5m', [row({}), row({ id: 2, net: -4, exitPrice: 1.9, r: -1 }), row({ id: 3, tf: '1h' }), row({ id: 4, symbol: 'BTCUSD' })], [])
  assert.equal(p.boxes.length, 2, 'only this market and timeframe')
  const out = tradeBoxesOutput(ctx, p)
  assert.equal(out.boxes!.length, 2)
  const [win, loss] = out.boxes!
  assert.equal(win.left, 600_000)
  assert.equal(win.right, 1_200_000)
  assert.equal(win.top, 2.1)
  assert.equal(win.bottom, 2)
  assert.match(win.borderColor!, /^#3fb950/)
  assert.match(loss.borderColor!, /^#e5484d/)
  assert.equal(out.lines!.length, 6, 'a stop and two targets per trade')
})

test('an open trade runs to the latest bar and is coloured by the latest close', () => {
  const open = { id: 9, symbol: 'EVAAUSD', tf: '5m', side: 'short', entryAt: 1_500_000, entryPrice: 2.1, sl: 2.2, slOriginal: 2.2, tp: [2.0, null] } as unknown as Position
  const out = tradeBoxesOutput(ctx, tradeBoxesFrom('EVAAUSD', '5m', [], [open]))
  const b = out.boxes![0]
  assert.equal(b.right, bars[9].time + 300_000)
  assert.equal(b.bottom, 2.05, 'spans to the latest close')
  assert.match(b.borderColor!, /^#3fb950/, 'a short below its entry is winning')
  assert.equal(tradeBoxesOutput({ ...ctx, symbol: 'delta:BTCUSD' }, tradeBoxesFrom('EVAAUSD', '5m', [], [open])).boxes!.length, 0, 'another market draws nothing')
})
