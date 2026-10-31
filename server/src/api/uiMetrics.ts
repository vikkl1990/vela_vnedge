import type { Db } from '../db.ts';
import type { PaperConfig } from '../config.ts';

/** Full journal aggregates, independent of feed pagination. */
export function signalActivity(db: Db, now = Date.now()) {
  const since = now - 86_400_000;
  const entries = db.get<{n:number}>("SELECT count(*) n FROM signals WHERE kind='entry' AND at>=? AND at<=?", since, now)?.n ?? 0;
  return { at: now, since, entries };
}
export function filledEntries(db: Db, book: number, since: number, now = Date.now()) {
  return db.get<{n:number}>("SELECT count(*) n FROM positions WHERE bt=? AND status IN ('open','closed') AND qty>0 AND entry_at>=? AND entry_at<=?", book, since, now)?.n ?? 0;
}
export function proposalTimes(db: Db): Map<number, number> {
  return new Map(db.all<{pair_id:number;at:number}>(`SELECT e.pair_id, max(e.at) at FROM incubator_events e
    JOIN incubator_pairs p ON p.id=e.pair_id AND p.stage=e.to_stage
    WHERE p.stage IN ('proposed','demote_proposed') AND (e.from_stage IS NULL OR e.from_stage<>e.to_stage)
    GROUP BY e.pair_id`).map(r=>[r.pair_id,r.at]));
}
export function sizingDescription(p: PaperConfig) {
  const cap = (p.maxStopLossPct ?? 0) > 0 ? `modeled stop-risk cap ${p.maxStopLossPct}% of equity` : 'no configured stop-risk cap';
  const basis = p.sizingMode === 'margin'
    ? `$${p.marginPerTrade} margin budget · leverage ${p.marginLeverage?.base ?? 5}× base / ${p.marginLeverage?.strong ?? 5}× strong / ${p.marginLeverage?.weak ?? 5}× weak`
    : p.sizingMode === 'quality' ? 'Quality sizing · equity × score-based leverage' : `Risk sizing · ${p.riskPerTradePct}% of equity at the modeled stop`;
  return `${basis} · ${cap} · leverage ceiling ${p.maxLeverage}× or the market's own`;
}
