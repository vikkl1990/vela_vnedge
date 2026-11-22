import type { Db } from '../db.ts';
import { ACCOUNT_AND_SHADOW_EVIDENCE } from './scope.ts';
import { classClause, classOf } from '../markets/classes.ts';
import { isAssetGroup, isAssetSector } from '../../../shared/assetClass.ts';

export interface PerformanceFilter { from?: number; to?: number; scanner?: string; symbol?: string; tf?: string; side?: string; reason?: string; group?: string; sector?: string }
export interface PerformanceStats {
  trades: number; rTrades: number; wins: number; stops: number; trails: number;
  net: number; commission: number; funding: number; grossTrading: number;
  sumR: number | null; avgR: number | null; winRate: number | null; stopRate: number | null;
  profitFactor: number | null; noLosses: boolean; fundingUnknown: number; avgCommissionR: number | null;
  /** Standard error of avgR with trades clustered by closing day (trades closed the same day move together), and how many days that is. Null when there are fewer than two days. */
  seR: number | null; rDays: number;
}
export interface PerformanceGroup { key: string; label: string; paper: PerformanceStats; shadow: PerformanceStats }
export interface PerformanceReport {
  at: number; from: number | null; to: number; firstClose: number | null; lastClose: number | null;
  paper: PerformanceStats; shadow: PerformanceStats;
  daily: PerformanceGroup[]; byTf: PerformanceGroup[]; byScanner: PerformanceGroup[]; bySymbol: PerformanceGroup[]; byExit: PerformanceGroup[];
  /** Asset class of the market: majors, large-cap alts, alts, meme, stocks & metals, other; and the sector inside it. */
  byGroup: PerformanceGroup[]; bySector: PerformanceGroup[];
}
type Row = { bt: number; scanner_id: string; scanner_name: string; symbol: string; tf: string; side: string; exit_reason: string | null; exit_at: number; realized_pnl: number; fees: number; risk_amount: number; fills: string };
type Trade = Row & { net: number; r: number | null; funding: number | null };

export function validatePerformanceFilter(f: PerformanceFilter): void {
  for (const v of [f.from, f.to]) if (v !== undefined && (!Number.isSafeInteger(v) || v < 0 || v > 8.64e15)) throw new Error('Invalid closing date.');
  if (f.from !== undefined && f.to !== undefined && f.from >= f.to) throw new Error('End date must follow the start date.');
  if (f.side && f.side !== 'long' && f.side !== 'short') throw new Error('Invalid direction.');
  if (f.group && !isAssetGroup(f.group)) throw new Error('Invalid asset group.');
  if (f.sector && !isAssetSector(f.sector)) throw new Error('Invalid asset sector.');
}

export function fundingOf(raw: string): number | null {
  try {
    const data = JSON.parse(raw);
    // Legacy rows have an empty array; current rows wrap fills with execution metadata.
    const fills = Array.isArray(data) ? data : data?.fills;
    if (!Array.isArray(fills)) return null;
    let funding = 0;
    for (const f of fills) if (f?.reason === 'funding') {
      if (typeof f.pnl !== 'number' || !Number.isFinite(f.pnl)) return null;
      funding += f.pnl;
    }
    return funding;
  } catch { return null; }
}

