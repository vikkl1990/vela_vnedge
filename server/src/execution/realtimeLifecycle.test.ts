import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deferLoop } from './wiring.ts';
import { App } from '../app.ts';

test('execution startup hydrates both journals before arming any live loop', () => {
  const calls: string[] = [];
  const app = {
    executionLoopsStarted: false,
    paper: {closedPositions: () => calls.push('paper')},
    shadow: {closedPositions: () => calls.push('shadow')},
    executionLoops: [() => calls.push('execution')],
    tradeMonitor: {start: () => calls.push('monitor')},
  };
  App.prototype.startExecutionLoops.call(app as unknown as App);
  App.prototype.startExecutionLoops.call(app as unknown as App);
  assert.deepEqual(calls, ['paper', 'shadow', 'execution', 'monitor']);
});

test('journal load failure leaves execution unarmed and propagates startup failure', () => {
  let armed = 0;
  const app = {
    executionLoopsStarted: false,
    paper: {closedPositions: () => []},
    shadow: {closedPositions: () => {throw new Error('journal unavailable');}},
    executionLoops: [() => {armed++;}],
    tradeMonitor: {start: () => {armed++;}},
  };
  assert.throws(() => App.prototype.startExecutionLoops.call(app as unknown as App), /journal unavailable/);
  assert.equal(app.executionLoopsStarted, false);
  assert.equal(armed, 0);
});

test('execution loops do not schedule until start arms them, and a second start does not double them', () => {
  const scheduled: number[] = [];
  const real = global.setInterval;
  global.setInterval = ((fn: TimerHandler, ms?: number) => {
    scheduled.push(Number(ms));
    return real(fn, ms);
  }) as typeof setInterval;
  try {
    const app: { executionLoops?: Array<() => ReturnType<typeof setInterval>> } = {};
    const stop = deferLoop(app, () => {}, 100);
    assert.equal(scheduled.length, 0, 'construction must not start the timer');
    for (const start of app.executionLoops ?? []) start();
    for (const start of app.executionLoops ?? []) start();
    assert.deepEqual(scheduled, [100]);
    stop();
  } finally {
    global.setInterval = real;
  }
});
