import type {AppConfig, IncubatorConfig} from '../config.ts';
import type {Db} from '../db.ts';
import type {TradePolicy} from '../paper/tradePolicy.ts';
import type {EvidenceCell, EvidenceTrade} from './trades.ts';
import {gateVerdict, pairStats, mirrorRefusal} from '../incubator/gate.ts';

type Requirements = {version:1; gate:IncubatorConfig['gate']; stressBps:number};
type Enrollment = {strategy_id:string; started_at:number; requirements:string; seed:string};

/** Enrollment is idempotent across restarts and freezes the test before any forward outcome.
 * Current exact-qualified cells and allocated account cells keep their existing path. */
export function enrollRestoration(db:Db, cell:EvidenceCell, policy:TradePolicy, cfg:AppConfig,
  exact:EvidenceTrade[], compatible:EvidenceTrade[], at:number):boolean {
  if(policy.scannerId!==cell.scannerId||policy.symbol!==cell.symbol||policy.tf!==cell.tf)return false;
  if(!policy.sourceHash || policy.adoptedAt != null || !Number.isFinite(at)) return false;
  const stage=db.get<{stage:string}>('SELECT stage FROM incubator_pairs WHERE scanner_id=? AND symbol=? AND tf=?',cell.scannerId,cell.symbol,cell.tf)?.stage;
  if(!['shadow','proposed'].includes(stage ?? '')) return false;
  const previous=db.get('SELECT 1 FROM evidence_restorations WHERE scanner_id=? AND symbol=? AND tf=?',cell.scannerId,cell.symbol,cell.tf);
  if(!previous && (!mirrorRefusal(cfg.incubator.mirror,exact,null) || mirrorRefusal(cfg.incubator.mirror,compatible,null)
    || !compatible.some(t=>t.basis==='full-fee'))) return false;
  const g=cfg.incubator.gate;
  const requirements:Requirements={version:1,stressBps:5,gate:{...structuredClone(g),
    minTrades:Math.max(20,g.minTradesByTf?.[cell.tf] ?? g.minTrades),
    minDays:g.minDaysByTf?.[cell.tf] ?? g.minDays,
    maxDays:g.maxDaysByTf?.[cell.tf] ?? g.maxDays}};
  const seed={exact:exact.length,compatible:compatible.length,netR:compatible.reduce((s,t)=>s+t.r,0),
    trades:compatible.map(t=>({id:t.positionId,entryAt:t.entryAt,basis:t.basis,r:t.r}))};
  return db.run('INSERT OR IGNORE INTO evidence_restorations VALUES(?,?,?,?,?,?,?)',policy.strategyId,cell.scannerId,cell.symbol,cell.tf,
    at,JSON.stringify(requirements),JSON.stringify(seed)).changes>0;
}

/** Extra round-trip friction uses actual filled entry/exit notionals, including partial exits.
 * An invalid journal blocks the verdict; it must not remove an inconvenient loss. */
function stressCostR(db:Db,t:EvidenceTrade,bps:number):number|null {
  const p=db.get<any>('SELECT fills,fees,qty,contract_value,risk_amount,entry_at,exit_at FROM positions WHERE id=? AND entry_at=?',t.positionId,t.entryAt);
  if(!p || !(p.risk_amount>0 && p.qty>0 && p.contract_value>0)) return null;
  try {
    const parsed=JSON.parse(p.fills), fills=Array.isArray(parsed)?parsed:parsed.fills;
    if(!Array.isArray(fills)||!fills.length)return null;
    let entry=0,exit=0,notional=0,fees=0;
    for(const f of fills){
      if(!Number.isFinite(f.fee)||f.fee<0)return null;
      fees+=f.fee;
      if(f.reason==='funding'){if(f.qty!==0||f.fee!==0)return null;continue;}
      if(!(f.qty>0&&f.price>0)||!Number.isFinite(f.qty*f.price)||!Number.isFinite(f.at)||f.at<p.entry_at||f.at>p.exit_at)return null;
      if(f.reason==='entry')entry+=f.qty;else exit+=f.qty;
      notional+=f.qty*f.price*p.contract_value;
    }
    const near=(a:number,b:number)=>Math.abs(a-b)<=Math.max(1e-8,Math.abs(b)*1e-8);
    if(!near(entry,p.qty)||!near(exit,p.qty)||!near(fees,p.fees))return null;
    const cost=notional/2*bps/10_000/p.risk_amount;
    return Number.isFinite(cost)?cost:null;
  }catch{return null;}
}

/** Read-only, as-of verdict. Nothing before enrollment, still open, or quarantined qualifies.
 * All consumers re-evaluate, so later losses or quarantine can revoke eligibility. */
export function restorationAssessment(db:Db,cell:EvidenceCell,policy:TradePolicy,exact:EvidenceTrade[],at:number) {
  const row=db.get<Enrollment>('SELECT * FROM evidence_restorations WHERE strategy_id=?',policy.strategyId);
  const prior=()=>db.get('SELECT 1 FROM evidence_restorations WHERE scanner_id=? AND symbol=? AND tf=? AND started_at<=?',cell.scannerId,cell.symbol,cell.tf,at);
  if(!row || row.started_at>at)return prior()?{state:'policy-changed' as const,passed:false,reasons:['policy changed; a new forward window is required']}:null;
  try {
    const rules=JSON.parse(row.requirements) as Requirements;
    if(rules.version!==1 || rules.stressBps!==5 || !(rules.gate.minDays>0) || !(rules.gate.minTrades>=20))throw Error('invalid requirements');
    const forward=exact.filter(t=>t.entryAt>=row.started_at&&t.exitAt<at);
    const stats=pairStats(forward,row.started_at,at);
    const verdict=gateVerdict(stats,rules.gate);
    const reasons=verdict.decision==='propose'?[]:[...verdict.reasons];
    const split=row.started_at+(at-row.started_at)/2;
    const first=forward.filter(t=>t.entryAt<split),second=forward.filter(t=>t.entryAt>=split);
    const sum=(ts:EvidenceTrade[])=>ts.reduce((n,t)=>n+t.r,0);
    const halves=[sum(first),sum(second)];
    if(!first.length||!second.length||halves.some(r=>!(r>0)))reasons.push('both forward time halves must be positive');
    const costs=forward.map(t=>stressCostR(db,t,rules.stressBps));
    const invalidFills=costs.filter(c=>c===null).length;
    const stressedR=invalidFills?null:stats.netR-costs.reduce<number>((n,c)=>n+(c??0),0);
    if(invalidFills)reasons.push(`${invalidFills} forward journals cannot establish execution-cost stress`);
    if(stressedR===null||!(stressedR>0))reasons.push('forward profit must remain positive after 0.05% extra round-trip cost');
    const passed=reasons.length===0;
    const seed=JSON.parse(row.seed);
    return {state:passed?'passed' as const:'evaluating' as const,passed,startedAt:row.started_at,at,gateDecision:verdict.decision,
      requirements:{minTrades:rules.gate.minTrades,minDays:rules.gate.minDays,minPfR:rules.gate.minPfR,minAvgR:rules.gate.minAvgR,minT:rules.gate.minT??0,stressBps:rules.stressBps},
      seed:{exact:seed.exact,compatible:seed.compatible,netR:seed.netR},stats,halves,stressedR,invalidFills,reasons};
  }catch{return {state:'invalid' as const,passed:false,reasons:['invalid forward evaluation record; qualification held']};}
}
