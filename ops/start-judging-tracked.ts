#!/usr/bin/env node
/**
 * Start judging a tracked cell (decision 322).
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

export function startJudging(o: { dbFile: string; cells: JudgeCell[]; apply?: boolean; now?: number }) {
  if (!o.cells.length || o.cells.length > 20) throw new Error('give 1 to 20 cells');
  const now = o.now ?? Date.now();
  // the stage of every cell is read first, read-only: nothing is written unless every cell is a tracked one
  const ro = new DatabaseSync(o.dbFile, { readOnly: true });
  const rows = o.cells.map((c) => ({ c, row: ro.prepare('SELECT stage, note FROM incubator_pairs WHERE scanner_id=? AND symbol=? AND tf=?').get(c.scannerId, c.symbol, c.tf) as { stage: string; note: string | null } | undefined }));
  const shadowNow = (ro.prepare("SELECT COUNT(*) n FROM incubator_pairs WHERE stage='shadow'").get() as { n: number }).n;
  ro.close();
  const refused = rows.filter((r) => r.row?.stage !== 'tracked').map((r) => ({ ...r.c, reason: r.row ? `is ${r.row.stage}, not tracked` : 'no such pair' }));
  if (refused.length) throw new Error(`refused, nothing written: ${refused.map((r) => `${r.scannerId} ${r.symbol} ${r.tf} ${r.reason}`).join('; ')}`);
  const result = { dryRun: !o.apply, cells: rows.map((r) => ({ ...r.c, from: 'tracked', to: 'shadow', trackedBy: r.row!.note })), shadowPairsBefore: shadowNow };
  if (!o.apply) return result;
  const db = new Db(o.dbFile);
  try {
    const store = new IncubatorStore(db);
    db.transaction(() => {
      for (const { c, row } of rows) store.move(c, 'shadow', 'operator', { from: 'tracker', tracker: row!.note }, 'started judging: moved from tracker', now);
    });
    return { ...result, dryRun: false, shadowPairsAfter: store.list(['shadow']).length };
  } finally { db.db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dbFile = process.env.VNEDGE_DB ?? path.join(ROOT, 'data', 'vnedge.db');
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!fs.existsSync(dbFile)) throw new Error(`no database at ${dbFile}`);
  const out = startJudging({ dbFile, cells: (args.length ? args : DEFAULT_CELLS).map(parseCell), apply: process.argv.includes('--apply') });
  console.log(JSON.stringify(out, null, 2));
  if (out.dryRun) console.log('\ndry run: nothing was written. Add --apply (service stopped) to move them.');
}
