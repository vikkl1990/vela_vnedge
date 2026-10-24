/**
 * Decision 197: the early profit lock, measured on the trades the books actually took, every day, before it is switched
 * on. The lock (a stop raised to `keepR` once a trade has reached `atR`) can only close a trade earlier than it closed,
 * never later, so its result follows from each trade's recorded path: the trade as it was, until the lock would have
 * fired; the remaining size closed at the lock level from then on.
 *
 * It is a counterfactual on recorded minute samples, not a fill simulation. The assumptions travel with every report.
 */
import type { Db } from '../db.ts';
import type { PaperConfig } from '../config.ts';
import { feeFor, slip, type Fill } from '../paper/logic.ts';

export interface LockStudyRow {
  book: 'account' | 'shadow'; tf: string;
  trades: number; withPath: number; covered: number; armed: number; fired: number;
  baseR: number; lockR: number; deltaR: number;
  rescued: number; rescuedR: number; cutShort: number; cutShortR: number;
}
export interface LockStudy {
  at: number; since: number; atR: number; keepR: number;
  rows: LockStudyRow[];
  daily: Array<{ day: string; book: 'account' | 'shadow'; tf: string; trades: number; fired: number; deltaR: number }>;
  assumptions: string[];
}

const MAX_GAP_MS = 3 * 60_000;

export function lockStudy(db: Db, paper: PaperConfig, opts: { since: number; atR?: number; keepR?: number; now?: number }): LockStudy {
  const atR = opts.atR ?? 0.3, keepR = opts.keepR ?? 0.1;
  const trades = db.all<any>("SELECT id, bt, tf, side, qty, contract_value, entry_price, entry_at, exit_at, sl_original, realized_pnl, fees, risk_amount, peak_r, fills FROM positions WHERE status='closed' AND bt IN (0,2) AND risk_amount > 0 AND exit_at >= ? ORDER BY exit_at", opts.since);
  const pathQ = (id: number) => db.all<{ at: number; r: number }>('SELECT at, r FROM position_path WHERE position_id=? ORDER BY at', id);
  const rows = new Map<string, LockStudyRow>();
  const daily = new Map<string, { day: string; book: 'account' | 'shadow'; tf: string; trades: number; fired: number; deltaR: number }>();
  for (const t of trades) {
    const book: 'account' | 'shadow' = t.bt === 0 ? 'account' : 'shadow';
    const key = `${book}|${t.tf}`;
    const row = rows.get(key) ?? { book, tf: t.tf, trades: 0, withPath: 0, covered: 0, armed: 0, fired: 0, baseR: 0, lockR: 0, deltaR: 0, rescued: 0, rescuedR: 0, cutShort: 0, cutShortR: 0 };
    rows.set(key, row);
    const baseR = (t.realized_pnl - t.fees) / t.risk_amount;
    let lockR = baseR, fired = false;
    // only a trade that reached atR can have armed the lock; the others need no path
    const path = (t.peak_r ?? 0) >= atR ? pathQ(t.id) : [];
    if (path.length >= 2) {
      row.withPath++;
      let gap = path[0].at - t.entry_at;
      for (let i = 1; i < path.length; i++) gap = Math.max(gap, path[i].at - path[i - 1].at);
      if (gap <= MAX_GAP_MS) row.covered++;
      let armAt: number | null = null, fireAt: number | null = null;
      for (const p of path) {
        if (armAt === null) { if (p.r >= atR) armAt = p.at; continue; }
        if (p.at > armAt && p.r <= keepR) { fireAt = p.at; break; }   // raised from the next sample, never inside the arming one
      }
      if (armAt !== null) row.armed++;
      if (fireAt !== null) {
        fired = true;
        const dir = t.side === 'long' ? 1 : -1;
        const unit = Math.abs(t.entry_price - (t.sl_original ?? t.entry_price));
        const level = t.entry_price + dir * keepR * unit;
        // the trade as it was until the lock fires: its entry and any partial exits before then, with their own fees
        let fills: Fill[] = [];
        try { fills = (JSON.parse(t.fills ?? '{}').fills ?? []) as Fill[]; } catch { fills = []; }
        const before = fills.filter(f => f.at <= fireAt!);
        const exitedQty = before.filter(f => f.reason !== 'entry').reduce((a, f) => a + f.qty, 0);
        const realizedBefore = before.filter(f => f.reason !== 'entry').reduce((a, f) => a + (f.pnl ?? 0), 0);
        const feesBefore = before.reduce((a, f) => a + (f.fee ?? 0), 0);
        const rest = Math.max(0, t.qty - exitedQty);
        // the lock is a stop-market order: it fills at the level with the paper's taker slippage and pays the taker fee
        const notional = rest * t.contract_value * level;
        const fill = slip(level, dir === 1 ? 'sell' : 'buy', paper, notional);
        const pnl = (fill - t.entry_price) * dir * rest * t.contract_value;
        const exitFee = feeFor(fill, rest, t.contract_value, paper, false);
        lockR = (realizedBefore + pnl - feesBefore - exitFee) / t.risk_amount;
      }
    }
    row.trades++; row.baseR += baseR; row.lockR += lockR;
    if (fired) {
      row.fired++;
      if (lockR > baseR) { row.rescued++; row.rescuedR += lockR - baseR; } else { row.cutShort++; row.cutShortR += baseR - lockR; }
    }
    const day = new Date(t.exit_at).toISOString().slice(0, 10);
    const dk = `${day}|${key}`;
    const d = daily.get(dk) ?? { day, book, tf: t.tf, trades: 0, fired: 0, deltaR: 0 };
    d.trades++; if (fired) d.fired++; d.deltaR += lockR - baseR;
    daily.set(dk, d);
  }
  for (const r of rows.values()) r.deltaR = r.lockR - r.baseR;
  const order = (tf: string) => ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d'].indexOf(tf);
  return {
    at: opts.now ?? Date.now(), since: opts.since, atR, keepR,
    rows: [...rows.values()].sort((a, b) => a.book.localeCompare(b.book) || order(a.tf) - order(b.tf)),
    daily: [...daily.values()].sort((a, b) => b.day.localeCompare(a.day) || a.book.localeCompare(b.book) || order(a.tf) - order(b.tf)),
    assumptions: [
      `The lock arms on the first recorded sample at or above +${atR}R and fires on the first later sample at or below +${keepR}R; samples are about a minute apart, so a touch between samples is missed and a fire can be late.`,
      `A fired lock closes the size still open at the +${keepR}R level as a stop-market order: the paper's taker slippage (${paper.slippageBps} bps plus depth impact) and taker fee (${paper.feeRatePct}% plus ${paper.feeTaxPct ?? 0}% tax). The live spread at that moment is not known and not added.`,
      'Fills before the lock fires (the entry and any partial exits) keep their recorded prices and fees; funding is not counted for either result.',
      'A trade that never reached the arming level, or whose path has under two samples, keeps its actual result. Coverage counts paths with no gap over three minutes.',
      'The lock never closes a trade later than it closed, so the comparison needs no exits the books did not take; it does not model the capital or the entries an earlier close would have freed.',
    ],
  };
}
