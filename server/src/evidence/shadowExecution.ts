/** Recorded shadow outcomes can cross an execution version only through a full
 * covered-cohort replay. No historical fills, policies or returns are rewritten. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {Db} from '../db.ts';
import {stablePolicy,type TradePolicy} from '../paper/tradePolicy.ts';
import {strategyIdFor} from '../paper/strategyIdentity.ts';
import {validReadinessPolicy} from '../analytics/readinessCompatibility.ts';
import {requireReadinessMaintenance} from '../analytics/readinessReplayImport.ts';
import {replayExecution,executionReplaySubject,executionSubjectHash,validIdenticalExecution,
 type ExecutionReplayResult,type ExecutionReplayEvent,type ExecutionReplayCoverage} from '../analytics/readinessExecutionReplay.ts';

export interface ShadowExecutionCohort {
 version:1; from:number; to:number; policy:TradePolicy; results:ExecutionReplayResult[];
}
export const shadowReplayDigest=(v:unknown)=>createHash('sha256').update(stablePolicy(v)).digest('hex');
export function previousShadowStrategy(current:TradePolicy):string {
 return strategyIdFor({...current,sim:211});
}
/** Exactly the existing cross-book strategy boundary, plus a proved 211 -> 212
 * execution transition. No readiness-only sizing/capacity exceptions. */
export function shadowExecutionCompatible(previous:TradePolicy,current:TradePolicy):boolean {
 return validReadinessPolicy(previous)&&validReadinessPolicy(current)&&previous.sim===211&&current.sim===212&&
  previous.strategyId===previousShadowStrategy(current);
}
export function replayShadowExecution(db:Db,id:number,previous:TradePolicy,current:TradePolicy,events:ExecutionReplayEvent[],coverage:ExecutionReplayCoverage) {
 return replayExecution(db,id,previous,current,events,coverage,2,shadowExecutionCompatible(previous,current));
}

/** Window is fixed from archive coverage before reading outcomes. Include every
 * qualifying-scope trade in it, even quarantined/invalid ones: those must block a
 * cohort, not disappear and leave a flattering subset of wins. */
export function shadowCohortMembers(db:Db,policy:TradePolicy,from:number,to:number):number[] {
 const atrOnly=policy.paper.skipScriptStops&&policy.reading.entryProtection!=='native';
 return db.all<{id:number}>(`SELECT p.id FROM positions p JOIN trade_policies t ON t.id=p.policy_id
  WHERE p.bt=2 AND p.status='closed' AND p.scanner_id=? AND p.symbol=? AND p.tf=?
  AND p.scanner_id NOT LIKE 'plan:%' AND p.evidence_scope IN ('shadow','legacy-shadow')
  AND p.policy_adopted_at IS NULL AND t.strategy_id=? AND p.entry_at>=? AND p.exit_at<=?
  ${atrOnly?"AND p.levels_source='atr-fallback'":''} ORDER BY p.id`,
  policy.scannerId,policy.symbol,policy.tf,previousShadowStrategy(policy),from,to).map(r=>r.id);
}

export function validateShadowCohort(db:Db,cohort:ShadowExecutionCohort,current:TradePolicy,at=Date.now()):number[] {
 try {
  if(cohort.version!==1||!validReadinessPolicy(current)||!validReadinessPolicy(cohort.policy)||current.sim!==212||
   cohort.policy.sim!==212||cohort.policy.strategyId!==current.strategyId||!Number.isFinite(cohort.from)||
   !Number.isFinite(cohort.to)||cohort.from>=cohort.to||cohort.to>at||!Array.isArray(cohort.results))return [];
  const members=shadowCohortMembers(db,current,cohort.from,cohort.to);
  if(!members.length||members.length!==cohort.results.length)return [];
  const results=new Map(cohort.results.map(r=>[r.positionId,r]));
  if(results.size!==members.length)return [];
  for(const id of members){
   const proof=results.get(id);if(!proof)return [];
   const subject=executionReplaySubject(db,id),r=subject.position;
   const saved=db.get<{snapshot:string}>('SELECT snapshot FROM trade_policies WHERE id=?',r.policy_id);
   if(!saved)return [];
   const previous=JSON.parse(saved.snapshot) as TradePolicy;
   if(!shadowExecutionCompatible(previous,current)||proof.version!==2||proof.previousId!==previous.id||
    proof.currentId!==cohort.policy.id||proof.entryAt!==r.entry_at||proof.ledgerHash!==executionSubjectHash(subject)||
    !/^[a-f0-9]{64}$/.test(proof.inputHash)||!validIdenticalExecution(proof,subject)||
    r.entry_at>r.exit_at||!(r.risk_amount>0)||!Number.isFinite((r.realized_pnl-r.fees)/r.risk_amount)||
    db.get("SELECT 1 FROM evidence_flags WHERE position_id=? AND entry_at=? AND status='quarantined'",id,r.entry_at))return [];
  }
  return members;
 }catch{return [];}
}

/** Called by the shared copying/promotion/sizing boundary. Forward-restoration
 * requirements still apply after these IDs are joined to ordinary exact history. */
export function shadowExecutionEvidence(db:Db,current:TradePolicy,at=Date.now()):Set<number> {
 const row=db.get<{proof:string}>('SELECT proof FROM shadow_execution_cohorts WHERE strategy_id=?',current.strategyId);
 if(!row)return new Set();
 try{return new Set(validateShadowCohort(db,JSON.parse(row.proof),current,at));}catch{return new Set();}
}

/** Offline, atomic import of reviewed whole cohorts; no ledger/config mutations. */
export function importShadowCohorts(db:Db,cohorts:ShadowExecutionCohort[],expectedHash:string,assertStopped=requireReadinessMaintenance,at=Date.now()) {
 assertStopped();assert.equal(shadowReplayDigest(cohorts),expectedHash,'reviewed cohort checksum mismatch');
 let trades=0;const seen=new Set<string>();
 db.transaction(()=>{
  assertStopped();
  for(const c of cohorts){
   assert.ok(!seen.has(c.policy.strategyId),'duplicate shadow cohort');seen.add(c.policy.strategyId);
   const ids=validateShadowCohort(db,c,c.policy,at);
   assert.ok(ids.length>0,'incomplete or incompatible shadow cohort');
   // Never replace a complete window with an outcome-selected smaller window.
   const old=db.get<{proof:string}>('SELECT proof FROM shadow_execution_cohorts WHERE strategy_id=?',c.policy.strategyId);
   if(old){const previous=JSON.parse(old.proof) as ShadowExecutionCohort;
    assert.ok(c.from<=previous.from&&c.to>=previous.to,'shadow cohort window cannot shrink');}
   db.run('INSERT INTO shadow_execution_cohorts VALUES(?,?,?) ON CONFLICT(strategy_id) DO UPDATE SET recorded_at=excluded.recorded_at,proof=excluded.proof',c.policy.strategyId,at,JSON.stringify(c));trades+=ids.length;
  }
 });
 return {cohorts:cohorts.length,trades};
}
