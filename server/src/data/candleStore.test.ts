import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CandleStore } from './candleStore.ts';

function store() {
  const feed: any = new EventEmitter(); feed.subscribe = () => {};
  const rest: any = { candles: async () => [] };
  const cs = new CandleStore(rest, feed, 100);
  return { cs, feed };
}

test('decision 74: a bar is announced closed by the clock, once, even when no later trade arrives', () => {
  const { cs } = store();
  const H = 3_600_000, open = Date.UTC(2026, 9, 3, 15);
  (cs as any).series.set('PIEVERSEUSD:1h', { symbol: 'PIEVERSEUSD', tf: '1h', bars: [{ time: open - H, open: 1, high: 1, low: 1, close: 1, volume: 1 }, { time: open, open: 1, high: 1, low: 1, close: 1, volume: 1 }], loaded: true, loading: null, maxBars: 100, lastClosedEmitted: open - H, lastClosedAt: 0, loadedAt: 0, unfillable: new Set(), dormant: false, backfilling: null });
  const closed: any[] = [];
  cs.on('closed', e => closed.push(e));
  assert.equal(cs.announceDueCloses(open + H + 1000), 0, 'inside the grace: not yet');
  assert.equal(cs.announceDueCloses(open + H + 3000), 1, 'after the grace: announced');
  assert.equal(closed.length, 1); assert.equal(closed[0].bar.time, open); assert.equal(closed[0].historical, false);
  assert.equal(cs.announceDueCloses(open + H + 60_000), 0, 'never twice');
  // the websocket path arriving later finds the bar already announced
  (cs as any).merge((cs as any).series.get('PIEVERSEUSD:1h'), { time: open + H, open: 1, high: 1, low: 1, close: 1, volume: 1 }, 'ws');
  assert.equal(closed.length, 1);
});
