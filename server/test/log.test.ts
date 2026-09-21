/** Log file sink: size-based rotation, generation count, JSON format, console + ring untouched. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../src/log.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnedge-log-'));
const silence = () => { const orig = { log: console.log, warn: console.warn, error: console.error }; console.log = console.warn = console.error = () => {}; return () => Object.assign(console, orig); };

test('rotates by size and keeps at most maxFiles generations', t => {
  const restore = silence(); t.after(restore); t.after(() => logger.disableFile());
  logger.enableFile({ dir, maxBytes: 2048, maxFiles: 3, level: 'debug' });
  const log = logger.scoped('t');
  for (let i = 0; i < 400; i++) log.info(`line ${i} ${'x'.repeat(40)}`);
  const files = fs.readdirSync(dir).filter(f => f.startsWith('vnedge.log')).sort();
  assert.deepEqual(files, ['vnedge.log', 'vnedge.log.1', 'vnedge.log.2', 'vnedge.log.3']);
  for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 2048 + 200, `${f} respects the size cap`);
  const st = logger.fileStats();
  assert.equal(st.enabled, true); assert.ok(st.rotations >= 4, `rotations ${st.rotations}`); assert.equal(st.writeErrors, 0);
  // the newest generation holds the most recent lines
  assert.match(fs.readFileSync(path.join(dir, 'vnedge.log'), 'utf8'), /line 399/);
  assert.equal(logger.rotate(), true);
  assert.equal(fs.readdirSync(dir).filter(f => f.startsWith('vnedge.log')).length, 4, 'a forced rotation still caps generations');
  // the ring buffer and level counters keep working alongside the file
  assert.ok(logger.tail(5).length === 5);
  assert.ok(logger.counts.info >= 400);
});

test('LOG_FORMAT=json writes one JSON object per line and text format is unchanged', t => {
  const restore = silence(); t.after(restore); t.after(() => { logger.disableFile(); logger.format = 'text'; });
  const jdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnedge-logj-'));
  logger.format = 'json';
  logger.enableFile({ dir: jdir, maxBytes: 1 << 20, maxFiles: 2, level: 'debug' });
  logger.scoped('json').warn('hello', { a: 1 });
  logger.flush();
  const lines = fs.readFileSync(path.join(jdir, 'vnedge.log'), 'utf8').trim().split('\n');
  const o = JSON.parse(lines.at(-1)!);
  assert.equal(o.level, 'warn'); assert.equal(o.scope, 'json'); assert.equal(o.msg, 'hello'); assert.deepEqual(o.data, { a: 1 }); assert.match(o.time, /^\d{4}-\d{2}-\d{2}T/);
  logger.format = 'text';
  logger.scoped('text').warn('plain');
  const last = fs.readFileSync(path.join(jdir, 'vnedge.log'), 'utf8').trim().split('\n').at(-1)!;
  assert.match(last, /^\d{2}:\d{2}:\d{2}\.\d{3} WARN  \[text\] plain$/);
  fs.rmSync(jdir, { recursive: true, force: true });
});

test('an unwritable directory never throws; errors are counted', t => {
  const restore = silence(); t.after(restore); t.after(() => logger.disableFile());
  logger.enableFile({ dir: path.join(dir, 'vnedge.log'), maxBytes: 4096, maxFiles: 1 }); // a file, not a directory
  logger.scoped('t').error('boom');
  assert.ok(logger.fileStats().writeErrors >= 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
