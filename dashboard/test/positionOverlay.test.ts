import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NativeIndicatorContext, NativeIndicatorOutput } from '@luxalgo/vela'
import type { Position } from '../src/api/types.ts'
import { positionOverlay, positionLevelsIndicator } from '../src/chart/positionOverlay.ts'

const position = {
  id: 7,
  symbol: 'ETHUSD',
  side: 'short',
  entryPrice: 100,
  slOriginal: 110,
  sl: 98,
  tp: [90, 80, 70],
  legs: [0, 0, 2],
  tpHit: [false, false, false],
} as Position

test('native position levels preserve stop, risk, target sizes and short-side peak', () => {
  const p = positionOverlay(position, 0.4)
  assert.deepEqual(
    p.levels.map((l) => [l.price, l.label]),
    [
      [100, 'entry'],
      [110, 'stop −1R'],
      [98, 'stop now +0.20R'],
      [90, 'TP1 +1.0R (no size)'],
      [80, 'TP2 +2.0R (no size)'],
      [70, 'TP3 +3.0R'],
      [96, 'peak +0.40R'],
    ],
  )
  assert.equal(
    positionOverlay({ ...position, sl: NaN }).levels.some((l) => !Number.isFinite(l.price)),
    false,
  )
})

test('native levels update only on actual changes, never on ticks or viewport moves; replay hides live stops', () => {
  const output: NativeIndicatorOutput[] = []
  const context = (symbol = 'delta:ETHUSD', live = true) =>
    ({
      id: 'position',
      symbol,
      live,
      emit: (o: NativeIndicatorOutput) => output.push(o),
    }) as NativeIndicatorContext
  const overlay = positionLevelsIndicator.create()
  const inputs = { levels: JSON.stringify(positionOverlay(position)) }
  overlay.start(context(), inputs)
  assert.equal(output[0].priceLines?.find((l) => l.title === 'stop now +0.20R')?.price, 98)
  for (let i = 0; i < 100; i++) {
    overlay.onBars()
    overlay.onViewport({ from: i, to: i + 100 })
    overlay.setInputs(inputs)
  }
  assert.equal(output.length, 1)
  overlay.setInputs({ levels: JSON.stringify(positionOverlay({ ...position, sl: 97 })) })
  assert.equal(output.length, 2)
  assert.equal(output[1].priceLines?.find((l) => l.title === 'stop now +0.30R')?.price, 97)
  overlay.stop()
  overlay.start(context('delta:SOLUSD'), inputs)
  assert.deepEqual(output.at(-1)?.priceLines, [])
  overlay.stop()
  overlay.start(context('delta:ETHUSD', false), inputs)
  assert.deepEqual(output.at(-1)?.priceLines, [], 'replay with no cursor hides the live stop')
  overlay.stop()
  const replayed = { ...position, entryAt: 1_000 }
  overlay.start(
    { ...context('delta:ETHUSD', false), bars: () => [{ time: 1_000 }] } as NativeIndicatorContext,
    { levels: JSON.stringify(positionOverlay(replayed)) },
  )
  assert.equal(
    output.at(-1)?.priceLines?.some((l) => l.title === 'entry'),
    false,
    'replay after the fill must not reveal the latest stop, targets or peak',
  )
  overlay.stop()
  overlay.start(
    { ...context('delta:ETHUSD', false), bars: () => [{ time: 500 }] } as NativeIndicatorContext,
    { levels: JSON.stringify(positionOverlay(replayed)) },
  )
  assert.deepEqual(output.at(-1)?.priceLines, [], 'replay before the fill hides the position')
  overlay.stop()
  overlay.resume()
  assert.equal(output.length, 6)
})
