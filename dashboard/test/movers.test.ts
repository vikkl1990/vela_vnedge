import { test } from 'node:test'
import assert from 'node:assert/strict'
import { arrowFor, heldSides, HOT_PCT, pickMovers } from '../src/lib/movers.ts'
import type { MoverRow } from '../src/api/types'

const row = (
  symbol: string,
  ch5: number | null,
  ch15: number | null = null,
  ch60: number | null = null,
): MoverRow => ({
  symbol,
  price: 1,
  ch5,
  ch15,
  ch60,
  peak: Math.max(...[ch5, ch15, ch60].filter((v): v is number => v !== null).map(Math.abs)),
  group: 'alts',
  sector: 'other',
})

test('movers are ranked by size in the chosen window, not by sign or by another window', () => {
  const rows = [row('AUSD', 0.2, 9), row('BUSD', -3.1, 0), row('CUSD', 2.0, 1), row('DUSD', null, 7)]
  const five = pickMovers(rows, 5)
  assert.deepEqual(
    five.map((p) => p.row.symbol),
    ['BUSD', 'CUSD', 'AUSD'],
    'DUSD has no 5 minute figure and is left out',
  )
  assert.deepEqual(
    pickMovers(rows, 15).map((p) => p.row.symbol),
    ['AUSD', 'DUSD', 'CUSD', 'BUSD'],
  )
})

test('a move is hot only past the threshold for its window', () => {
  const [big, small] = pickMovers([row('AUSD', HOT_PCT[5]), row('BUSD', HOT_PCT[5] - 0.01)], 5)
  assert.equal(big.hot, true)
  assert.equal(small.hot, false)
  assert.equal(pickMovers([row('AUSD', -HOT_PCT[5])], 5)[0].hot, true, 'a dump is as hot as a pump')
})

test('the list is capped', () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(`M${i}USD`, i + 1))
  assert.equal(pickMovers(rows, 5, 8).length, 8)
  assert.equal(pickMovers(rows, 5)[0].row.symbol, 'M19USD')
})

test('the account side per market is the first open position', () => {
  const m = heldSides([
    { symbol: 'AUSD', side: 'long' },
    { symbol: 'AUSD', side: 'short' },
    { symbol: 'BUSD', side: 'short' },
  ])
  assert.equal(m.get('AUSD'), 'long')
  assert.equal(m.get('BUSD'), 'short')
  assert.equal(m.get('CUSD'), undefined)
})

test('direction is carried by an arrow as well as by colour', () => {
  assert.equal(arrowFor(1), '▲')
  assert.equal(arrowFor(-1), '▼')
  assert.equal(arrowFor(0), '–')
})
