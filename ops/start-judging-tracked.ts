#!/usr/bin/env node
/**
 * Start judging a tracked cell (decision 325).
 *
 * A tracked cell is shadow-traded for the operator to watch, outside the incubator's judgement: the gate never promotes, retires
 * or ages it, its trades are watch-only evidence, and the account never copies it. This moves chosen cells from `tracked` to
 * `shadow`, so from now on their trades count as evidence, the gate judges them and the copy pilot can mirror them. The record
 * the cell made while tracked stays watch-only and is not counted; the judging window starts now. A cell that is not tracked is
 * refused, and the move is written to the incubator's event log with the actor `operator`.
 *
 *   node ops/start-judging-tracked.ts [scanner:SYMBOL:tf ...]            dry run (default cell: nexus-fusion-engine-ml:BTCUSD:15m)
 *   node ops/start-judging-tracked.ts --apply [scanner:SYMBOL:tf ...]    moves them; run with the service stopped
 *
 * VNEDGE_DB overrides the database path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ConfigStore } from '../server/src/config.ts';
import { selectAdmissions } from '../server/src/incubator/capacity.ts';
import type { PairRow } from '../server/src/incubator/store.ts';
import { assertPaper, requireFleetMaintenance } from './fleet-maintenance.ts';
import { Db } from '../server/src/db.ts';
import { IncubatorStore } from '../server/src/incubator/store.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CELLS = ['nexus-fusion-engine-ml:BTCUSD:15m'];

export interface JudgeCell { scannerId: string; symbol: string; tf: string }
export function parseCell(text: string): JudgeCell {
  const [scannerId, symbol, tf, extra] = text.split(':');
  if (!scannerId || !symbol || !tf || extra !== undefined) throw new Error(`cell "${text}": expected scanner:SYMBOL:tf`);
  return { scannerId, symbol, tf };
}

export function startJudging(o: { dbFile: string; configFile?: string; cells: JudgeCell[]; apply?: boolean; now?: number }) {
  if (!o.cells.length || o.cells.length > 20) throw new Error('give 1 to 20 cells');
  if (new Set(o.cells.map(c => `${c.scannerId}:${c.symbol}:${c.tf}`)).size !== o.cells.length) throw new Error('duplicate cells');
  const now = o.now ?? Date.now();
  const configFile = o.configFile ?? path.join(path.dirname(o.dbFile), 'config.json');
  const configBytes = fs.readFileSync(configFile, 'utf8');
  const cfg = new ConfigStore(configFile).get();
  assertPaper(cfg);
  const check = (db: DatabaseSync) => {
    if (fs.readFileSync(configFile, 'utf8') !== configBytes) throw new Error('configuration changed; nothing written');
    const active = db.prepare("SELECT id,scanner_id scannerId,symbol,tf,stage,since,updated,note FROM incubator_pairs WHERE stage IN ('shadow','proposed') ORDER BY id").all() as unknown as PairRow[];
    const rows = o.cells.map(c => db.prepare('SELECT id,scanner_id scannerId,symbol,tf,stage,since,updated,note FROM incubator_pairs WHERE scanner_id=? AND symbol=? AND tf=?').get(c.scannerId, c.symbol, c.tf) as unknown as PairRow | undefined);
    if (rows.some(r => r?.stage !== 'tracked')) throw new Error('refused, nothing written: every cell must still be tracked');
    // Neutral ranking only: this operator move has no backtest ranking to invent.
    const candidates = (rows as PairRow[]).map(r => ({ ...r, screen: { trades: 0, profitFactor: 1, windowsUp: 0 } }));
    // The same reservation and per-scanner capacity rules as normal admission.
    const admission = selectAdmissions(active, candidates, cfg.incubator);
    if (admission.selected.length !== candidates.length) throw new Error('shadow capacity or scanner allocation limit reached; nothing written');
    const quarantined = db.prepare('SELECT scanner_id FROM script_health WHERE quarantined=1').all() as Array<{ scanner_id: string }>;
    if (quarantined.some(q => candidates.some(c => c.scannerId === q.scanner_id))) throw new Error('quarantined scanner; nothing written');
    return { rows: candidates, shadowNow: active.length };
  };
  const ro = new DatabaseSync(o.dbFile, { readOnly: true });
  let checked;
  try { checked = check(ro); } finally { ro.close(); }
  const result = { dryRun: !o.apply, cells: checked.rows.map(r => ({ scannerId: r.scannerId, symbol: r.symbol, tf: r.tf, from: 'tracked', to: 'shadow', trackedBy: r.note })), shadowPairsBefore: checked.shadowNow };
  if (!o.apply) return result;
  const db = new Db(o.dbFile);
  try {
    const store = new IncubatorStore(db);
    db.transaction(() => {
      // Re-read after acquiring BEGIN IMMEDIATE: never demote a concurrently promoted cell.
      const current = check(db.db);
      for (const row of current.rows) store.move(row, 'shadow', 'operator', { from: 'tracker', tracker: row.note }, 'started judging: moved from tracker', now);
    });
    return { ...result, dryRun: false, shadowPairsAfter: store.list(['shadow']).length };
  } finally { db.db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dbFile = process.env.VNEDGE_DB ?? path.join(ROOT, 'data', 'vnedge.db');
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!fs.existsSync(dbFile)) throw new Error(`no database at ${dbFile}`);
  if (process.argv.includes('--apply')) requireFleetMaintenance();
  const out = startJudging({ dbFile, configFile: process.env.VNEDGE_CONFIG, cells: (args.length ? args : DEFAULT_CELLS).map(parseCell), apply: process.argv.includes('--apply') });
  console.log(JSON.stringify(out, null, 2));
  if (out.dryRun) console.log('\ndry run: nothing was written. Add --apply (service stopped) to move them.');
}
