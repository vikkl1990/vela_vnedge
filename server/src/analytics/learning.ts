/**
 * What the journal teaches, in R (decision 63). Every number here was something the operator had to
 * ask for by hand during the first week of paper trading: expectancy with a confidence band rather
 * than an average, the breakeven win rate the exit policy implies, the share of gross taken by costs,
 * how many stops never moved, how much of the peak a trail gives back, and where the R came from.
 * Pure functions over closed trades so the page and the tests see the same arithmetic.
 */
import { TF_SECONDS } from '../config.ts';

export interface LearnTrade {
  scannerId: string; scannerName: string; symbol: string; tf: string; side: string;
  entryAt: number; exitAt: number; pnl: number; fees: number; rMultiple: number;
  exitReason: string | null; peakR?: number | null; riskAmount?: number;
}

export interface EdgeRow {
  key: string; label: string; n: number; avgR: number; lb90: number | null; ub90: number | null; winRatePct: number; sumR: number;
  costShare: number | null; verdict: 'paying' | 'undecided' | 'failing';
}
export interface ExitRow { reason: string; n: number; avgR: number; medianPeakR: number | null; giveBackR: number | null; sumR: number }
export interface Bucket { label: string; n: number; avgR: number; sumR: number }
export interface BookLearning {
  trades: number; sumR: number; avgR: number; lb90: number | null; ub90: number | null; winRatePct: number;
  avgWinR: number | null; avgLossR: number | null; breakevenWinPct: number | null; costShare: number | null;
  grossUsd: number; feesUsd: number; netUsd: number;
  stops: { n: number; neverMoved: number; firstBar: number; medianMinutes: number | null };
  exits: ExitRow[]; byScanner: EdgeRow[]; byPair: EdgeRow[]; byTf: EdgeRow[];
  curve: Array<{ i: number; t: number; cumR: number; ddR: number }>;
  daily: Array<{ day: string; n: number; sumR: number }>;
  holds: Bucket[]; hoursIst: Bucket[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
/** 90% band on the mean from the sample spread (t ≈ 1.645 for the sizes that matter here); null under five trades. */
export function band(rs: number[]): { lb: number | null; ub: number | null } {
  if (rs.length < 5) return { lb: null, ub: null };
  const m = mean(rs); const sd = Math.sqrt(rs.reduce((a, x) => a + (x - m) ** 2, 0) / (rs.length - 1));
  const half = 1.645 * sd / Math.sqrt(rs.length);
  return { lb: m - half, ub: m + half };
}
const R = (t: LearnTrade) => (Number.isFinite(t.rMultiple) ? t.rMultiple : 0);
const gross = (t: LearnTrade) => t.pnl + t.fees; // pnl is net of fees
/** Share of the gross winnings that costs consumed: fees over the sum of positive gross results. */
function costShare(ts: LearnTrade[]): number | null {
  const gp = ts.reduce((a, t) => a + Math.max(0, gross(t)), 0); const fees = ts.reduce((a, t) => a + t.fees, 0);
  return gp > 0 ? fees / gp : null;
}

function edgeRow(key: string, label: string, ts: LearnTrade[]): EdgeRow {
  const rs = ts.map(R); const b = band(rs); const avg = mean(rs);
  const verdict: EdgeRow['verdict'] = b.lb !== null && b.lb > 0 ? 'paying' : b.ub !== null && b.ub < 0 ? 'failing' : 'undecided';
  return { key, label, n: ts.length, avgR: avg, lb90: b.lb, ub90: b.ub, winRatePct: ts.length ? ts.filter(t => R(t) > 0).length / ts.length * 100 : 0, sumR: rs.reduce((a, x) => a + x, 0), costShare: costShare(ts), verdict };
}
function group(ts: LearnTrade[], keyOf: (t: LearnTrade) => [string, string]): EdgeRow[] {
  const by = new Map<string, { label: string; ts: LearnTrade[] }>();
  for (const t of ts) { const [k, label] = keyOf(t); const g = by.get(k) ?? { label, ts: [] }; g.ts.push(t); by.set(k, g); }
  return [...by].map(([k, g]) => edgeRow(k, g.label, g.ts)).sort((a, b) => (b.lb90 ?? -9) - (a.lb90 ?? -9) || b.sumR - a.sumR);
}
function bucketize(ts: LearnTrade[], labels: string[], pick: (t: LearnTrade) => number): Bucket[] {
  const out = labels.map(label => ({ label, n: 0, avgR: 0, sumR: 0 }));
  for (const t of ts) { const i = pick(t); if (i < 0 || i >= out.length) continue; out[i].n++; out[i].sumR += R(t); }
  for (const b of out) b.avgR = b.n ? b.sumR / b.n : 0;
  return out;
}
const HOLD_LABELS = ['< 15m', '15–60m', '1–4h', '4–24h', '> 24h'];
const holdBucket = (ms: number) => (ms < 15 * 60_000 ? 0 : ms < 60 * 60_000 ? 1 : ms < 4 * 3_600_000 ? 2 : ms < 24 * 3_600_000 ? 3 : 4);
const IST_OFFSET_MS = 5.5 * 3_600_000;

export function learnBook(trades: LearnTrade[]): BookLearning {
  const ts = [...trades].filter(t => Number.isFinite(t.entryAt) && Number.isFinite(t.exitAt)).sort((a, b) => a.exitAt - b.exitAt);
  const rs = ts.map(R); const b = band(rs);
  const wins = ts.filter(t => R(t) > 0), losses = ts.filter(t => R(t) <= 0);
  const avgWin = wins.length ? mean(wins.map(R)) : null, avgLoss = losses.length ? mean(losses.map(R)) : null;
  // the win rate at which avgWin × p + avgLoss × (1 − p) = 0
  const breakeven = avgWin !== null && avgLoss !== null && avgWin - avgLoss > 0 ? (-avgLoss / (avgWin - avgLoss)) * 100 : null;
  const stops = ts.filter(t => t.exitReason === 'sl');
  const firstBar = stops.filter(t => t.exitAt - t.entryAt <= (TF_SECONDS[t.tf] ?? 900) * 1000).length;
  const neverMoved = stops.filter(t => (t.peakR ?? 0) < 0.3).length;
  const exitsBy = new Map<string, LearnTrade[]>();
  for (const t of ts) { const k = t.exitReason ?? 'unknown'; exitsBy.set(k, [...(exitsBy.get(k) ?? []), t]); }
  const exits: ExitRow[] = [...exitsBy].map(([reason, g]) => {
    const peaks = g.map(t => t.peakR).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const gb = g.filter(t => typeof t.peakR === 'number' && Number.isFinite(t.peakR!)).map(t => t.peakR! - R(t));
    return { reason, n: g.length, avgR: mean(g.map(R)), medianPeakR: median(peaks), giveBackR: gb.length ? mean(gb) : null, sumR: g.reduce((a, t) => a + R(t), 0) };
  }).sort((a, b) => b.n - a.n);
  let cum = 0, peak = 0; const curve = ts.map((t, i) => { cum += R(t); peak = Math.max(peak, cum); return { i: i + 1, t: t.exitAt, cumR: cum, ddR: cum - peak }; });
  const dailyBy = new Map<string, LearnTrade[]>();
  for (const t of ts) { const day = new Date(t.exitAt).toISOString().slice(0, 10); dailyBy.set(day, [...(dailyBy.get(day) ?? []), t]); }
  const daily = [...dailyBy].map(([day, g]) => ({ day, n: g.length, sumR: g.reduce((a, t) => a + R(t), 0) }));
  return {
    trades: ts.length, sumR: rs.reduce((a, x) => a + x, 0), avgR: mean(rs), lb90: b.lb, ub90: b.ub,
    winRatePct: ts.length ? wins.length / ts.length * 100 : 0, avgWinR: avgWin, avgLossR: avgLoss, breakevenWinPct: breakeven, costShare: costShare(ts),
    grossUsd: ts.reduce((a, t) => a + gross(t), 0), feesUsd: ts.reduce((a, t) => a + t.fees, 0), netUsd: ts.reduce((a, t) => a + t.pnl, 0),
    stops: { n: stops.length, neverMoved, firstBar, medianMinutes: median(stops.map(t => (t.exitAt - t.entryAt) / 60_000)) },
    exits,
    byScanner: group(ts, t => [t.scannerId, t.scannerName]),
    byPair: group(ts, t => [`${t.scannerId}|${t.symbol}|${t.tf}`, `${t.scannerName} · ${t.symbol} ${t.tf}`]),
    byTf: group(ts, t => [t.tf, t.tf]),
    curve, daily,
    holds: bucketize(ts, HOLD_LABELS, t => holdBucket(t.exitAt - t.entryAt)),
    hoursIst: bucketize(ts, Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')), t => new Date(t.entryAt + IST_OFFSET_MS).getUTCHours()),
  };
}
