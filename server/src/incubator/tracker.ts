/**
 * Trackers (decision 139): a named set of scanners × markets × timeframes shadow-traded for the operator to watch,
 * outside the incubator's judgement. A tracked cell is traded by the shadow runner with the same engine, gates and
 * costs as any shadow cell, but the gate never promotes, retires or ages it, it holds no shadow slot, the nightly
 * screen skips it, and the account never mirrors it. A cell already in the shadow book or live keeps its stage and is
 * read as a member as it is.
 */
import type { Db } from '../db.ts';
import type { IncubatorStore, PairRow } from './store.ts';

export interface TrackerDef { id: string; name: string; scanners: string[]; symbols: string[]; tfs: string[]; createdAt: number }
export interface CellStat { scannerId: string; symbol: string; tf: string; stage: string; trades: number; sumR: number; avgR: number; wins: number; stops: number; open: number; lastAt: number | null }
export interface TrackerView { tracker: TrackerDef; cells: CellStat[]; totals: { cells: number; trading: number; trades: number; sumR: number; avgR: number; winRate: number; open: number } }

const KEY = 'trackers';
const note = (id: string) => `tracker:${id}`;
export const listTrackers = (db: Db): TrackerDef[] => db.kvGet<TrackerDef[]>(KEY) ?? [];

/** Create or extend a tracker: every cell not already shadow, proposed or live becomes `tracked`. */
export function saveTracker(db: Db, store: IncubatorStore, def: Omit<TrackerDef, 'createdAt'>, now = Date.now()): { tracker: TrackerDef; added: number; kept: number } {
  if (!/^[a-z0-9-]{2,40}$/.test(def.id)) throw new Error('tracker id: 2–40 lowercase letters, digits or dashes');
  if (!def.scanners.length || !def.symbols.length || !def.tfs.length) throw new Error('a tracker needs scanners, markets and timeframes');
  const all = listTrackers(db); const prev = all.find(t => t.id === def.id);
  const tracker: TrackerDef = { ...def, createdAt: prev?.createdAt ?? now };
  let added = 0, kept = 0;
  for (const scannerId of def.scanners) for (const symbol of def.symbols) for (const tf of def.tfs) {
    const cur = store.find(scannerId, symbol, tf);
    if (cur && ['shadow', 'proposed', 'live', 'demote_proposed', 'tracked'].includes(cur.stage)) { kept++; continue; }
    store.move({ scannerId, symbol, tf }, 'tracked', 'tracker', { tracker: def.id }, note(def.id), now); added++;
  }
  db.kvSet(KEY, [...all.filter(t => t.id !== def.id), tracker]);
  return { tracker, added, kept };
}

/** Remove a tracker: its tracked cells go back to candidates with no screen, so only a fresh pass can admit them. */
export function removeTracker(db: Db, store: IncubatorStore, id: string, now = Date.now()): number {
  let n = 0;
  for (const r of store.list(['tracked'])) if (r.note === note(id)) { store.move(r, 'candidate', 'tracker', { removed: id }, 'tracker removed', now); n++; }
  db.kvSet(KEY, listTrackers(db).filter(t => t.id !== id));
  return n;
}

/** Each member cell's shadow trades since the tracker began, and the totals. */
export function trackerView(db: Db, store: IncubatorStore, t: TrackerDef): TrackerView {
  const cells: CellStat[] = [];
  for (const scannerId of t.scanners) for (const symbol of t.symbols) for (const tf of t.tfs) {
    const row: PairRow | null = store.find(scannerId, symbol, tf);
    const xs = db.all<{ r: number; x: string; at: number }>("SELECT (realized_pnl - fees) / risk_amount r, exit_reason x, exit_at at FROM positions WHERE bt=2 AND status='closed' AND risk_amount>0 AND scanner_id=? AND symbol=? AND tf=? AND entry_at>=?", scannerId, symbol, tf, t.createdAt);
    const open = db.get<{ n: number }>("SELECT COUNT(*) n FROM positions WHERE bt=2 AND status='open' AND scanner_id=? AND symbol=? AND tf=?", scannerId, symbol, tf)?.n ?? 0;
    const sumR = xs.reduce((a, x) => a + x.r, 0);
    cells.push({ scannerId, symbol, tf, stage: row?.stage ?? 'none', trades: xs.length, sumR, avgR: xs.length ? sumR / xs.length : 0, wins: xs.filter(x => x.r > 0).length, stops: xs.filter(x => x.x === 'sl').length, open, lastAt: xs.length ? Math.max(...xs.map(x => x.at)) : null });
  }
  const trades = cells.reduce((a, c) => a + c.trades, 0), sumR = cells.reduce((a, c) => a + c.sumR, 0), wins = cells.reduce((a, c) => a + c.wins, 0);
  return { tracker: t, cells, totals: { cells: cells.length, trading: cells.filter(c => c.trades > 0).length, trades, sumR, avgR: trades ? sumR / trades : 0, winRate: trades ? wins / trades : 0, open: cells.reduce((a, c) => a + c.open, 0) } };
}
