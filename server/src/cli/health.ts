/**
 * Scripts the runtime cannot execute.
 *
 *   npm run health                     # what is quarantined and why
 *   npm run health -- release          # screen them all again (after a PineTS upgrade)
 *   npm run health -- release "runtime gap"
 *   npm run health -- seed            # quarantine from the compatibility report already on disk
 */
import fs from 'node:fs';
import { Db } from '../db.ts';
import { ScriptHealth, permanentReason } from '../scanners/health.ts';
import { ScannerRegistry } from '../scanners/registry.ts';

const health = new ScriptHealth(new Db());
const [cmd, like] = process.argv.slice(2);
if (cmd === 'seed') {
  // the compatibility report is a full run of the library: every failure in it has already happened twice over
  const file = new URL('../../../scripts/compat-report.json', import.meta.url);
  const rows: any[] = JSON.parse(fs.readFileSync(file, 'utf8')).rows ?? [];
  let n = 0;
  for (const r of rows) {
    if (r.ok || !permanentReason(r.error)) continue;
    health.record(r.id, r.error); if (health.record(r.id, r.error) || health.isQuarantined(r.id)) n++;
  }
  console.log(`quarantined ${n} of ${rows.length} scripts from the compatibility report; run "npm run health" to see why`);
} else if (cmd === 'release') {
  console.log(`released ${health.release(like)} script(s)${like ? ` matching "${like}"` : ''}; the next screen will try them again`);
} else {
  const reg = new ScannerRegistry();
  const rows = health.list();
  const q = rows.filter(r => r.quarantined);
  console.log(`${q.length} quarantined, ${rows.length - q.length} with one strike\n`);
  const byReason = new Map<string, string[]>();
  for (const r of q) { const g = byReason.get(r.reason ?? '?'); g ? g.push(r.scannerId) : byReason.set(r.reason ?? '?', [r.scannerId]); }
  for (const [reason, ids] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${String(ids.length).padStart(4)}  ${reason}`);
    for (const id of ids.slice(0, 6)) console.log(`      ${reg.get(id)?.name ?? id}`);
    if (ids.length > 6) console.log(`      …and ${ids.length - 6} more`);
  }
}
