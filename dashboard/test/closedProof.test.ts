import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ExecutionRequest, ScriptingEngine } from '@luxalgo/vela/plugin'
import { withScriptTimezones } from '../src/chart/scriptTimezone.ts'
import { signalSymbolInfo } from '../../shared/signalMetadata.ts'
const T = 1800000000000
function setup(fail = false) {
  const seen: ExecutionRequest[] = []
  let stopped = 0
  const engine: ScriptingEngine = {
    language: 'pine',
    capabilities: { streaming: true, inputs: true, visibleRange: false },
    async prepare() {
      return {
        language: 'pine',
        inputs: [],
        meta: { title: 'Fixture', overlay: false },
        reactsToViewport: false,
        token: null,
      }
    },
    execute(request, handlers) {
      seen.push(request)
      if (request.mode === 'static')
        queueMicrotask(() => (fail ? handlers.onError?.(new Error('fixture failure')) : handlers.onDone?.()))
      return {
        stop() {
          stopped++
        },
        update() {},
        setVisibleRange() {},
        notifyBars() {},
        async getContext() {
          return {
            language: 'pine',
            phase: 'idle',
            barIndex: 0,
            meta: { title: 'Fixture', overlay: false },
            plots: { Value: [{ time: T, value: 7 }] },
            variables: {},
            warnings: [],
          }
        },
      }
    },
  }
  return { adapter: withScriptTimezones(engine, () => 'America/New_York'), seen, stopped: () => stopped }
}
test('closed proof uses an immutable closed window, current inputs and per-script metadata; repeated reads share one session', async () => {
  const { adapter, seen } = setup(),
    prepared = await adapter.engine.prepare('indicator("Fixture")', 's')
  const bars = [
    { time: T, open: 1, high: 2, low: 1, close: 2, volume: 1 },
    { time: T + 900000, open: 2, high: 3, low: 1, close: 3, volume: 2 },
  ]
  const session = adapter.engine.execute(
    {
      prepared,
      market: { symbol: 'ETHUSD', timeframe: '15', symbolInfo: signalSymbolInfo('ETHUSD', 0.01) },
      bars,
      mode: 'live',
    },
    { onModel() {} },
  )
  const promise = adapter.closedProof('s', T, { Length: 20 })
  assert.equal(promise, adapter.closedProof('s', T, { Length: 20 }))
  bars[0].close = 99
  const proof = await promise
  assert.equal(proof?.history.count, 1)
  assert.ok(!proof?.history.text.includes('99'))
  assert.equal(seen.length, 2)
  assert.equal(seen[1].mode, 'static')
  assert.equal(seen[1].bars.length, 1)
  assert.equal(seen[1].market.symbolInfo?.timezone, 'America/New_York')
  assert.deepEqual(seen[1].inputs, { Length: 20 })
  session.stop()
  assert.equal(await adapter.closedProof('s', T, {}), null)
})
test('verification failure and removed script resolve unavailable rather than agreement', async () => {
  const { adapter, stopped } = setup(true),
    prepared = await adapter.engine.prepare('indicator("Fixture")', 's')
  const session = adapter.engine.execute(
    {
      prepared,
      market: { symbol: 'ETHUSD', timeframe: '15', symbolInfo: signalSymbolInfo('ETHUSD', 0.01) },
      bars: [{ time: T, open: 1, high: 2, low: 1, close: 2, volume: 1 }],
      mode: 'live',
    },
    { onModel() {} },
  )
  assert.equal(await adapter.closedProof('s', T, {}), null)
  const queued = adapter.closedProof('s', T, { Length: 2 })
  session.stop()
  assert.equal(await queued, null)
  assert.ok(stopped() > 0)
})
