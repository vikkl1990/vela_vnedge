/**
 * The daily report (decision 136): one row per UTC day, computed straight from the books and the incubator's
 * event log, so any past day is available at once and today reads as it happens. Nothing is stored.
 *
 * Trades count on the day they closed. R is net of fees over the risk taken. "Trail keeps" is the share of the
 * peak a trail exit banked, the number decision 124 moved.
 */
import type { Db } from '../db.ts';

const DAY = 86_400_000;
export interface BookDay {
  trades: number; net: number; fees: number; sumR: number; avgR: number; wins: number; stops: number; trails: number;
  /** Mean of (R kept ÷ peak R) over trail exits, null when none. */
  trailKeeps: number | null;
  byTf: Record<string, { trades: number; sumR: number }>;
  best: { scanner: string; sumR: number } | null; worst: { scanner: string; sumR: number } | null;
  /** Decision 138: the same trades re-scored under margin sizing, at the same average risk, in units of today's R. */
  marginSumR: number;
}
export interface IncubatorDay { admitted: number; proposed: number; promoted: number; retired: number; demoted: number }
export interface DailyRow { day: string; partial: boolean; account: BookDay; shadow: BookDay; incubator: IncubatorDay; equity: number }

/**
 * Decision 138's weight: under a fixed margin per trade the dollar risk is margin × leverage × stop distance. 0.3765 is
 * the shadow book's average leverage × stop on 19 October, so the weights average 1 and the comparison is at equal risk;
 * capped at 0.25×–2× as the sizing mode would be (the 2% stop cap).
 */
const MARGIN_NORM = 0.3765;
function marginWeight(x: { ep: number; sl: number | null; fills: string | null }): number {
  let lev = 0; try { const f = x.fills ? JSON.parse(x.fills) : {}; lev = f.marginLeverage || f.leverage || 0; } catch { /* no leverage recorded */ }
  const stop = x.sl && x.ep ? Math.abs(x.ep - x.sl) / x.ep : 0;
  if (!(lev > 0 && stop > 0)) return 1;
  return Math.max(0.25, Math.min(2, lev * stop / MARGIN_NORM));
}

function book(db: Db, bt: number, from: number, to: number): BookDay {
  const rows = db.all<{ scanner_name: string; tf: string; exit_reason: string; pnl: number; fees: number; risk: number; peak: number | null; ep: number; sl: number | null; fills: string | null }>(
    'SELECT scanner_name, tf, exit_reason, realized_pnl pnl, fees, risk_amount risk, peak_r peak, entry_price ep, sl_original sl, fills FROM positions p WHERE p.scanner_id NOT LIKE \'plan:%\' AND bt=? AND status=\'closed\' AND exit_at>=? AND exit_at<? AND (p.bt=0 OR NOT EXISTS (SELECT 1 FROM incubator_pairs i WHERE i.stage=\'tracked\' AND i.scanner_id=p.scanner_id AND i.symbol=p.symbol AND i.tf=p.tf))', bt, from, to);   // decision 139: tracker cells are not the shadow book's evidence
  const r = (x: typeof rows[number]) => (x.risk > 0 ? (x.pnl - x.fees) / x.risk : 0);
  const trails = rows.filter(x => x.exit_reason === 'trail' && x.risk > 0 && (x.peak ?? 0) > 0);
  const byTf: BookDay['byTf'] = {}; const byScanner = new Map<string, number>();
  for (const x of rows) { const t = (byTf[x.tf] ??= { trades: 0, sumR: 0 }); t.trades++; t.sumR += r(x); byScanner.set(x.scanner_name, (byScanner.get(x.scanner_name) ?? 0) + r(x)); }
  const ranked = [...byScanner].sort((a, b) => b[1] - a[1]);
  const sumR = rows.reduce((a, x) => a + r(x), 0);
  const marginSumR = rows.reduce((a, x) => a + r(x) * marginWeight(x), 0);
  return {
    trades: rows.length, net: rows.reduce((a, x) => a + x.pnl - x.fees, 0), fees: rows.reduce((a, x) => a + x.fees, 0),
    sumR, avgR: rows.length ? sumR / rows.length : 0, wins: rows.filter(x => x.pnl - x.fees > 0).length,
    stops: rows.filter(x => x.exit_reason === 'sl').length, trails: trails.length,
    trailKeeps: trails.length ? trails.reduce((a, x) => a + r(x) / (x.peak as number), 0) / trails.length : null,
    marginSumR, byTf, best: ranked.length ? { scanner: ranked[0][0], sumR: ranked[0][1] } : null,
    worst: ranked.length ? { scanner: ranked.at(-1)![0], sumR: ranked.at(-1)![1] } : null,
  };
}

