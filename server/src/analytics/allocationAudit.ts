import type { Db } from '../db.ts';
export interface Allocation { scannerId: string; scannerName: string; symbol: string; tf: string }
type Row = { bt: number; entry_at: number; exit_at: number; realized_pnl: number; fees: number; risk_amount: number; exit_reason: string; config_fp: string | null };
export function summarizeAllocation(rows: Row[]) {
  const sum = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0);
  const netR = sum(r => (r.realized_pnl - r.fees) / r.risk_amount);
  return { n: rows.length, netR, grossR: sum(r => r.realized_pnl / r.risk_amount), feeR: sum(r => r.fees / r.risk_amount),
    avgR: rows.length ? netR / rows.length : null, stops: rows.filter(r => r.exit_reason === 'sl').length,
    firstBarStops: rows.filter(r => r.exit_reason === 'sl' && r.exit_at - r.entry_at <= 3600_000).length,
    cohorts: new Set(rows.map(r => r.config_fp).filter(Boolean)).size, missingCohort: rows.filter(r => !r.config_fp).length };
}
/** Exact currently allocated tuples, never scanner-ID-only history or retired pairs. Descriptive, no auto action. */
export function allocationAudit(db: Db, allocations: Allocation[], now = Date.now()) {
  const split = now - 7 * 86400_000, since = now - 14 * 86400_000;
  const unique = [...new Map(allocations.filter(a => a.tf === '1h').map(a => [JSON.stringify([a.scannerId,a.symbol,a.tf]), a])).values()];
  const rows = unique.map(a => {
    const history = db.all<Row>(`SELECT bt,entry_at,exit_at,realized_pnl,fees,risk_amount,exit_reason,config_fp FROM positions
      WHERE status='closed' AND bt IN (0,2) AND scanner_id=? AND symbol=? AND tf=? AND entry_at>=? AND entry_at<=? AND risk_amount>0`, a.scannerId,a.symbol,a.tf,since,now);
    const book = (bt: number) => ({ recent: summarizeAllocation(history.filter(r => r.bt===bt && r.entry_at>=split)), prior: summarizeAllocation(history.filter(r => r.bt===bt && r.entry_at<split)) });
    const account = book(0), shadow = book(2);
    const verdict = account.recent.n < 30 || shadow.recent.n < 30 ? 'insufficient evidence' : account.recent.netR < 0 && shadow.recent.netR < 0 ? 'review losses in both books' : account.recent.grossR > 0 && account.recent.netR < 0 ? 'review cost drag' : 'observe';
    return { ...a, account, shadow, verdict };
  });
  const execution = db.all<any>('SELECT * FROM entry_execution ORDER BY entry_at DESC LIMIT 20');
  return { at: now, since, split, rows, execution,
    note: 'Current account allocations, exact scanner/symbol/1h tuples. Trades grouped by entry date. Each window is seven days. Historical settings may differ; cohorts count distinct recorded fingerprints. No automatic promotion or disabling. Depth is sampled after entry, not available to that entry decision.' };
}
