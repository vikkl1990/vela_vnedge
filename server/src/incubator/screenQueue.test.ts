import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { Db } from '../db.ts';
import { ScreenQueue } from './screenQueue.ts';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); killed = false; env: NodeJS.ProcessEnv;
  constructor(env: NodeJS.ProcessEnv) { super(); this.env = env; }
  kill() { this.killed = true; this.emit('exit', null, 'SIGTERM'); return true; }
  say(line: string) { this.stdout.emit('data', Buffer.from(line + '\n')); }
}

function setup(t: { after: (fn: () => void) => void }, nightly = { running: false }) {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnedge-screen-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const children: FakeChild[] = []; const notes: string[] = []; let clock = 1_000_000;
  const q = new ScreenQueue({ db, diagDir: dir, serverDir: dir, nightlyRunning: () => nightly.running, notify: t => notes.push(t), now: () => clock, spawnJob: ({ env }) => { const c = new FakeChild(env); children.push(c); return c as unknown as ChildProcess; } });
  return { db, dir, q, children, notes, tick: (ms: number) => { clock += ms; } };
}

test('decision 174: a screen is queued, started with the ids file and timeframe, reports progress and a summary, and the next waits its turn', t => {
  const { q, children, notes, dir, tick } = setup(t);
  const a = q.enqueue({ label: 'Kalman Step Signals', ids: ['kalman-step-signals'], tf: '1h', actor: 'vikram' });
  const b = q.enqueue({ label: 'everything by LuxAlgo', ids: ['b', 'a'], tf: '15m', markets: ['BTCUSD'], actor: 'vikram' });
  assert.equal(q.enqueue({ label: 'again', ids: ['a', 'b'], tf: '15m', markets: ['BTCUSD'], actor: 'vikram' }).id, b.id, 'the same list on the same timeframe is not queued twice');
  assert.equal(a.status, 'running'); assert.equal(b.status, 'queued');
  assert.equal(children.length, 1);
  assert.equal(children[0].env.TF, '1h'); assert.equal(fs.readFileSync(children[0].env.IDS!, 'utf8'), 'kalman-step-signals\n');
  children[0].say('[incubate 2026-10-22T02:00:00]   25/392 scripts · 1422 runs · 21 passed');
  assert.deepEqual(q.list().running?.progress, { done: 25, scripts: 392, runs: 1422, passed: 21 });
  tick(5 * 60_000);
  children[0].say('[incubate 2026-10-22T02:05:00] screen: 3000 runs, 40 passed (12 new candidates), 0 skipped as silent, 2 failed');
  children[0].emit('exit', 0, null);
  const v = q.list();
  assert.equal(v.history[0].status, 'done'); assert.match(v.history[0].summary ?? '', /12 new candidates/);
  assert.match(notes[0], /Screen done: Kalman Step Signals \(1 scripts, 1h\) in 5 min/);
  assert.equal(v.running?.id, b.id, 'the next job starts'); assert.equal(children[1].env.MARKETS, 'BTCUSD');
  assert.ok(fs.existsSync(path.join(dir, `screen-${a.id}.log`)));
});

test('decision 174: nothing starts while the nightly runs; a cancelled job is killed; a restart marks what it interrupted', t => {
  const nightly = { running: true };
  const { q, children, db } = setup(t, nightly);
  const a = q.enqueue({ label: 'x', ids: ['x'], tf: '4h', actor: 'vikram' });
  assert.equal(a.status, 'queued'); assert.equal(children.length, 0);
  nightly.running = false;
  (q as any).pump();
  assert.equal(a.status, 'running');
  q.cancel(a.id, 'vikram');
  assert.ok(children[0].killed); assert.equal(q.list().history[0].status, 'cancelled');
  const b = q.enqueue({ label: 'y', ids: ['y'], tf: '4h', actor: 'vikram' });
  assert.equal(b.status, 'running');
  // the process dies with b running: a new queue over the same store reports it
  const q2 = new ScreenQueue({ db, diagDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vnedge-screen-')), serverDir: '.', nightlyRunning: () => false, spawnJob: () => new FakeChild({}) as unknown as ChildProcess });
  assert.equal(q2.list().running, null);
  assert.equal(q2.list().history[0].status, 'failed'); assert.match(q2.list().history[0].error ?? '', /interrupted by a restart/);
});
