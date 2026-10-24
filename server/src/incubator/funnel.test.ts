import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { funnelClass } from './store.ts';
import { ShadowRunner } from './shadow.ts';

test('decision 190: a resting order is pending, not opened, in the account\'s funnel', () => {
  assert.equal(funnelClass('pending'), 'pending');
  assert.equal(funnelClass('pending:resting limit at 99.4'), 'pending');
  assert.equal(funnelClass('opened'), 'opened');
});

test('decision 190: a shadow limit counts as opened only when it fills; a lapsed one counts as other', () => {
  const paper = new EventEmitter();
  let saved: any = {};
  const store = { shadowFunnel: () => ({}), setShadowFunnel: (r: any) => { saved = r; }, liveMarks: () => undefined, setLiveMarks: () => {} };
  const runner = new ShadowRunner({ store, paper } as any) as any;
  const key = 's|XUSD|1h';
  runner.note(key, 'pending', 1000); runner.pendingFunnel.set(7, { key, at: 1000 });
  runner.note(key, 'pending', 2000); runner.pendingFunnel.set(8, { key, at: 2000 });
  let f = runner.funnelOf(key, 0);
  assert.deepEqual([f.entries, f.opened, f.pending], [2, 0, 2]);
  paper.emit('order', { positionId: 7, reason: 'entry' });
  paper.emit('pending', { type: 'cancelled', id: 8, reason: 'no fill' });
  f = runner.funnelOf(key, 0);
  assert.deepEqual([f.entries, f.opened, f.pending, f.other, f.lastOpenAt], [2, 1, 0, 1, 1000]);
  runner.saveFunnel();
  assert.deepEqual(saved[key], [[1000, 'opened'], [2000, 'other']]);
});