function stats(rows: Trade[]): PerformanceStats {
  let net = 0, commission = 0, funding = 0, grossTrading = 0, wins = 0, stops = 0, trails = 0, sumR = 0, rTrades = 0, gp = 0, gl = 0, fundingUnknown = 0, commissionR = 0;
  for (const t of rows) {
    net += t.net; commission += t.fees;
    if (t.funding === null) fundingUnknown++;
    else { funding += t.funding; grossTrading += t.realized_pnl - t.funding; }
    if (t.net > 0) { wins++; gp += t.net; } else gl -= t.net;
    if (t.exit_reason === 'sl') stops++;
    if (t.exit_reason === 'trail') trails++;
    if (t.r !== null) { rTrades++; sumR += t.r; commissionR += t.fees / t.risk_amount; }
  }
  // Day-clustered standard error of the mean R: the sum of each day's deviations from the mean, squared, over n. Trades closed
  // on one day share the market's mood, so treating them as independent would claim more certainty than the data holds.
  const mean = rTrades ? sumR / rTrades : 0, byDay = new Map<number, number>();
  for (const t of rows) if (t.r !== null) { const d = Math.floor(t.exit_at / 86_400_000); byDay.set(d, (byDay.get(d) ?? 0) + (t.r - mean)); }
  let ss = 0; for (const v of byDay.values()) ss += v * v;
  // CR1 finite-cluster correction. For an intercept-only mean, the remaining
  // (n-1)/(n-k) factor is one. Repeating trades within a day adds no independent days.
  const seR = rTrades >= 2 && byDay.size >= 2 ? Math.sqrt(ss * byDay.size / (byDay.size - 1)) / rTrades : null;
  return { trades: rows.length, rTrades, wins, stops, trails, net, commission, funding, grossTrading, seR, rDays: byDay.size,
    sumR: rTrades ? sumR : null, avgR: rTrades ? sumR / rTrades : null,
    winRate: rows.length ? wins / rows.length * 100 : null, stopRate: rows.length ? stops / rows.length * 100 : null,
    profitFactor: gl > 0 ? gp / gl : null, noLosses: gp > 0 && gl === 0, fundingUnknown, avgCommissionR: rTrades ? commissionR / rTrades : null };
}

/** Same closing window and filters for both books. Closed-account totals reconcile to the journal;
 * shadow omits watch-only orders using frozen membership, matching Daily. This reports observations, not a paired experiment. */
export function performanceReport(db: Db, f: PerformanceFilter = {}, now = Date.now()): PerformanceReport {
  validatePerformanceFilter(f);
  const to = Math.min(f.to ?? now, now);
  const where = ["p.status='closed'", "p.scanner_id NOT LIKE 'plan:%'", 'p.bt IN (0,2)', 'p.exit_at < ?', ACCOUNT_AND_SHADOW_EVIDENCE];
  const args: (string | number)[] = [to];
  if (f.from !== undefined) { where.push('p.exit_at >= ?'); args.push(f.from); }
  for (const [column, value] of [['scanner_id', f.scanner], ['symbol', f.symbol], ['tf', f.tf], ['side', f.side], ['exit_reason', f.reason]]) {
    if (value) { where.push(`p.${column} = ?`); args.push(value); }
  }
  const cls = classClause(db, f, 'p.symbol');
  if (cls) { where.push(cls.sql); args.push(...cls.args); }
  const rows = db.all<Row>(`SELECT p.bt,p.scanner_id,p.scanner_name,p.symbol,p.tf,p.side,p.exit_reason,p.exit_at,p.realized_pnl,p.fees,p.risk_amount,p.fills FROM positions p WHERE ${where.join(' AND ')} ORDER BY p.exit_at,p.id`, ...args);
  const trades: Trade[] = rows.map(t => {
    const net = t.realized_pnl - t.fees, r = t.risk_amount > 0 ? net / t.risk_amount : NaN;
    return { ...t, net, r: Number.isFinite(r) ? r : null, funding: fundingOf(t.fills) };
  });
  const books = (ts: Trade[]) => ({ paper: stats(ts.filter(t => t.bt === 0)), shadow: stats(ts.filter(t => t.bt === 2)) });
  const groups = (key: (t: Trade) => string, label = key): PerformanceGroup[] => {
    const buckets = new Map<string, { label: string; trades: Trade[] }>();
    for (const t of trades) { const k = key(t), b = buckets.get(k) ?? { label: label(t), trades: [] }; b.trades.push(t); buckets.set(k, b); }
    return [...buckets].map(([key, b]) => ({ key, label: b.label, ...books(b.trades) }));
  };
  return { at: now, from: f.from ?? null, to, firstClose: trades[0]?.exit_at ?? null, lastClose: trades.at(-1)?.exit_at ?? null,
    ...books(trades), daily: groups(t => new Date(t.exit_at).toISOString().slice(0, 10)),
    byTf: groups(t => t.tf), byScanner: groups(t => t.scanner_id, t => t.scanner_name), bySymbol: groups(t => t.symbol), byExit: groups(t => t.exit_reason ?? 'unknown'),
    byGroup: groups(t => classOf(t.symbol).group), bySector: groups(t => classOf(t.symbol).sector) };
}
