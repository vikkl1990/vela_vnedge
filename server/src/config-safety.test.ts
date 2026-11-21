import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-safety-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'config.json');
}

test('only absent first-run config uses defaults; corrupt or invalid saved config fails safely', t => {
  const file = fixture(t);
  assert.equal(new ConfigStore(file).get().execution.mode, 'paper');
  for (const bad of ['', '{"botToken":"secret-canary"', 'null', '[]', '42', '{"paper":null}', '{"paper":{"riskPerTradePct":-5}}']) {
    fs.writeFileSync(file, bad);
    assert.throws(() => new ConfigStore(file), e => e instanceof Error && /configuration/.test(e.message) && !e.message.includes('secret-canary'));
  }
  fs.rmSync(file); fs.mkdirSync(file);
  assert.throws(() => new ConfigStore(file), /configuration/);
  fs.rmdirSync(file); fs.symlinkSync(path.join(path.dirname(file), 'absent.json'), file);
  assert.throws(() => new ConfigStore(file), /configuration/);
});

test('real entry point exits on corrupt config without opening a database or printing its contents', t => {
  const file = fixture(t); const corrupt = '{"telegram":{"botToken":"private-startup-canary"';
  fs.writeFileSync(file, corrupt);
  const child = spawnSync(process.execPath, ['--no-warnings', fileURLToPath(new URL('./index.ts', import.meta.url))], {
    env: { ...process.env, VNEDGE_DATA_DIR: path.dirname(file), LOG_LEVEL: 'warn' },
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stdout + child.stderr, /Fatal runtime failure \(startup\)/);
  assert.ok(!(child.stdout + child.stderr).includes('private-startup-canary'));
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
  assert.equal(fs.existsSync(path.join(path.dirname(file), 'vnedge.db')), false);
});

test('missing config on a cold restart cannot use defaults over an existing journal', t => {
  const file = fixture(t);
  for (const name of ['vnedge.db', 'vnedge.db-wal', 'vnedge.db-shm']) {
    const journal = path.join(path.dirname(file), name);
    fs.writeFileSync(journal, 'existing-account-canary');
    assert.throws(() => new ConfigStore(file), /missing for an existing account/);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(journal, 'utf8'), 'existing-account-canary');
    fs.unlinkSync(journal);
  }
  assert.equal(new ConfigStore(file).get().execution.mode, 'paper', 'truly new installation still has defaults');
});

test('real entry point refuses missing config before it touches existing journal state', t => {
  const file = fixture(t); const journal = path.join(path.dirname(file), 'vnedge.db');
  const before = Buffer.from('existing-journal-canary'); fs.writeFileSync(journal, before);
  const child = spawnSync(process.execPath, ['--no-warnings', fileURLToPath(new URL('./index.ts', import.meta.url))], {
    env: { ...process.env, VNEDGE_DATA_DIR: path.dirname(file), LOG_LEVEL: 'warn' }, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(child.status, 1); assert.match(child.stdout + child.stderr, /Fatal runtime failure \(startup\)/);
  assert.ok(!(child.stdout + child.stderr).includes('existing-journal-canary'));
  assert.deepEqual(fs.readFileSync(journal), before); assert.equal(fs.existsSync(file), false);
});

test('bad reload and deletion retain last good config and never overwrite damaged state', t => {
  const file = fixture(t); fs.writeFileSync(file, '{}');
  const store = new ConfigStore(file); const before = structuredClone(store.get());
  fs.writeFileSync(file, '{"secret":"canary"');
  assert.equal(store.status().valid, false);
  assert.throws(() => store.update({ historyBars: 250 }), /refusing writes/);
  assert.throws(() => store.setScanner('test', { enabled: false }), /refusing writes/);
  assert.deepEqual(store.get(), before);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"secret":"canary"');
  fs.rmSync(file);
  assert.throws(() => store.update({ historyBars: 250 }), /refusing writes/);
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, JSON.stringify({ historyBars: 300 }));
  assert.equal(store.status().valid, true);
  assert.deepEqual(store.get(), before, 'health does not adopt disk edits');
  store.update({}); assert.equal(store.get().historyBars, 300);
});

test('failed atomic save leaves memory and disk unchanged, for update and scanner writes', t => {
  const file = fixture(t); fs.writeFileSync(file, '{}');
  const store = new ConfigStore(file); const before = structuredClone(store.get());
  const rename = fs.renameSync;
  fs.renameSync = (() => { throw new Error('injected filesystem failure'); }) as typeof fs.renameSync;
  try {
    assert.throws(() => store.update({ historyBars: 300 }), /filesystem failure/);
    assert.throws(() => store.setScanner('test', { enabled: false }), /filesystem failure/);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(store.get(), before);
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.json']);
});
