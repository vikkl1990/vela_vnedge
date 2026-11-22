import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inboxFixture } from './inboxFixture.ts';

test('startup outside paper mode finishes a pending receipt and does not open it', async () => {
  const x = inboxFixture();
  const bar = { time: x.entry.barTime, open: 100, high: 101, low: 99, close: 100, volume: 1 };
  const delivery = {
    version: 1 as const, scannerId: 's', scannerName: 'S', symbol: 'BTCUSD', tf: '15m', ev: x.entry,
    bars: [bar], market: { contractValue: 0.01, tickSize: 0.01 }, exitMode: 'both' as const, lastBar: bar,
    copied: false, pilotRequested: false, fingerprint: 'test', accountResetAt: null, targetPositionId: null, targetPendingIds: [],
  };
  const row = x.engine.inbox.accept(delivery, {
    at: Date.now(), barTime: x.entry.barTime, scannerId: 's', scannerName: 'S', symbol: 'BTCUSD', tf: '15m',
    kind: 'entry', side: 'long', price: 100, sl: 98, tp: [102, 104, 106], score: null, label: 'Long', message: '',
    summary: '', source: 'alert', levelsSource: 'script', action: 'received:awaiting decision', positionId: null,
  });
  assert.equal(row?.state, 'pending');
  x.cfg.execution.mode = 'dry-run';
  await x.engine.recoverSignals();
  assert.equal(x.engine.inbox.status().pending, 0);
  assert.match(x.db.get<any>('SELECT action FROM signals')!.action, /recovery requires reconciliation/);
  assert.equal(x.paper.openPositions().length, 0);
  x.db.db.close();
});
