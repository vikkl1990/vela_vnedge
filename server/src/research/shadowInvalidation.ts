import type {Db} from '../db.ts';
import {TF_SECONDS} from '../config.ts';
import type {Position} from '../paper/logic.ts';
import {CAUSAL_EXIT_VERSION} from '../paper/exitExecution.ts';

export const ARIA_RULE='aria-wick-confirmed-1m-v1';
export const ARIA_STRESS_RULE='aria-wick-confirmed-1m-stress-v1';
export type SignalBar={time:number;high:number;low:number;close:number};
export interface InvalidationCohort {
 position_id:number;entry_at:number;policy_id:string;source_hash:string;signal_bar:string|null;
 status:string;reason:string|null;last_at:number;confirmation_at:number|null;level:number|null;
}
/** Read only the entry-time snapshot bound to this exact position and policy. */
export function frozenSignalBar(db:Db,p:Position):SignalBar|null {
 const row=db.get<{snapshot:string}>(`SELECT snapshot FROM decision_trace WHERE position_id=? AND at<=? AND stage IN ('pending','opened') ORDER BY at DESC LIMIT 1`,p.id,p.entryAt);
 if(!row)return null;
 try{const x=JSON.parse(row.snapshot);return x.policyId===p.policy?.id?x.signalBar??null:null;}catch{return null;}
}
function causalSignalBar(p:Position,b:SignalBar|null):b is SignalBar {
 const ms=(TF_SECONDS[p.tf]??0)*1000;
 return !!b&&!!ms&&[b.time,b.high,b.low,b.close,p.entryAt,p.entryPrice,p.slOriginal].every(Number.isFinite)
  &&b.time+ms<=p.entryAt&&b.low>0&&b.high>=b.low&&b.close>=b.low&&b.close<=b.high;
}
export function signalWick(p:Position,b:SignalBar|null):number|null {
 if(!causalSignalBar(p,b))return null;
 const level=p.side==='long'?b.low:b.high,stop=p.slOriginal!;
 return (p.side==='long'?stop<level&&level<p.entryPrice:p.entryPrice<level&&level<stop)?level:null;
}
/** Prospective paired shadow cohort. Writes advisory_* only; cannot enter or close a trade. */
export class ShadowInvalidationStudy {
 readonly startedAt:number;
 private db:Db;
 constructor(db:Db,now=Date.now()){
  this.db=db;
  db.db.exec(`CREATE TABLE IF NOT EXISTS advisory_invalidation_study(rule TEXT PRIMARY KEY,started_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS advisory_invalidation_cohort(position_id INTEGER NOT NULL,entry_at INTEGER NOT NULL,policy_id TEXT NOT NULL,source_hash TEXT NOT NULL,
    signal_bar TEXT,status TEXT NOT NULL,reason TEXT,last_at INTEGER NOT NULL,confirmation_at INTEGER,level REAL,
    promotion_eligible INTEGER NOT NULL DEFAULT 0 CHECK(promotion_eligible=0),PRIMARY KEY(position_id,entry_at));`);
  db.run('INSERT OR IGNORE INTO advisory_invalidation_study VALUES(?,?)',ARIA_RULE,now);
  this.startedAt=db.get<{started_at:number}>('SELECT started_at FROM advisory_invalidation_study WHERE rule=?',ARIA_RULE)!.started_at;
 }
 observe(p:Position,book:number,scope:string,price:number|null,priceAt:number|null,now:number,exitPending:boolean):boolean {
  if(book!==2||scope!=='shadow'||p.scannerId!=='elliott-wave'||p.symbol!=='ARIAUSD'||p.tf!=='15m'||p.status!=='open'
   ||p.executionPlan||!p.policy?.sourceHash||p.policy.adoptedAt!=null||p.policy.sim<CAUSAL_EXIT_VERSION||p.entryAt<this.startedAt)return false;
  let row=this.db.get<InvalidationCohort>('SELECT * FROM advisory_invalidation_cohort WHERE position_id=? AND entry_at=?',p.id,p.entryAt);
  if(!row){
   const b=frozenSignalBar(this.db,p),level=signalWick(p,b),late=now-p.entryAt>10000;
   const missing=!causalSignalBar(p,b),status=late||missing?'unverified':level===null?'inapplicable':'watching';
   this.db.run('INSERT INTO advisory_invalidation_cohort(position_id,entry_at,policy_id,source_hash,signal_bar,status,reason,last_at,level) VALUES(?,?,?,?,?,?,?,?,?)',
    p.id,p.entryAt,p.policy.id,p.policy.sourceHash,JSON.stringify(b),status,late?'Observation started late':missing?'Missing or non-causal bound signal candle':level===null?'Signal wick is outside entry to original stop':null,p.entryAt,level);
   row=this.db.get<InvalidationCohort>('SELECT * FROM advisory_invalidation_cohort WHERE position_id=? AND entry_at=?',p.id,p.entryAt)!;
  }
  const addedEntries=p.fills.filter(f=>f.reason==='entry'&&f.qty>0).length!==1;
  if((row.status==='watching'||row.status==='triggered')&&(addedEntries||(row.status==='watching'&&p.qtyOpen!==p.qty))){
   this.db.run("UPDATE advisory_invalidation_cohort SET status='unverified',reason='Entry/add-on or prior partial exit differs from the reviewed single-entry cohort' WHERE position_id=? AND entry_at=?",p.id,p.entryAt);return false;
  }
  if(row.status!=='watching')return false;
  const gap=now-row.last_at>120000,changed=row.policy_id!==p.policy.id;
  if(gap||changed){this.db.run("UPDATE advisory_invalidation_cohort SET status='unverified',reason=?,confirmation_at=NULL WHERE position_id=? AND entry_at=?",changed?'Bound policy changed':'Observation gap exceeds two minutes',p.id,p.entryAt);return false;}
  if(now<row.last_at||now-row.last_at<60000)return false;
  const fresh=price!==null&&Number.isFinite(price)&&price>0&&priceAt!==null&&priceAt<=now&&now-priceAt<=10000;
  if(!fresh)return false;
  const failed=p.side==='long'?price!<row.level!:price!>row.level!;
  const confirmation=failed?row.confirmation_at??now:null;
  const protective=p.sl!==null&&(p.side==='long'?price!<=p.sl:price!>=p.sl);
  const trigger=failed&&confirmation!==null&&now-confirmation>=30000&&!exitPending&&!protective;
  this.db.run('UPDATE advisory_invalidation_cohort SET last_at=?,confirmation_at=?,status=? WHERE position_id=? AND entry_at=?',now,confirmation,trigger?'triggered':'watching',p.id,p.entryAt);
  return trigger;
 }
 view(){
  // Include unchanged trades, unavailable trials and losing early exits. An avoided SL label
  // is never counted as a win. Different frozen policies are reported separately.
  const cohorts=this.db.all<any>(`SELECT c.*,p.status actual_status,p.exit_reason,p.realized_pnl-p.fees actual_net,p.risk_amount,
   a.status base_status,a.net base_net,s.status stress_status,s.net stress_net
   FROM advisory_invalidation_cohort c JOIN positions p ON p.id=c.position_id AND p.entry_at=c.entry_at
   LEFT JOIN advisory_exits a ON a.position_id=c.position_id AND a.entry_at=c.entry_at AND a.rule=?
   LEFT JOIN advisory_exits s ON s.position_id=c.position_id AND s.entry_at=c.entry_at AND s.rule=?
   ORDER BY c.entry_at DESC`,ARIA_RULE,ARIA_STRESS_RULE);
  const groups=new Map<string,any>();
  for(const c of cohorts){
   let g=groups.get(c.policy_id);if(!g){g={policyId:c.policy_id,sourceHash:c.source_hash,enrolled:0,closed:0,covered:0,unavailable:0,triggered:0,baselineR:0,candidateR:0,stressR:0,stopsBefore:0,stopsAfter:0,losersBefore:0,losersAfter:0,winnersCut:0,winsR:0,lossesR:0};groups.set(c.policy_id,g);}
   g.enrolled++;if(c.status==='triggered')g.triggered++;if(c.actual_status!=='closed')continue;g.closed++;
   // A watching row may have missed observations before closure: do not silently count
   // it as an unchanged success after a restart. Runtime closes it explicitly below.
   const same=c.status==='unchanged'||c.status==='inapplicable';
   const covered=same||(c.status==='triggered'&&c.base_status==='filled'&&c.stress_status==='filled');
   if(!covered||!(c.risk_amount>0)){g.unavailable++;continue;}
   const before=c.actual_net/c.risk_amount,after=(same?c.actual_net:c.base_net)/c.risk_amount,stress=(same?c.actual_net:c.stress_net)/c.risk_amount;
   g.covered++;g.baselineR+=before;g.candidateR+=after;g.stressR+=stress;g.stopsBefore+=Number(c.exit_reason==='sl');g.stopsAfter+=Number(same&&c.exit_reason==='sl');
   g.losersBefore+=Number(before<0);g.losersAfter+=Number(after<0);g.winnersCut+=Number(before>0&&after<before);g.winsR+=Math.max(0,after);g.lossesR+=Math.max(0,-after);
  }
  return {rule:ARIA_RULE,startedAt:this.startedAt,mode:'shadow-advisory',promotionEligible:false,
   description:'ARIA Elliott Wave 15m only. One fresh sample per minute; two failures beyond the signal wick, at least 30 seconds apart. Paired with unchanged actual shadow trades. No orders or promotion evidence.',
   groups:[...groups.values()].map(g=>({...g,deltaR:g.candidateR-g.baselineR,stressDeltaR:g.stressR-g.baselineR,profitFactor:g.lossesR>0?g.winsR/g.lossesR:null})),recent:cohorts.slice(0,30)};
 }
 reconcile(now:number){
  this.db.run(`UPDATE advisory_invalidation_cohort SET status=CASE WHEN last_at>=(SELECT exit_at FROM positions p WHERE p.id=position_id AND p.entry_at=advisory_invalidation_cohort.entry_at)-120000 THEN 'unchanged' ELSE 'unverified' END,
   reason=CASE WHEN last_at<(SELECT exit_at FROM positions p WHERE p.id=position_id AND p.entry_at=advisory_invalidation_cohort.entry_at)-120000 THEN 'Observation gap before actual close' ELSE NULL END
   WHERE status='watching' AND EXISTS(SELECT 1 FROM positions p WHERE p.id=position_id AND p.entry_at=advisory_invalidation_cohort.entry_at AND p.status='closed')`);
  this.db.run('DELETE FROM advisory_invalidation_cohort WHERE entry_at<?',now-90*86400000);
 }
}
