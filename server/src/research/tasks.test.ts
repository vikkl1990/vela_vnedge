import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { MlService } from '../ml/service.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { runResearchTask } from './tasks.ts';
import { runBacktest, type BacktestResult } from '../paper/backtest.ts';

test('worker ML fitting preserves the same samples, model scores and chronological evidence as direct fitting', async (t) => {
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  const ml = new MlService(db, () => ({ s: 'S' }));
  t.after(() => ml.stop());
  for (let i = 0; i < 300; i++)
    ml.addLiveSample(
      's',
      'BTCUSD',
      '15m',
      i * 1000,
      {} as any,
      i % 3 !== 0,
      i % 3 ? 1 : -1,
      i % 3 ? 10 : -10,
      'manual',
      i * 1000 + 1,
    );
  const direct = ml.train(),
    score = ml.score('s', {} as any, { record: false, tf: '15m' });
  const isolated = await ml.trainAsync();
  assert.equal(isolated.samples, direct.samples);
  assert.deepEqual(isolated.global, direct.global);
  assert.deepEqual(ml.score('s', {} as any, { record: false, tf: '15m' }), score);
});

test('large replay stays equivalent while the main thread can service execution ticks', async () => {
  const bars = Array.from({ length: 30000 }, (_, i) => ({
    time: 1700000000000 + i * 900000,
    open: 100,
    high: 102,
    low: 98,
    close: 100,
    volume: 100,
  }));
  const cfg = { ...DEFAULT_CONFIG.paper, minRiskFeeRatio: 0, feeRatePct: 0 };
  const input = {
    scannerId: 's',
    scannerName: 'S',
    symbol: 'BTCUSD',
    tf: '15m',
    bars,
    events: [],
    cfg,
    exitMode: 'both' as const,
    contractValue: 1,
    tickSize: 0.01,
  };
  let ticks = 0;
  const timer = setInterval(() => ticks++, 2);
  const isolated = await runResearchTask<BacktestResult>('backtest', input);
  clearInterval(timer);
  const direct = runBacktest(input);
  assert.deepEqual(isolated.stats, direct.stats);
  assert.deepEqual(isolated.trades, direct.trades);
  assert.ok(ticks >= 3, `execution timer serviced ${ticks} times during replay`);
});
