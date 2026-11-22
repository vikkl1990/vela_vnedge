import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deferLoop } from './wiring.ts';

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
