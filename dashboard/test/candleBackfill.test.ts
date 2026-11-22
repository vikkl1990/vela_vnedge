import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { CandleBackfill } from '../src/chart/candleBackfill.ts'
import type { Candle } from '../src/api/types.ts'

const M = 60_000
const bar = (time: number, close = 100): Candle => ({ time, open: 100, high: 110, low: 90, close, volume: 1 })
const fail = (error: unknown) => {
  throw error
}

test('gap history precedes buffered live updates and ticks; delayed seeds cannot rewind it', async () => {
  const seen: Candle[] = []
  let resolve!: (rows: Candle[]) => void
  const stream = new CandleBackfill(
    M,
    (b) => seen.push(b),
    () =>
      new Promise((r) => {
        resolve = r
      }),
    fail,
  )
  stream.candle(bar(M), true)
  stream.candle(bar(4 * M), false)
  stream.candle(bar(4 * M, 102), true)
  stream.candle(bar(4 * M, 99), false)
  stream.candle(bar(5 * M, 103), false)
  stream.tick(104, 5 * M + 1)
  stream.candle(bar(0), true)
  assert.deepEqual(
    seen.map((b) => b.time),
    [M],
  )
  resolve([bar(3 * M), bar(M), bar(2 * M), bar(4 * M), bar(100 * M)])
  await setImmediate()
  assert.deepEqual(
    seen.map((b) => b.time),
    [M, 2 * M, 3 * M, 4 * M, 5 * M, 5 * M],
  )
  assert.equal(seen[3].close, 102, 'closed live data wins over history and stale forming events')
  assert.equal(seen.at(-1)?.close, 104)
})

test('large gaps are requested in bounded ranges, sorted and deduplicated', async () => {
  const seen: number[] = [],
    ranges: number[][] = []
  const stream = new CandleBackfill(
    M,
    (b) => seen.push(b.time),
    async (from, to, limit) => {
      ranges.push([from, to, limit])
      return Array.from({ length: (to - from) / M + 1 }, (_, i) => bar(from + i * M)).reverse()
    },
    fail,
  )
  stream.candle(bar(M), true)
  stream.candle(bar(1102 * M), false)
  await setImmediate()
  assert.equal(ranges.length, 3)
  assert.ok(ranges.every(([from, to]) => (to - from) / M <= 499))
  assert.deepEqual(
    seen,
    Array.from({ length: 1102 }, (_, i) => (i + 1) * M),
  )
})

test('failed or empty history releases live data without inventing missing candles', async () => {
  for (const rejects of [true, false]) {
    const seen: number[] = [],
      errors: unknown[] = []
    const stream = new CandleBackfill(
      M,
      (b) => seen.push(b.time),
      async () => {
        if (rejects) throw new Error('offline')
        return []
      },
      (e) => errors.push(e),
    )
    stream.candle(bar(M), true)
    stream.candle(bar(4 * M), false)
    await setImmediate()
    stream.candle(bar(5 * M), false)
    assert.deepEqual(seen, [M, 4 * M, 5 * M])
    assert.equal(errors.length, rejects ? 1 : 0)
  }
})

test('unsubscription during backfill suppresses all subsequent callbacks', async () => {
  const seen: number[] = []
  let resolve!: (rows: Candle[]) => void
  const stream = new CandleBackfill(
    M,
    (b) => seen.push(b.time),
    () =>
      new Promise((r) => {
        resolve = r
      }),
    fail,
  )
  stream.candle(bar(M), true)
  stream.candle(bar(4 * M), false)
  stream.stop()
  resolve([bar(2 * M), bar(3 * M)])
  await setImmediate()
  stream.candle(bar(5 * M), false)
  stream.tick(102, 5 * M + 1)
  assert.deepEqual(seen, [M])
})

test('reconnect finalizes the previously forming candle before delivering newer candles', async () => {
  const seen: Candle[] = []
  const stream = new CandleBackfill(
    M,
    (b) => seen.push(b),
    async (from) => {
      assert.equal(from, M)
      return [bar(M, 108), bar(2 * M)]
    },
    fail,
  )
  stream.candle(bar(M, 101), false)
  stream.candle(bar(3 * M), false)
  await setImmediate()
  assert.deepEqual(
    seen.map((b) => [b.time, b.close]),
    [
      [M, 101],
      [M, 108],
      [2 * M, 100],
      [3 * M, 100],
    ],
  )
})
