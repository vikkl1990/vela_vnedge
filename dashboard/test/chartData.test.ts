import assert from 'node:assert/strict'
import {test} from 'node:test'
import {replayOpenAt, venueSymbol} from '../src/chart/venues.ts'

test('each venue uses its own instrument; unsupported mappings are explicit', () => {
  assert.equal(venueSymbol('BTCUSD','delta'), 'delta:BTCUSD')
  assert.equal(venueSymbol('BTCUSD','binance'), 'binance:BTCUSDT.P')
  assert.equal(venueSymbol('ETHUSD','hyperliquid'), 'hyperliquid:ETH')
  assert.equal(venueSymbol('SOLUSD','coinbase'), 'coinbase:SOL-USD')
  assert.throws(() => venueSymbol('1000PEPEUSD','coinbase'))
})
test('synchronized replay never reveals a still-open higher timeframe bar', () => {
  const clock = Date.parse('2026-11-02T10:15:00Z')
  assert.equal(replayOpenAt(clock, 15*60000), Date.parse('2026-11-02T10:00:00Z'))
  assert.equal(replayOpenAt(clock, 3600000), Date.parse('2026-11-02T09:00:00Z'))
  assert.equal(replayOpenAt(clock, 4*3600000), Date.parse('2026-11-02T04:00:00Z'))
})
