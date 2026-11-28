import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from './db.ts';

test('the background checkpoint replaces the automatic one and drains the WAL (decision 342)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnedge-ckpt-'));
  const file = path.join(dir, 'x.db');
  const db = new Db(file);
  t.after(() => { db.stopBackgroundCheckpoint(); db.db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the sidecars briefly */ } });
  db.startBackgroundCheckpoint(100);
  assert.equal((db.db.prepare('PRAGMA wal_autocheckpoint').get() as any).wal_autocheckpoint, 0, 'commits no longer checkpoint');
  db.run('CREATE TABLE t(x TEXT)');
  const blob = 'x'.repeat(4000);
  db.transaction(() => { for (let i = 0; i < 3000; i++) db.run('INSERT INTO t VALUES (?)', blob); });   // ~12 MB, past the 1,000-page default
  const wal = () => { try { return fs.statSync(`${file}-wal`).size; } catch { return 0; } };
  assert.ok(wal() > 4_000_000, `the WAL holds the writes (${wal()} bytes)`);
  // without a checkpoint the pages stay in the WAL and the database file stays small; the thread copies them in
  const main = () => fs.statSync(file).size;
  assert.ok(main() < 1_000_000, `nothing checkpointed by the commit itself (${main()} bytes)`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && main() < 10_000_000) await new Promise(r => setTimeout(r, 100));
  assert.ok(main() >= 10_000_000, `the background thread checkpointed the writes into the database (${main()} bytes)`);
  db.stopBackgroundCheckpoint();
  assert.equal((db.db.prepare('PRAGMA wal_autocheckpoint').get() as any).wal_autocheckpoint, 1000, 'stopping restores the automatic checkpoint');
});
