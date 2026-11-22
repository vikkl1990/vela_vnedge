import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ConfigStore, type AppConfig } from '../server/src/config.ts';

export function assertPaper(cfg: AppConfig) {
  if (cfg.execution.mode !== 'paper' || cfg.execution.allowProduction !== false)
    throw new Error('paper mode only: execution must be paper with allowProduction false');
}

export function requireFleetMaintenance(probe = () => execFileSync('systemctl', ['show', 'vnedge', '--property=ActiveState', '--value'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })) {
  let state: string;
  try { state = probe().trim(); } catch { throw new Error('Cannot verify vnedge is stopped; fleet mutation refused'); }
  if (state !== 'inactive') throw new Error('Stop vnedge before applying fleet changes');
}

/** One validated, durable rename, protected against concurrent operator writes.
 * A failed commit leaves the old config and a private backup/intent for recovery. */
export function commitFleetConfig(file: string, before: string, after: string, label: string, prepare = () => {}) {
  const lock = `${file}.fleet-lock`, tmp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(lock, 'wx', 0o600);
  const backup = `${file}.before-${label}`;
  try {
    fs.writeFileSync(tmp, after, { mode: 0o600, flag: 'wx' });
    assertPaper(new ConfigStore(tmp).get());
    const out = fs.openSync(tmp, 'r'); try { fs.fsyncSync(out); } finally { fs.closeSync(out); }
    if (fs.readFileSync(file, 'utf8') !== before) throw new Error('configuration changed during the run; nothing written');
    fs.writeFileSync(backup, before, { mode: 0o600, flag: 'wx' });
    const saved = fs.openSync(backup, 'r'); try { fs.fsyncSync(saved); } finally { fs.closeSync(saved); }
    prepare();
    if (fs.readFileSync(file, 'utf8') !== before) throw new Error('configuration changed during the run; nothing written');
    fs.renameSync(tmp, file);
    const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    return backup;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    fs.unlinkSync(lock);
  }
}
