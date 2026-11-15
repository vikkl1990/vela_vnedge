import type {Db} from '../db.ts';
import type {PaperEngine} from '../paper/engine.ts';
import {eligibleEvidence,type TradePolicy} from '../paper/tradePolicy.ts';
import {capacityExpansionCompatible} from './readinessCompatibility.ts';

/** Exact policy identity plus a narrow account-readiness exception for expanded
 * global slot counts. Copying, promotion and sizing still use qualifiedEvidence. */
export function currentPolicyEvidence(db:Db,paper:PaperEngine,book=0,since=0){
  const cache=new Map<string,TradePolicy>(),compatible=new Map<string,boolean>();
  const ids=new Set<number>(),exactIds=new Set<number>(),capacityCompatibleIds=new Set<number>();
  for(const r of db.all<{id:number;scannerId:string;symbol:string;tf:string;strategy:string;policyId:string}>(
    `SELECT p.id,p.scanner_id scannerId,p.symbol,p.tf,t.id policyId,t.strategy_id strategy FROM positions p
     JOIN trade_policies t ON t.id=p.policy_id WHERE p.bt=? AND p.status='closed' AND p.exit_at>=? AND ${eligibleEvidence}`,book,since)){
    const key=`${r.scannerId}|${r.symbol}|${r.tf}`;
    let policy=cache.get(key);if(!policy){policy=paper.policyForCell(r);cache.set(key,policy);}
    if((book===0?policy.id:policy.strategyId)===(book===0?r.policyId:r.strategy)){
      ids.add(r.id);exactIds.add(r.id);
    }else if(book===0&&policy.strategyId===r.strategy){
      const matchKey=`${r.policyId}|${policy.id}`;
      let match=compatible.get(matchKey);
      if(match===undefined){
        match=false;
        try{
          const row=db.get<{snapshot:string}>('SELECT snapshot FROM trade_policies WHERE id=?',r.policyId);
          if(row){const previous=JSON.parse(row.snapshot) as TradePolicy;
            match=previous.id===r.policyId&&previous.strategyId===r.strategy&&capacityExpansionCompatible(previous,policy);}
        }catch{/* Invalid policy snapshots remain excluded. */}
        compatible.set(matchKey,match);
      }
      if(match){ids.add(r.id);capacityCompatibleIds.add(r.id);}
    }
  }
  return {ids,exactIds,capacityCompatibleIds};
}
export function currentPolicyIds(db:Db,paper:PaperEngine,book=0,since=0){
  return currentPolicyEvidence(db,paper,book,since).ids;
}
export function policyHealth(db:Db,paper:PaperEngine,shadow:PaperEngine,now=Date.now()){
  const books=[paper,shadow].map(engine=>{
    const rows=db.all<{id:number;bound:number;adopted:number;known:number;quarantined:number}>(
      `SELECT p.id,p.policy_id IS NOT NULL bound,p.policy_adopted_at IS NOT NULL adopted,t.source_hash IS NOT NULL known,
       EXISTS(SELECT 1 FROM evidence_flags f WHERE f.position_id=p.id AND f.entry_at=p.entry_at AND f.status='quarantined') quarantined
       FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE p.bt=? AND p.status='closed' AND p.exit_at>=?`,engine.book,now-30*86400000);
    const {ids,capacityCompatibleIds}=currentPolicyEvidence(db,paper,engine.book,now-30*86400000);
    const count={matching:0,changed:0,legacy:0,quarantined:0};
    for(const r of rows)count[r.quarantined?'quarantined':!r.bound||r.adopted||!r.known?'legacy':ids.has(r.id)?'matching':'changed']++;
    const positions=[...engine.openPositions(),...engine.pendingEntries()];
    return {book:engine.book===0?'paper':'shadow',closed:rows.length,...count,capacityCompatible:capacityCompatibleIds.size,open:engine.openPositions().length,
      boundOpen:positions.filter(p=>!!p.policy).length,adoptedOpen:positions.filter(p=>!!p.policy?.adoptedAt).length,
      pending:engine.pendingEntries().length,reservedMargin:engine.pendingEntries().reduce((n,p)=>n+(p.reservation?.margin??0),0)};
  });
  return {at:now,windowDays:30,books,haltEvents:db.get<{n:number}>('SELECT COUNT(*) n FROM risk_halts WHERE at>=?',now-30*86400000)?.n??0,
    qualification:'Current source, scanner interpretation, execution, sizing and risk policy. Account readiness also accepts otherwise identical policies with stricter global position counts; promotion and leverage qualification are unchanged.',
    limitations:['Execution replay covers recorded inputs. Historical depth and order queues are not reconstructed.',
      'Compatible trades retain their actual returns and observed frequency. They do not establish performance at higher concurrency.',
      'Forward profitability and exchange lifecycle certification are still required before live activation.']};
}
