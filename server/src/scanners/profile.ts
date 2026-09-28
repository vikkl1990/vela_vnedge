/**
 * What a script actually produces in our runtime, classified from a real run rather than from its
 * description (decision 48):
 *
 *   plan     entries with a stop or targets — the author's own trade engine
 *   signal   directional entries and nothing else — our ATR stop and ladder apply
 *   levels   labels or plots only — information, not a scanner
 *   silent   ran without error and emitted nothing
 *   broken   did not run
 *
 * The profile is stored per scanner × market × timeframe so the dashboard can show what a script
 * *is* next to what it earned, and the rebuild can tell an over-read script from a bad one.
 */
import type { Db } from '../db.ts';
import type { WorkerResult } from '../pine/worker.ts';
import type { ScanEvent } from './extractor.ts';

export type ProfileKind = 'plan' | 'signal' | 'levels' | 'silent' | 'broken';
export interface ProfileRow {
  scannerId: string; market: string; tf: string; at: number; kind: ProfileKind; ms: number;
  entries: number; withSl: number; withTp: number; exits: number; info: number;
  alertEntries: number; alertconds: number; shapes: number; labels: number; labelTexts: string[]; plots: number; error: string | null;
}

const RANK: Record<ProfileKind, number> = { plan: 4, signal: 3, levels: 2, silent: 1, broken: 0 };

/** Classify one run by what came out of it. */
export function classifyRun(res: WorkerResult, events: ScanEvent[]): Omit<ProfileRow, 'scannerId' | 'market' | 'tf' | 'at'> {
  const entries = events.filter(e => e.kind === 'entry');
  const withSl = entries.filter(e => e.sl).length, withTp = entries.filter(e => e.tp.length).length;
  const shapes = res.shapes.reduce((a, s) => a + s.times.length, 0);
  const labelTexts = [...new Set(res.labels.map(l => l.text.replace(/[\d.,%:]+/g, '#').trim()).filter(Boolean))].slice(0, 8);
  const kind: ProfileKind = entries.length ? (withSl || withTp ? 'plan' : 'signal') : (res.labels.length || res.plots.length ? 'levels' : 'silent');
  return {
    kind, ms: res.ms, entries: entries.length, withSl, withTp, exits: events.filter(e => e.kind === 'exit').length, info: events.filter(e => e.kind === 'info').length,
    alertEntries: entries.filter(e => e.source === 'alert').length, alertconds: res.alerts.filter(a => a.type === 'alertcondition').length,
    shapes, labels: res.labels.length, labelTexts, plots: res.plots.length, error: null,
  };
}

export function brokenRun(error: string, ms = 0): Omit<ProfileRow, 'scannerId' | 'market' | 'tf' | 'at'> {
  return { kind: 'broken', ms, entries: 0, withSl: 0, withTp: 0, exits: 0, info: 0, alertEntries: 0, alertconds: 0, shapes: 0, labels: 0, labelTexts: [], plots: 0, error: error.slice(0, 200) };
}

/** The one word for a scanner across its profiled timeframes: the best it managed anywhere. */
export function summarizeKind(rows: ProfileRow[]): ProfileKind | null {
  if (!rows.length) return null;
  return rows.reduce((best, r) => (RANK[r.kind] > RANK[best] ? r.kind : best), rows[0].kind);
}

export class ProfileStore {
  private db: Db;
  constructor(db: Db) { this.db = db; }

  save(row: ProfileRow): void {
    this.db.run(
      `INSERT INTO script_profile(scanner_id, market, tf, at, kind, ms, entries, with_sl, with_tp, exits, info, alert_entries, alertconds, shapes, labels, label_texts, plots, error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(scanner_id, market, tf) DO UPDATE SET at=excluded.at, kind=excluded.kind, ms=excluded.ms, entries=excluded.entries, with_sl=excluded.with_sl, with_tp=excluded.with_tp,
         exits=excluded.exits, info=excluded.info, alert_entries=excluded.alert_entries, alertconds=excluded.alertconds, shapes=excluded.shapes, labels=excluded.labels, label_texts=excluded.label_texts, plots=excluded.plots, error=excluded.error`,
      row.scannerId, row.market, row.tf, row.at, row.kind, row.ms, row.entries, row.withSl, row.withTp, row.exits, row.info, row.alertEntries, row.alertconds, row.shapes, row.labels, JSON.stringify(row.labelTexts), row.plots, row.error,
    );
  }

  forScanner(scannerId: string): ProfileRow[] { return this.db.all<any>('SELECT * FROM script_profile WHERE scanner_id=? ORDER BY market, tf', scannerId).map(fromRow); }

  /** Every scanner's summary kind and the time of its latest profile, in one query for the list view. */
  summaries(): Map<string, { kind: ProfileKind; at: number; tfs: number }> {
    const out = new Map<string, { kind: ProfileKind; at: number; tfs: number }>();
    const by = new Map<string, ProfileRow[]>();
    for (const r of this.db.all<any>('SELECT * FROM script_profile').map(fromRow)) { const l = by.get(r.scannerId) ?? []; l.push(r); by.set(r.scannerId, l); }
    for (const [id, rows] of by) out.set(id, { kind: summarizeKind(rows)!, at: Math.max(...rows.map(r => r.at)), tfs: new Set(rows.map(r => r.tf)).size });
    return out;
  }
}

function fromRow(r: any): ProfileRow {
  let labelTexts: string[] = [];
  try { labelTexts = JSON.parse(r.label_texts ?? '[]'); } catch { labelTexts = []; }
  return { scannerId: r.scanner_id, market: r.market, tf: r.tf, at: r.at, kind: r.kind, ms: r.ms, entries: r.entries, withSl: r.with_sl, withTp: r.with_tp, exits: r.exits, info: r.info, alertEntries: r.alert_entries, alertconds: r.alertconds, shapes: r.shapes, labels: r.labels, labelTexts, plots: r.plots, error: r.error ?? null };
}
