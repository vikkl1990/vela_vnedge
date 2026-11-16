import type {Db} from '../db.ts';
import type {PaperEngine} from '../paper/engine.ts';
import {eligibleEvidence,type TradePolicy} from '../paper/tradePolicy.ts';
import {capacityExpansionCompatible,additionalReadinessCompatibility,validReadinessPolicy} from './readinessCompatibility.ts';
import {proveSameReadinessSize} from './readinessSizing.ts';

/** Exact policy identity plus verified account-readiness compatibility. Stored
 * policies are immutable; copying, promotion and sizing use qualifiedEvidence. */
export function currentPolicyEvidence(db:Db,paper:PaperEngine,book=0,since=0){
  const cache=new Map<string,TradePolicy>(),saved=new Map<string,TradePolicy|null>();
  const compatible=new Map<string,'capacity'|'scope'|'sizing-proof'|null>();
  const ids=new Set<number>(),exactIds=new Set<number>(),capacityCompatibleIds=new Set<number>();
  const scopeCompatibleIds=new Set<number>(),sizingCompatibleIds=new Set<number>(),excludedReasons=new Map<number,string>();
  for(const r of db.all<{id:number;scannerId:string;symbol:string;tf:string;strategy:string;policyId:string}>(
    `SELECT p.id,p.scanner_id scannerId,p.symbol,p.tf,t.id policyId,t.strategy_id strategy FROM positions p
     JOIN trade_policies t ON t.id=p.policy_id WHERE p.bt=? AND p.status='closed' AND p.exit_at>=? AND ${eligibleEvidence}`,book,since)){
    const key=`${r.scannerId}|${r.symbol}|${r.tf}`;
    let policy=cache.get(key);if(!policy){policy=paper.policyForCell(r);cache.set(key,policy);}
    if((book===0?policy.id:policy.strategyId)===(book===0?r.policyId:r.strategy)){
      ids.add(r.id);exactIds.add(r.id);
    }else if(book===0){
      const matchKey=`${r.policyId}|${policy.id}`;
      let previous=saved.get(r.policyId);
      if(previous===undefined){
        previous=null;
        try{const row=db.get<{snapshot:string}>('SELECT snapshot FROM trade_policies WHERE id=?',r.policyId);
          if(row){const p=JSON.parse(row.snapshot) as TradePolicy;if(p.id===r.policyId&&p.strategyId===r.strategy&&validReadinessPolicy(p))previous=p;}
        }catch{/* Corrupt or unsupported snapshots fail closed. */}
        saved.set(r.policyId,previous);
      }
      if(!previous){excludedReasons.set(r.id,'invalid-policy');continue;}
      if(previous.sim!==policy.sim){excludedReasons.set(r.id,'execution-version');continue;}
      let match=compatible.get(matchKey);
      if(match===undefined){
        match=capacityExpansionCompatible(previous,policy)?'capacity':additionalReadinessCompatibility(previous,policy);
        compatible.set(matchKey,match);
      }
      if(match==='capacity'){ids.add(r.id);capacityCompatibleIds.add(r.id);}
      else if(match==='scope'){ids.add(r.id);scopeCompatibleIds.add(r.id);}
      else if(match==='sizing-proof'){
        const proof=proveSameReadinessSize(db,r.id,previous,policy);
        if(proof.ok){ids.add(r.id);sizingCompatibleIds.add(r.id);}else excludedReasons.set(r.id,proof.reason);
      }else excludedReasons.set(r.id,'policy-changed');
    }
  }
  return {ids,exactIds,capacityCompatibleIds,scopeCompatibleIds,sizingCompatibleIds,excludedReasons};
}
export function currentPolicyIds(db:Db,paper:PaperEngine,book=0,since=0){
  return currentPolicyEvidence(db,paper,book,since).ids;
}
export function policyHealth(db:Db,paper:PaperEngine,shadow:PaperEngine,now=Date.now()){
  const books=[paper,shadow].map(engine=>{
    const rows=db.all<{id:number;bound:number;adopted:number;known:number;quarantined:number;eligible:number}>(
      `SELECT p.id,p.policy_id IS NOT NULL bound,p.policy_adopted_at IS NOT NULL adopted,t.source_hash IS NOT NULL known,
       (${eligibleEvidence}) eligible,
       EXISTS(SELECT 1 FROM evidence_flags f WHERE f.position_id=p.id AND f.entry_at=p.entry_at AND f.status='quarantined') quarantined
       FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE p.bt=? AND p.status='closed' AND p.exit_at>=?`,engine.book,now-30*86400000);
    const {ids,capacityCompatibleIds,scopeCompatibleIds,sizingCompatibleIds,excludedReasons}=currentPolicyEvidence(db,paper,engine.book,now-30*86400000);
    const count={matching:0,changed:0,legacy:0,quarantined:0};
    for(const r of rows)count[r.quarantined?'quarantined':!r.bound||r.adopted||!r.known?'legacy':ids.has(r.id)?'matching':'changed']++;
    const excluded=new Map<string,number>();
    for(const r of rows){
      if(ids.has(r.id))continue;
      const key=r.quarantined?'quarantined':!r.bound?'missing-policy':r.adopted?'adopted-policy':!r.known?'unknown-source':!r.eligible?'ineligible-outcome':excludedReasons.get(r.id)??'policy-changed';
      excluded.set(key,(excluded.get(key)??0)+1);
    }
    const totalClosed=db.get<{n:number}>("SELECT COUNT(*) n FROM positions WHERE bt=? AND status='closed'",engine.book)?.n??0;
    const positions=[...engine.openPositions(),...engine.pendingEntries()];
    return {book:engine.book===0?'paper':'shadow',closed:rows.length,totalClosed,outsideWindow:totalClosed-rows.length,...count,
      exclusions:[...excluded].map(([reason,trades])=>({reason,trades,label:EXCLUSION_LABELS[reason]??reason})),
      capacityCompatible:capacityCompatibleIds.size,scopeCompatible:scopeCompatibleIds.size,sizingCompatible:sizingCompatibleIds.size,open:engine.openPositions().length,
      boundOpen:positions.filter(p=>!!p.policy).length,adoptedOpen:positions.filter(p=>!!p.policy?.adoptedAt).length,
      pending:engine.pendingEntries().length,reservedMargin:engine.pendingEntries().reduce((n,p)=>n+(p.reservation?.margin??0),0)};
  });
  return {at:now,windowDays:30,books,haltEvents:db.get<{n:number}>('SELECT COUNT(*) n FROM risk_halts WHERE at>=?',now-30*86400000)?.n??0,
    qualification:'Current source, scanner interpretation, execution, fees and risk caps. Readiness can retain expanded count limits, unrelated-cell maker settings, and recorded entries whose quantity and stop risk replay identically after removal of drawdown sizing. Promotion and leverage qualification are unchanged.',
    limitations:['Execution replay covers recorded inputs. Historical depth and order queues are not reconstructed.',
      'Compatible trades retain their actual returns and observed frequency. They do not establish performance at higher concurrency.',
      'Forward profitability and exchange lifecycle certification are still required before live activation.']};
}

const EXCLUSION_LABELS:Record<string,string>={
  'missing-policy':'No bound execution policy', 'adopted-policy':'Original policy unknown at adoption',
  'unknown-source':'Source version unknown','quarantined':'Quarantined trade','ineligible-outcome':'Excluded scope or invalid outcome',
  'execution-version':'Different execution model','invalid-policy':'Missing or invalid policy snapshot',
  'different-size':'Recorded size not proven equivalent to current sizing','missing-sizing-proof':'Insufficient entry evidence to prove unchanged sizing',
  'policy-changed':'Other source, reader, fee or policy differences',
};
