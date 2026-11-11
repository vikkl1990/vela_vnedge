import type { Db } from '../db.ts';
import type { PaperConfig } from '../config.ts';

/** Full journal aggregates, independent of feed pagination. */
export function signalActivity(db: Db, now = Date.now()) {
  const since = now - 86_400_000;
  const entries = db.get<{n:number}>("SELECT count(*) n FROM signals WHERE kind='entry' AND at>=? AND at<=?", since, now)?.n ?? 0;
  // Copy holds never enter the account journal. Counting only that journal made a
  // stricter evidence boundary look like scanners had stopped finding signals.
  // Count each event once across sources/stages and prefer its received receipt.
  const held = db.all<{reason:string;n:number}>(`WITH candidates AS (
    SELECT g.scanner_id,g.symbol,g.tf,g.bar_time,g.side,json_extract(g.snapshot,'$.event.label') label,
      CASE WHEN g.reason LIKE 'restored cell in forward shadow evaluation:%' THEN 'Forward evaluation'
        WHEN g.reason LIKE 'mirror held:%shadow closes' THEN 'Insufficient matching closes'
        WHEN g.reason LIKE 'mirror held:%' THEN 'Non-positive matching evidence'
        WHEN g.reason LIKE 'thin market:%' THEN 'Turnover below copy floor'
        ELSE 'Other copy hold' END reason
    FROM gated_signals g WHERE g.book=0 AND g.stage='copy' AND g.at>=? AND g.at<=?
      AND NOT EXISTS (SELECT 1 FROM signals s WHERE s.kind='entry' AND s.at>=? AND s.at<=?
        AND s.scanner_id=g.scanner_id AND s.symbol=g.symbol AND s.tf=g.tf
        AND s.bar_time=g.bar_time AND s.side IS g.side AND s.label IS json_extract(g.snapshot,'$.event.label'))
    GROUP BY g.scanner_id,g.symbol,g.tf,g.bar_time,g.side,label
  ) SELECT reason,count(*) n FROM candidates GROUP BY reason ORDER BY n DESC`,since,now,since,now);
  const copyHeld=held.reduce((n,r)=>n+r.n,0);
  const recordedSince=db.get<{at:number|null}>("SELECT min(at) at FROM gated_signals WHERE book=0 AND stage='copy' AND at<=?",now)?.at??null;
  return { at: now, since, entries, candidates:entries+copyHeld, copyHeld, held,
    copyRecordedSince:recordedSince,
    paperFilled:filledEntries(db,0,since,now),
    shadowFilled:db.get<{n:number}>(`SELECT count(*) n FROM positions WHERE bt=2
      AND evidence_scope IN ('shadow','legacy-shadow') AND status IN ('open','closed')
      AND qty>0 AND entry_at>=? AND entry_at<=?`,since,now)?.n??0 };
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
