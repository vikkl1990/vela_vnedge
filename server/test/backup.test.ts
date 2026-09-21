/** SQLite snapshots (`VACUUM INTO`), retention pruning, integrity check and the backup scheduler. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Db } from '../src/db.ts';
import { BackupService } from '../src/ops/backup.ts';
import { logger } from '../src/log.ts';

logger.minLevel = 'error';

test('backup writes a consistent snapshot and prunes old ones', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnedge-bk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new Db(path.join(dir, 'vnedge.db'));
  t.after(() => db.db.close());
  db.kvSet('hello', { world: 1 });
  assert.equal(db.integrityCheck(), 'ok');
  assert.ok(db.sizeBytes() > 0);
  // an old snapshot that should be pruned and a recent one that should survive
  const old = path.join(dir, 'backups', 'vnedge-20200101-000000.db'); fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, ''); fs.utimesSync(old, new Date(0), new Date(0));
  const recent = path.join(dir, 'backups', 'vnedge-20990101-000000.db'); fs.writeFileSync(recent, '');
  const unrelated = path.join(dir, 'backups', 'notes.txt'); fs.writeFileSync(unrelated, ''); fs.utimesSync(unrelated, new Date(0), new Date(0));
  const r = db.backup(path.join(dir, 'backups'), 7, Date.UTC(2026, 8, 21, 2, 0, 0));
  assert.equal(path.basename(r.file), 'vnedge-20260921-020000.db');
  assert.ok(r.bytes > 0); assert.deepEqual(r.pruned, [old]);
  assert.ok(fs.existsSync(recent) && fs.existsSync(unrelated), 'only vnedge-*.db older than keepDays is removed');
  const copy = new DatabaseSync(r.file);
  assert.deepEqual(JSON.parse((copy.prepare('SELECT v FROM kv WHERE k = ?').get('hello') as any).v), { world: 1 });
  copy.close();
  const list = Db.listBackups(path.join(dir, 'backups'));
  assert.deepEqual(list.map(b => path.basename(b.file)).sort(), ['vnedge-20260921-020000.db', 'vnedge-20990101-000000.db']);
});

test('BackupService: on-demand runs share in-flight work, persist lastAt and compute the next schedule', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnedge-bk2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new Db(path.join(dir, 'vnedge.db'));
  t.after(() => db.db.close());
  const svc = new BackupService(db, path.join(dir, 'backups'), () => ({ hourUtc: 2, keepDays: 3 }));
  assert.equal(svc.status().lastAt, null);
  const [a, b] = await Promise.all([svc.run('a'), svc.run('b')]);
  assert.equal(a.file, b.file, 'concurrent calls share one snapshot');
  const st = svc.status();
  assert.equal(st.count, 1); assert.equal(st.lastFile, a.file); assert.equal(st.running, false);
  assert.deepEqual(db.kvGet('ops.backup.last'), { at: a.at, file: a.file, bytes: a.bytes });
  const again = new BackupService(db, path.join(dir, 'backups'), () => ({ hourUtc: 2, keepDays: 3 }));
  assert.equal(again.status().lastAt, a.at, 'lastAt survives a restart');
  assert.equal(svc.nextAt(Date.UTC(2026, 0, 1, 1, 0)), Date.UTC(2026, 0, 1, 2, 0));
  assert.equal(svc.nextAt(Date.UTC(2026, 0, 1, 2, 0)), Date.UTC(2026, 0, 2, 2, 0));
  const broken = new BackupService(db, path.join(dir, 'vnedge.db', 'impossible'), () => ({ hourUtc: 2, keepDays: 3 }));
  await assert.rejects(broken.run());
  assert.equal(broken.status().failures, 1); assert.ok(broken.status().lastError);
});
