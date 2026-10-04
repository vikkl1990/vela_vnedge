import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { ScriptHealth, permanentReason } from './health.ts';

test('only failures that will repeat are permanent', () => {
  assert.ok(permanentReason('request.security(VIX): VIX is not a Delta market; external series are not supported'));
  assert.ok(permanentReason('Failed to transpile Pine Script version 6: Unexpected token'));
  assert.ok(permanentReason('hung: no result within 150s'));
  assert.equal(permanentReason('worker out of memory'), null);
  assert.equal(permanentReason('ETIMEDOUT fetching candles'), null);
  assert.equal(permanentReason(null), null);
});

test('two markets of the same permanent failure quarantine the script; a good run clears it', () => {
  const h = new ScriptHealth(new Db(':memory:'));
  const err = 'request.security(SPY): SPY is not a Delta market; external series are not supported';
  assert.equal(h.record('needs-spy', err), false, 'one market could be bad data');
  assert.equal(h.isQuarantined('needs-spy'), false);
  assert.equal(h.record('needs-spy', err), true);
  assert.equal(h.isQuarantined('needs-spy'), true);
  assert.equal(h.record('needs-spy', err), false, 'already quarantined');

  h.clear('needs-spy');
  assert.equal(h.isQuarantined('needs-spy'), false);
});

test('transient failures never quarantine, and release re-opens by reason', () => {
  const h = new ScriptHealth(new Db(':memory:'));
  for (let i = 0; i < 5; i++) h.record('flaky', 'worker crashed: out of memory');
  assert.equal(h.isQuarantined('flaky'), false);
  assert.equal(h.list().length, 0);

  for (let i = 0; i < 2; i++) h.record('gappy', 'ta.size is not a function');
  for (let i = 0; i < 2; i++) h.record('external', 'NDX is not a Delta market');
  assert.equal(h.quarantined().size, 2);
  assert.equal(h.release('runtime gap'), 1);
  assert.deepEqual([...h.quarantined()], ['external']);
});

test('decision 78: three timeouts in a day quarantine a script; a success in between does not reset the count', () => {
  const db = new Db(':memory:');
  const h = new ScriptHealth(db);
  const t0 = Date.UTC(2026, 9, 4);
  assert.equal(h.record('slow', 'timeout after 90000ms', t0), false);
  h.clear('slow');                                                        // a run that worked in between
  assert.equal(h.record('slow', 'timeout after 90000ms', t0 + 3_600_000), false);
  assert.equal(h.isQuarantined('slow'), false);
  assert.equal(h.record('slow', 'timeout after 90000ms', t0 + 7_200_000), true, 'the third strike quarantines');
  assert.equal(h.isQuarantined('slow'), true);
  assert.match(h.row('slow')?.reason ?? '', /timed out 3×/);
  // strikes older than a day fall out of the window
  const h2 = new ScriptHealth(new Db(':memory:'));
  h2.record('x', 'timeout after 90000ms', t0); h2.record('x', 'timeout after 90000ms', t0 + 1000);
  assert.equal(h2.record('x', 'timeout after 90000ms', t0 + 2 * 86_400_000), false);
});