function incubator(db: Db, from: number, to: number): IncubatorDay {
  const ev = db.all<{ from_stage: string | null; to_stage: string; actor: string }>('SELECT from_stage, to_stage, actor FROM incubator_events WHERE at>=? AND at<?', from, to);
  return {
    admitted: ev.filter(e => e.to_stage === 'shadow' && e.actor === 'screen').length,
    proposed: ev.filter(e => e.to_stage === 'proposed').length,
    promoted: ev.filter(e => e.to_stage === 'live').length,
    retired: ev.filter(e => e.to_stage === 'retired' && e.from_stage !== 'candidate').length,
    demoted: ev.filter(e => e.from_stage === 'live' && (e.to_stage === 'shadow' || e.to_stage === 'demote_proposed')).length,
  };
}

/** The last `days` UTC days, newest first; today is included and marked partial. */
export function dailyReport(db: Db, initialEquity: number, days = 30, now = Date.now()): DailyRow[] {
  const today = Math.floor(now / DAY) * DAY; const out: DailyRow[] = [];
  for (let i = 0; i < days; i++) {
    const from = today - i * DAY, to = from + DAY;
    const before = db.get<{ net: number | null }>('SELECT SUM(realized_pnl - fees) net FROM positions WHERE bt=0 AND status=\'closed\' AND exit_at<?', Math.min(to, now))?.net ?? 0;
    out.push({ day: new Date(from).toISOString().slice(0, 10), partial: i === 0, account: book(db, 0, from, to), shadow: book(db, 2, from, to), incubator: incubator(db, from, to), equity: initialEquity + before });
  }
  return out;
}

/** The text of one day's report, for the daily Telegram message. */
export function dailyText(rows: DailyRow[]): string {
  const d = rows.find(r => !r.partial) ?? rows[0]; if (!d) return 'VN EDGE: no data';
  const week = rows.filter(r => !r.partial).slice(0, 7);
  const sum = (f: (r: DailyRow) => number) => week.reduce((a, r) => a + f(r), 0);
  const wTrades = sum(r => r.account.trades), wR = sum(r => r.account.sumR), sTrades = sum(r => r.shadow.trades), sR = sum(r => r.shadow.sumR);
  const sign = (x: number, p = 2) => (x >= 0 ? '+' : '') + x.toFixed(p);
  const a = d.account, s = d.shadow, inc = d.incubator;
  return [
    `📊 VN EDGE daily report ${d.day} (UTC)`,
    `Account: ${a.trades} trades, net ${sign(a.net)} (fees ${a.fees.toFixed(2)}), ${sign(a.avgR, 3)}R a trade, ${a.stops} stopped, ${a.trails} trailed${a.trailKeeps !== null ? `, trail kept ${Math.round(a.trailKeeps * 100)}% of the peak` : ''}. Equity ${d.equity.toFixed(2)}.`,
    `Shadow: ${s.trades} trades, ${sign(s.avgR, 3)}R a trade, sum ${sign(s.sumR, 1)}R · ${Object.entries(s.byTf).map(([tf, v]) => `${tf} ${sign(v.sumR, 1)}R/${v.trades}`).join(' · ')}`,
    `Incubator: ${inc.admitted} admitted, ${inc.proposed} proposed, ${inc.promoted} promoted, ${inc.retired} retired, ${inc.demoted} demoted.`,
    `Last 7 days: account ${wTrades} trades ${sign(wTrades ? wR / wTrades : 0, 3)}R a trade (sum ${sign(wR, 1)}R); shadow ${sTrades} trades ${sign(sTrades ? sR / sTrades : 0, 3)}R a trade.`,
    a.best ? `Best account scanner ${a.best.scanner} ${sign(a.best.sumR, 1)}R; worst ${a.worst!.scanner} ${sign(a.worst!.sumR, 1)}R.` : '',
  ].filter(Boolean).join('\n');
}
