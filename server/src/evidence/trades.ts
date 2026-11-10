import type { Db } from '../db.ts';
import type { TradePolicy } from '../paper/tradePolicy.ts';
import type { TradeR } from '../incubator/gate.ts';

export interface EvidenceCell { scannerId: string; symbol: string; tf: string }
export interface EvidenceTrade extends TradeR { positionId: number }

// Only executed account/shadow outcomes qualify. Tracker membership is frozen at entry;
// moving a tracker to shadow must not turn its earlier observations into evidence.
export const eligibleEvidence = `p.policy_adopted_at IS NULL AND p.policy_id IS NOT NULL AND t.source_hash IS NOT NULL
  AND ((p.bt=0 AND p.evidence_scope='account') OR (p.bt=2 AND p.evidence_scope IN ('shadow','legacy-shadow')))
  AND p.scanner_id NOT LIKE 'plan:%'
  AND p.entry_at<=p.exit_at AND p.risk_amount>0 AND p.risk_amount<1e308
  AND abs(p.realized_pnl)<1e308 AND abs(p.fees)<1e308
  AND abs((p.realized_pnl-p.fees)/p.risk_amount)<1e308
  AND NOT EXISTS (SELECT 1 FROM evidence_flags f WHERE f.position_id=p.id AND f.entry_at=p.entry_at AND f.status='quarantined')`;

/** One qualification boundary for copying, promotion and leverage. Callers keep their
 * own thresholds, but cannot silently substitute raw history for compatible outcomes. */
export function qualifiedEvidence(db: Db, cell: EvidenceCell, policy: TradePolicy | undefined,
  { book = 2, at = Date.now(), limit }: { book?: number; at?: number; limit?: number } = {}): EvidenceTrade[] {
  if (!policy?.sourceHash || policy.adoptedAt != null || !Number.isFinite(at) || ![0, 2].includes(book)) return [];
  if (policy.scannerId !== cell.scannerId || policy.symbol !== cell.symbol || policy.tf !== cell.tf) return [];
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) return [];
  const atrOnly = policy.paper.skipScriptStops && policy.reading.entryProtection !== 'native';
  const rows = db.all<any>(`SELECT p.id,p.entry_at,p.exit_at,p.side,p.peak_r,(p.realized_pnl-p.fees)/p.risk_amount r
    FROM positions p JOIN trade_policies t ON t.id=p.policy_id
    WHERE p.bt=? AND p.status='closed' AND p.scanner_id=? AND p.symbol=? AND p.tf=?
    AND p.exit_at<=? AND t.strategy_id=? AND ${eligibleEvidence}
    ${atrOnly ? "AND p.levels_source='atr-fallback'" : ''}
    ORDER BY p.exit_at DESC,p.id DESC ${limit !== undefined ? 'LIMIT ?' : ''}`,
    book,cell.scannerId,cell.symbol,cell.tf,at,policy.strategyId,...(limit !== undefined ? [limit] : []));
  return rows.reverse().map(r => ({positionId:r.id,entryAt:r.entry_at,exitAt:r.exit_at,r:r.r,side:r.side,peakR:r.peak_r??undefined}));
}

export interface EvidenceCoverage { total:number; matching:number; changed:number; legacy:number; quarantined:number; excluded:number }
export function evidenceCoverage(db:Db,cell:EvidenceCell,book:number,policy:TradePolicy|string,at=Date.now()):EvidenceCoverage {
  const strategyId=typeof policy==='string'?policy:policy.strategyId;
  const atrOnly=typeof policy!=='string'&&policy.paper.skipScriptStops&&policy.reading.entryProtection!=='native';
  const rows=db.all<{strategy_id:string|null;source_hash:string|null;adopted:number|null;quarantined:number;eligible:number}>(
    `SELECT t.strategy_id,t.source_hash,p.policy_adopted_at adopted,
    EXISTS(SELECT 1 FROM evidence_flags f WHERE f.position_id=p.id AND f.entry_at=p.entry_at AND f.status='quarantined') quarantined,
    (${eligibleEvidence} ${atrOnly?"AND p.levels_source='atr-fallback'":''}) eligible
    FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id
    WHERE p.bt=? AND p.status='closed' AND p.risk_amount>0 AND p.scanner_id=? AND p.symbol=? AND p.tf=? AND p.exit_at<=?`,book,cell.scannerId,cell.symbol,cell.tf,at);
  const result:EvidenceCoverage={total:rows.length,matching:0,changed:0,legacy:0,quarantined:0,excluded:0};
  for(const r of rows)result[r.quarantined?'quarantined':!r.strategy_id||!r.source_hash||r.adopted!=null?'legacy':!r.eligible?'excluded':r.strategy_id===strategyId?'matching':'changed']++;
  return result;
}
