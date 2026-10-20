/**
 * Decision 151: after an engine upgrade, the pairs of the scanners whose signals changed re-prove themselves on the
 * new engine. Shadow and proposed pairs keep trading with their evidence window restarted; candidates' screens expire
 * so the nightly screen re-screens them; live, tracked and retired pairs are left alone. Dry run unless APPLY=1.
 * Usage: IDS=changed-ids.txt NOTE="PineTS 0.12.0" [APPLY=1] node src/cli/rescreen.ts
 */
import fs from 'node:fs';
import { Db } from '../db.ts';
import { IncubatorStore } from '../incubator/store.ts';

const ids = new Set(fs.readFileSync(process.env.IDS!, 'utf8').split(/[\s,[\]"]+/).filter(Boolean));
const note = `re-proving on ${process.env.NOTE ?? 'a new engine'} (decision 151)`;
const apply = process.env.APPLY === '1';
const store = new IncubatorStore(new Db());
const now = Date.now();
const counts: Record<string, number> = {};
for (const r of store.list()) {
  if (!ids.has(r.scannerId)) continue;
  let action = 'left';
  if (r.stage === 'shadow' || r.stage === 'proposed') { action = 'evidence restarted'; if (apply) store.restartEvidence(r.id, 'engine-upgrade', note, now); }
  else if (r.stage === 'candidate' && r.screen) { action = 'screen expired'; if (apply) store.expireScreen(r.id, 'engine-upgrade', note, now); }
  const k = `${r.stage}: ${action}`; counts[k] = (counts[k] ?? 0) + 1;
}
console.log(`${apply ? 'applied' : 'dry run'} for ${ids.size} scanners:`, counts);
