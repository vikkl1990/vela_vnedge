import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregatePositions, biasOf, coinOf, deltaFlow, parseBoard, selectCohort, sessionAt } from './sources.ts';

test('the cohort is profitable this month and this week, funded and active, ranked by the month', () => {
  const row = (address: string, month: number, week: number, acct = 1e6, vol = 1e7, roi = 0.1) => ({ ethAddress: address, accountValue: acct, windowPerformances: [['day', { pnl: '1', roi: '0', vlm: '1' }], ['week', { pnl: String(week), roi: '0', vlm: '1' }], ['month', { pnl: String(month), roi: String(roi), vlm: String(vol) }]] });
  const rows = parseBoard({ leaderboardRows: [row('a', 100, 10), row('b', 500, 50), row('c', 900, -5), row('d', 50, 5, 1e3), row('e', 50, 5, 1e6, 1e3), row('f', 50, 5, 1e6, 1e7, -0.1)] });
  const c = selectCohort(rows, { size: 300, minAccountUsd: 1e5, minMonthVolumeUsd: 5e6 });
  assert.deepEqual(c.map(r => r.address), ['b', 'a'], 'c lost this week, d is unfunded, e inactive, f negative roi');
  assert.equal(selectCohort(rows, { size: 1, minAccountUsd: 1e5, minMonthVolumeUsd: 5e6 }).length, 1);
});

test('positions aggregate to a net book per coin', () => {
  const m = aggregatePositions([[{ coin: 'BTC', sizeUsd: 100, side: 'long', leverage: 5 }, { coin: 'ETH', sizeUsd: 40, side: 'short', leverage: null }], [{ coin: 'BTC', sizeUsd: 30, side: 'short', leverage: 2 }]]);
  assert.deepEqual(m.get('BTC'), { longUsd: 100, shortUsd: 30, netUsd: 70, longs: 1, shorts: 1, wallets: 2 });
  assert.equal(m.get('ETH')!.netUsd, -40);
});

test('delta flow reads the ticker and leaves missing fields null; coins strip the quote', () => {
  const f = deltaFlow({ symbol: 'BTCUSD', product_id: 1, close: 1, mark_price: '1', oi_value_usd: '74675079.8', oi_change_usd_6h: '-71899.5', funding_rate: '0.0064' } as any);
  assert.equal(f.oiUsd, 74675079.8); assert.equal(f.oiChange6hUsd, -71899.5); assert.equal(f.fundingPct, 0.0064); assert.equal(f.change24hPct, null);
  assert.equal(deltaFlow(undefined).oiUsd, null);
  assert.equal(coinOf('GRIFFAINUSD'), 'GRIFFAIN'); assert.equal(coinOf('BTCUSDT'), 'BTC');
});

test('bias follows price against a rising or falling EMA, else neutral; sessions by UTC hour', () => {
  const up = Array.from({ length: 80 }, (_, i) => ({ close: 100 + i }));
  const down = Array.from({ length: 80 }, (_, i) => ({ close: 200 - i }));
  const flat = Array.from({ length: 80 }, () => ({ close: 100 }));
  assert.equal(biasOf(up), 1); assert.equal(biasOf(down), -1); assert.equal(biasOf(flat), 0); assert.equal(biasOf(up.slice(0, 10)), 0);
  assert.equal(sessionAt(Date.UTC(2026, 9, 16, 3)), 'asia'); assert.equal(sessionAt(Date.UTC(2026, 9, 16, 9)), 'london'); assert.equal(sessionAt(Date.UTC(2026, 9, 16, 15)), 'new-york'); assert.equal(sessionAt(Date.UTC(2026, 9, 16, 22)), 'off');
});
