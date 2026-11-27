import {shadowExecutionEvidence} from './shadowExecution.ts';
import {restorationAssessment} from './restoration.ts';
import {fullFeeCompatible,paidFullCommissions} from './compatibility.ts';
import type { Db } from '../db.ts';
import type { TradePolicy } from '../paper/tradePolicy.ts';
import type { TradeR } from '../incubator/gate.ts';

export interface EvidenceCell { scannerId: string; symbol: string; tf: string }
export interface EvidenceTrade extends TradeR { positionId: number; basis?:'exact'|'full-fee'|'execution-replay' }

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
export function readEvidence(db: Db, cell: EvidenceCell, policy: TradePolicy | undefined,
  { book = 2, at = Date.now(), limit, compatibility = 'exact' }: { book?: number; at?: number; limit?: number; compatibility?:'exact'|'full-fee' } = {}): EvidenceTrade[] {
  if (!policy?.sourceHash || policy.adoptedAt != null || !Number.isFinite(at) || ![0, 2].includes(book)) return [];
  if (policy.scannerId !== cell.scannerId || policy.symbol !== cell.symbol || policy.tf !== cell.tf) return [];
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) return [];
  const atrOnly = policy.paper.skipScriptStops && policy.reading.entryProtection !== 'native';
  const conservative=compatibility==='full-fee';
  const replayIds=book===2?shadowExecutionEvidence(db,policy,at):new Set<number>();
  const filterAfter=conservative||replayIds.size>0;
  const rows = db.all<any>(`SELECT ${filterAfter?'p.*,t.strategy_id,t.snapshot,':''}p.id,p.entry_at,p.exit_at,p.side,p.peak_r,(p.realized_pnl-p.fees)/p.risk_amount r
    FROM positions p JOIN trade_policies t ON t.id=p.policy_id
    WHERE p.bt=? AND p.status='closed' AND p.scanner_id=? AND p.symbol=? AND p.tf=?
    AND p.exit_at<=? ${conservative?'':replayIds.size?`AND (t.strategy_id=? OR p.id IN (${[...replayIds].map(()=>'?').join(',')}))`:'AND t.strategy_id=?'} AND ${eligibleEvidence}
    ${atrOnly ? "AND p.levels_source='atr-fallback'" : ''}
    ORDER BY p.exit_at DESC,p.id DESC ${limit !== undefined && !filterAfter ? 'LIMIT ?' : ''}`,
    book,cell.scannerId,cell.symbol,cell.tf,at,...(conservative?[]:[policy.strategyId,...replayIds]),...(limit !== undefined&&!filterAfter ? [limit] : []));
  const policies=new Map<string,{policy:TradePolicy;compatible:boolean}>();
  const selected=filterAfter?rows.filter(r=>{
    if(r.strategy_id===policy.strategyId){r.basis='exact';return true;}
    if(replayIds.has(r.id)){r.basis='execution-replay';return true;}
    if(!conservative)return false;
    try{
      let candidate=policies.get(r.policy_id);
      if(!candidate){const p=JSON.parse(r.snapshot) as TradePolicy;candidate={policy:p,compatible:fullFeeCompatible(p,policy,at)};policies.set(r.policy_id,candidate);}
      if(candidate.compatible&&paidFullCommissions(r,candidate.policy)){r.basis='full-fee';return true;}
    }catch{/* Invalid provenance cannot establish compatible evidence. */}
    return false;
  }).slice(0,limit):rows;
  return selected.reverse().map(r => ({positionId:r.id,entryAt:r.entry_at,exitAt:r.exit_at,r:r.r,side:r.side,peakR:r.peak_r??undefined,...(filterAfter?{basis:r.basis}:{})}));
}

/** Runtime boundary: compatible history is research-only until its enrolled forward test passes.
 * Audit/replay uses readEvidence explicitly and cannot alter this runtime boundary. */
export function qualifiedEvidence(db:Db,cell:EvidenceCell,policy:TradePolicy|undefined,
  options:{book?:number;at?:number;limit?:number}={}) : EvidenceTrade[] {
  return assessQualifiedEvidence(db,cell,policy,options).qualified;
}

/** One fresh assessment, shared by read-only explanations that also need the
 * restoration and available sample. No result is cached across decisions. */
export function assessQualifiedEvidence(db:Db,cell:EvidenceCell,policy:TradePolicy|undefined,
  options:{book?:number;at?:number;limit?:number}={}) {
  const at=options.at??Date.now(),book=options.book??2;
  if(!policy || book!==2){const exact=readEvidence(db,cell,policy,options);return {exact,assessment:null,qualified:exact};}
  const exact=readEvidence(db,cell,policy,{book,at});
  const assessment=restorationAssessment(db,cell,policy,exact,at);
  if(assessment&&!assessment.passed)return {exact,assessment,qualified:[] as EvidenceTrade[]};
  // Exact evidence was fully validated above, synchronously. Reading it again
  // repeats complete-cohort replay validation without adding any new evidence.
  if(!assessment?.passed){
    const limit=options.limit;
    return {exact,assessment,qualified:limit===undefined?exact:Number.isInteger(limit)&&limit>0?exact.slice(-limit):[]};
  }
  return {exact,assessment,qualified:readEvidence(db,cell,policy,{...options,at,compatibility:'full-fee'})};
}

export interface EvidenceCoverage { total:number; matching:number; changed:number; legacy:number; quarantined:number; excluded:number }
export function evidenceCoverage(db:Db,cell:EvidenceCell,book:number,policy:TradePolicy|string,at=Date.now()):EvidenceCoverage {
  const strategyId=typeof policy==='string'?policy:policy.strategyId;
  const atrOnly=typeof policy!=='string'&&policy.paper.skipScriptStops&&policy.reading.entryProtection!=='native';
  const replayIds=book===2&&typeof policy!=='string'?shadowExecutionEvidence(db,policy,at):new Set<number>();
  const rows=db.all<{id:number;strategy_id:string|null;source_hash:string|null;adopted:number|null;quarantined:number;eligible:number}>(
    `SELECT p.id,t.strategy_id,t.source_hash,p.policy_adopted_at adopted,
    EXISTS(SELECT 1 FROM evidence_flags f WHERE f.position_id=p.id AND f.entry_at=p.entry_at AND f.status='quarantined') quarantined,
    (${eligibleEvidence} ${atrOnly?"AND p.levels_source='atr-fallback'":''}) eligible
    FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id
    WHERE p.bt=? AND p.status='closed' AND p.risk_amount>0 AND p.scanner_id=? AND p.symbol=? AND p.tf=? AND p.exit_at<=?`,book,cell.scannerId,cell.symbol,cell.tf,at);
  const result:EvidenceCoverage={total:rows.length,matching:0,changed:0,legacy:0,quarantined:0,excluded:0};
  for(const r of rows)result[r.quarantined?'quarantined':!r.strategy_id||!r.source_hash||r.adopted!=null?'legacy':!r.eligible?'excluded':r.strategy_id===strategyId||replayIds.has(r.id)?'matching':'changed']++;
  return result;
}
