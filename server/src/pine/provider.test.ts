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

test('Heikin-Ashi requests are served from the same candles; other chart types are refused', async () => {
  const { DeltaPineProvider, parseTicker, toHeikinAshi } = await import('./provider.ts');
  assert.deepEqual(parseTicker('BTCUSD;HEIKINASHI', 'BTCUSD'), { symbol: 'BTCUSD', modifier: 'HEIKINASHI' });
  assert.deepEqual(parseTicker('DELTA:ETHUSD', 'BTCUSD'), { symbol: 'ETHUSD', modifier: null });
  const bars = [{ time: 0, open: 10, high: 14, low: 8, close: 12, volume: 1 }, { time: 900_000, open: 12, high: 16, low: 11, close: 15, volume: 1 }];
  const ha = toHeikinAshi(bars.map(b => ({ ...b, openTime: b.time, closeTime: b.time, quoteAssetVolume: 0, numberOfTrades: 0, takerBuyBaseAssetVolume: 0, takerBuyQuoteAssetVolume: 0, ignore: 0 })));
  assert.equal(ha[0].close, 11);          // (10+14+8+12)/4
  assert.equal(ha[0].open, 11);           // first bar: (open+close)/2
  assert.equal(ha[1].close, 13.5);        // (12+16+11+15)/4
  assert.equal(ha[1].open, 11);           // (prev haOpen + prev haClose)/2
  assert.equal(ha[1].high, 16);
  const p = new DeltaPineProvider({ symbol: 'BTCUSD', tf: '15m', tickSize: 0.5, bars });
  assert.equal((await p.getMarketData('BTCUSD;HEIKINASHI', '15'))[0].close, 11, 'served without a fetcher: it is the same market');
  await assert.rejects(() => p.getMarketData('BTCUSD;RENKO', '15'), /RENKO charts are not supported/);
});
