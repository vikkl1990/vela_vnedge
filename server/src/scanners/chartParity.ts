/**
 * Chart-versus-bot parity report. The chart records its closed-bar observation of a scanner once
 * the bot has scanned the same bar; the server recomputes the verdict against its own receipt
 * (`compareChart`) and never trusts a client-supplied verdict. One row per cell and closed bar.
 * Diagnostic only: it never runs Pine, changes evidence or affects admission.
 */
import type { Db } from '../db.ts';
import { chartReceipt } from './chartReceipts.ts';
import { compareChart, type ChartObservation, type ParityReport, type ParityScanner } from '../../../shared/chartVerification.ts';

const KEEP_MS = 30 * 86_400_000;
const MAX_VALUES = 512;
const MAX_INPUTS = 100;
const MAX_DIFFERENCES = 20;

const initialized = new WeakSet<Db>();
function init(db: Db) {
  if (initialized.has(db)) return;
  db.run(`CREATE TABLE IF NOT EXISTS chart_parity (
    scanner_id TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL, bar_time INTEGER NOT NULL, at INTEGER NOT NULL,
    status TEXT NOT NULL, comparable INTEGER NOT NULL, differed INTEGER NOT NULL, differences TEXT NOT NULL, source_hash TEXT,
    PRIMARY KEY (scanner_id, symbol, tf, bar_time))`);
  db.run('CREATE INDEX IF NOT EXISTS chart_parity_at ON chart_parity(at)');
  initialized.add(db);
}

export class ParityInputError extends Error {}

const text = (v: unknown, max: number, name: string) => { if (typeof v !== 'string' || !v || v.length > max) throw new ParityInputError(`invalid ${name}`); return v; };
const finite = (v: unknown, name: string) => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new ParityInputError(`invalid ${name}`); return v; };
const optionalNumber = (v: unknown, name: string) => v === undefined || v === null ? v : finite(v, name);

/** Validate and bound a chart observation from the browser. */
export function parseObservation(body: unknown): ChartObservation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ParityInputError('observation must be an object');
  const b = body as Record<string, unknown>;
  const map = <T>(v: unknown, max: number, name: string, ok: (x: unknown) => x is T): Record<string, T> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ParityInputError(`invalid ${name}`);
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length > max) throw new ParityInputError(`too many ${name}`);
    const out: Record<string, T> = Object.create(null);
    for (const [k, x] of entries) { if (k.length > 160 || !ok(x)) throw new ParityInputError(`invalid ${name}`); out[k] = x; }
    return out;
  };
  return {
    scannerId: text(b.scannerId, 200, 'scannerId'), symbol: text(b.symbol, 40, 'symbol'), tf: text(b.tf, 8, 'tf'),
    barTime: finite(b.barTime, 'barTime'),
    sourceHash: b.sourceHash === null ? null : text(b.sourceHash, 128, 'sourceHash'),
    historyFrom: b.historyFrom === null ? null : finite(b.historyFrom, 'historyFrom'),
    inputs: map(b.inputs, MAX_INPUTS, 'inputs', (x): x is number | string | boolean => typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'string' && x.length <= 500)),
    inputsChanged: Boolean(b.inputsChanged), timezone: text(b.timezone, 64, 'timezone'),
    values: map(b.values, MAX_VALUES, 'values', (x): x is number | null => x === null || (typeof x === 'number' && Number.isFinite(x))),
    complete: Boolean(b.complete),
    ...(b.historyHash !== undefined ? { historyHash: text(b.historyHash, 128, 'historyHash') } : {}),
    ...(b.historyBars !== undefined ? { historyBars: optionalNumber(b.historyBars, 'historyBars') as number } : {}),
    ...(b.valuesTruncated !== undefined ? { valuesTruncated: Boolean(b.valuesTruncated) } : {}),
  };
}

/**
 * Recompute and store the verdict for one observation. Nothing is stored until the server has a
 * receipt for the same closed bar (the chart may run ahead of the scan); a later observation of
 * the same bar replaces the earlier one.
 */
export function recordParity(db: Db, o: ChartObservation, now = Date.now()): { recorded: boolean; status: string } {
  init(db);
  const receipt = chartReceipt(db, o.scannerId, o.symbol, o.tf);
  const result = compareChart(o, receipt);
  if (!receipt || receipt.barTime !== o.barTime) return { recorded: false, status: result.status };
  db.run(`INSERT INTO chart_parity(scanner_id,symbol,tf,bar_time,at,status,comparable,differed,differences,source_hash) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(scanner_id,symbol,tf,bar_time) DO UPDATE SET at=excluded.at,status=excluded.status,comparable=excluded.comparable,
      differed=excluded.differed,differences=excluded.differences,source_hash=excluded.source_hash`,
    o.scannerId, o.symbol, o.tf, o.barTime, now, result.status, result.comparable ? 1 : 0, result.differences.length ? 1 : 0,
    JSON.stringify(result.differences.slice(0, MAX_DIFFERENCES)), receipt.sourceHash);
  if (Math.random() < 0.02) db.run('DELETE FROM chart_parity WHERE at<?', now - KEEP_MS);
  return { recorded: true, status: result.status };
}

/** Per-scanner summary over the last `days` (1–30). */
export function parityReport(db: Db, days = 7, now = Date.now()): ParityReport {
  init(db);
  const d = Math.min(30, Math.max(1, Math.floor(Number.isFinite(days) ? days : 7)));
  const since = now - d * 86_400_000;
  const rows = db.all<{ scanner_id: string; symbol: string; tf: string; bar_time: number; at: number; status: string; comparable: number; differed: number; differences: string }>(
    'SELECT * FROM chart_parity WHERE at>=? ORDER BY at DESC', since);
  const by = new Map<string, ParityScanner & { cellSet: Set<string> }>();
  for (const r of rows) {
    let s = by.get(r.scanner_id);
    if (!s) { s = { scannerId: r.scanner_id, cells: 0, checks: 0, comparable: 0, agreed: 0, differed: 0, notComparable: {}, lastAt: r.at, lastDifference: null, verdict: 'unverified', cellSet: new Set() }; by.set(r.scanner_id, s); }
    s.checks++; s.cellSet.add(`${r.symbol}|${r.tf}`);
    if (r.differed) {
      s.differed++;
      // rows are newest first: the first differing row is the latest difference
      if (!s.lastDifference) s.lastDifference = { symbol: r.symbol, tf: r.tf, barTime: r.bar_time, outputs: JSON.parse(r.differences) };
    }
    if (r.comparable) { s.comparable++; if (!r.differed) s.agreed++; }
    else if (!r.differed) s.notComparable[r.status] = (s.notComparable[r.status] ?? 0) + 1;
  }
  const scanners = [...by.values()].map(({ cellSet, ...s }) => ({
    ...s, cells: cellSet.size,
    verdict: (s.differed ? 'diverges' : s.comparable ? 'agrees' : 'unverified') as ParityScanner['verdict'],
  })).sort((a, b) => (a.verdict === b.verdict ? b.lastAt - a.lastAt : a.verdict === 'diverges' ? -1 : b.verdict === 'diverges' ? 1 : a.verdict === 'unverified' ? 1 : -1));
  return { since, days: d, scanners };
}
