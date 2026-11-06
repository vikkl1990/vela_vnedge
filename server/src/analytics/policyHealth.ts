import type {Db} from '../db.ts';
import type {PaperEngine} from '../paper/engine.ts';
import {eligibleEvidence} from '../paper/tradePolicy.ts';

/** Qualification uses the same policy identity as sizing. Historical P&L stays intact. */
export function currentPolicyIds(db:Db,paper:PaperEngine,book=0,since=0){
  const cache=new Map<string,string>(),ids=new Set<number>();
  for(const r of db.all<{id:number;scannerId:string;symbol:string;tf:string;strategy:string;policyId:string}>(
    `SELECT p.id,p.scanner_id scannerId,p.symbol,p.tf,t.id policyId,t.strategy_id strategy FROM positions p
     JOIN trade_policies t ON t.id=p.policy_id WHERE p.bt=? AND p.status='closed' AND p.exit_at>=? AND ${eligibleEvidence}`,book,since)){
    const key=`${r.scannerId}|${r.symbol}|${r.tf}`;
    let expected=cache.get(key);if(!expected){const policy=paper.policyForCell(r);expected=book===0?policy.id:policy.strategyId;cache.set(key,expected);}
    if(expected===(book===0?r.policyId:r.strategy))ids.add(r.id);
  }
  return ids;
}
export function policyHealth(db:Db,paper:PaperEngine,shadow:PaperEngine,now=Date.now()){
  const books=[paper,shadow].map(engine=>{
    const rows=db.all<{id:number;bound:number;adopted:number;known:number;quarantined:number}>(
      `SELECT p.id,p.policy_id IS NOT NULL bound,p.policy_adopted_at IS NOT NULL adopted,t.source_hash IS NOT NULL known,
       EXISTS(SELECT 1 FROM evidence_flags f WHERE f.position_id=p.id AND f.entry_at=p.entry_at AND f.status='quarantined') quarantined
       FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE p.bt=? AND p.status='closed' AND p.exit_at>=?`,engine.book,now-30*86400000);
    const ids=currentPolicyIds(db,paper,engine.book,now-30*86400000);
    const count={matching:0,changed:0,legacy:0,quarantined:0};
    for(const r of rows)count[r.quarantined?'quarantined':!r.bound||r.adopted||!r.known?'legacy':ids.has(r.id)?'matching':'changed']++;
    const positions=[...engine.openPositions(),...engine.pendingEntries()];
    return {book:engine.book===0?'paper':'shadow',closed:rows.length,...count,open:engine.openPositions().length,
      boundOpen:positions.filter(p=>!!p.policy).length,adoptedOpen:positions.filter(p=>!!p.policy?.adoptedAt).length,
      pending:engine.pendingEntries().length,reservedMargin:engine.pendingEntries().reduce((n,p)=>n+(p.reservation?.margin??0),0)};
  });
  return {at:now,windowDays:30,books,haltEvents:db.get<{n:number}>('SELECT COUNT(*) n FROM risk_halts WHERE at>=?',now-30*86400000)?.n??0,
    qualification:'Current source, scanner interpretation and execution policy; historical P&L remains in the journal.',
    limitations:['Execution replay covers recorded inputs. Historical depth and order queues are not reconstructed.',
      'Forward profitability and exchange lifecycle certification are still required before live activation.']};
}
