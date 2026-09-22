import { test } from 'node:test';
import assert from 'node:assert/strict';

test('request.security resolves the requested market instead of serving the primary one', async () => {
  const { DeltaPineProvider, deltaSymbolFor } = await import('./provider.ts');
  const btc = [{ time: 900_000, open: 60000, high: 61000, low: 59000, close: 60500, volume: 1 }];
  const eth = [{ time: 900_000, open: 3000, high: 3100, low: 2900, close: 3050, volume: 1 }];
  const asked: string[] = [];
  const p = new DeltaPineProvider({ symbol: 'BTCUSD', tf: '15m', tickSize: 0.5, bars: btc, fetchOther: async (s) => { asked.push(s); return s === 'ETHUSD' ? eth : []; } });
  assert.equal(deltaSymbolFor('BINANCE:ETHUSDT', 'BTCUSD'), 'ETHUSD');
  assert.equal(deltaSymbolFor('ETHUSDT.P', 'BTCUSD'), 'ETHUSD');
  for (const own of ['BTCUSD', 'DELTA:BTCUSD', 'BINANCE:BTCUSDT', '']) assert.equal((await p.getMarketData(own, '15'))[0].close, 60500, own);
  assert.equal((await p.getMarketData('DELTA:ETHUSD', '15'))[0].close, 3050);
  assert.deepEqual(asked, ['ETHUSD']);
  await assert.rejects(() => p.getMarketData('TVC:DXY', '15'), /not a Delta market/);
});
