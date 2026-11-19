import type {Db} from '../db.ts';
import type {Position} from '../paper/logic.ts';
import {CAUSAL_EXIT_VERSION} from '../paper/exitExecution.ts';
import {tradePolicyIdFor} from '../paper/tradePolicy.ts';

export const SCANNER_EARLY_EXIT='scanner-half-stop-v1';
export const SCANNER_EARLY_STRESS='scanner-half-stop-stress-v1';
export const EARLY_EXIT_SCANNERS=['supertrend-cluster-zeiierman','ai-predictive-flow-zeiierman','trend-impulse-channels-zeiierman-maker'] as const;
export function earlyExitCell(scanner:string,symbol:string,tf:string){
 return scanner===EARLY_EXIT_SCANNERS[0]||scanner===EARLY_EXIT_SCANNERS[1]||scanner===EARLY_EXIT_SCANNERS[2]&&symbol==='SOLUSD'&&tf==='15m';
}
interface Cohort {position_id:number;entry_at:number;book:number;scanner:string;symbol:string;tf:string;policy_id:string;source_hash:string;qty:number;entry_price:number;original_stop:number;status:string;reason:string|null;last_at:number}

/** Paired, prospective exit observations. Has no engine, executor or configuration setter. */
export class ScannerEarlyExitStudy {
 readonly startedAt:number;
 private db:Db;
 constructor(db:Db,now=Date.now()){
  this.db=db;
  db.db.exec(`CREATE TABLE IF NOT EXISTS advisory_scanner_exit_studies(rule TEXT PRIMARY KEY,started_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS advisory_scanner_exit_cohort(position_id INTEGER NOT NULL,entry_at INTEGER NOT NULL,
    book INTEGER NOT NULL,scanner TEXT NOT NULL,symbol TEXT NOT NULL,tf TEXT NOT NULL,policy_id TEXT NOT NULL,source_hash TEXT NOT NULL,
    qty INTEGER NOT NULL,entry_price REAL NOT NULL,original_stop REAL NOT NULL,status TEXT NOT NULL,reason TEXT,last_at INTEGER NOT NULL,
    promotion_eligible INTEGER NOT NULL DEFAULT 0 CHECK(promotion_eligible=0),PRIMARY KEY(position_id,entry_at));`);
  db.run('INSERT OR IGNORE INTO advisory_scanner_exit_studies VALUES(?,?)',SCANNER_EARLY_EXIT,now);
  this.startedAt=db.get<{started_at:number}>('SELECT started_at FROM advisory_scanner_exit_studies WHERE rule=?',SCANNER_EARLY_EXIT)!.started_at;
 }
 observe(p:Position,book:number,scope:string,price:number|null,priceAt:number|null,now:number,exitPending:boolean):boolean {
  if(!earlyExitCell(p.scannerId,p.symbol,p.tf)||!((book===0&&scope==='paper')||(book===2&&scope==='shadow'))
   ||p.status!=='open'||p.executionPlan||p.basket||p.entryAt<this.startedAt||p.entryAt>now)return false;
  let row=this.db.get<Cohort>('SELECT * FROM advisory_scanner_exit_cohort WHERE position_id=? AND entry_at=?',p.id,p.entryAt);
  if(!row){
   const policy=p.policy;
   const valid=policy?.sourceHash&&policy.adoptedAt==null&&policy.sim>=CAUSAL_EXIT_VERSION&&tradePolicyIdFor(policy)===policy.id;
   const unit=Math.abs(p.entryPrice-(p.slOriginal??p.entryPrice));
   const reason=!valid?'Missing, adopted or unverifiable entry policy':now-p.entryAt>10000?'Observation started late':!(unit>0&&p.riskAmount>0)?'Invalid original risk':p.qtyOpen!==p.qty?'Partial exit preceded observation':null;
   this.db.run('INSERT INTO advisory_scanner_exit_cohort(position_id,entry_at,book,scanner,symbol,tf,policy_id,source_hash,qty,entry_price,original_stop,status,reason,last_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    p.id,p.entryAt,book,p.scannerId,p.symbol,p.tf,policy?.id??'unknown',policy?.sourceHash??'unknown',p.qty,p.entryPrice,p.slOriginal??p.entryPrice,reason?'unverified':'watching',reason,p.entryAt);
   row=this.db.get<Cohort>('SELECT * FROM advisory_scanner_exit_cohort WHERE position_id=? AND entry_at=?',p.id,p.entryAt)!;
  }
  if(row.status!=='watching'&&row.status!=='triggered')return false;
  const changed=row.policy_id!==p.policy?.id||p.policy?.adoptedAt!=null||row.qty!==p.qty||row.entry_price!==p.entryPrice||row.original_stop!==p.slOriginal;
  if(changed){this.invalidate(p,'Entry exposure or bound policy changed');return false;}
  if(row.status==='triggered')return false;
  if(now<row.last_at)return false;
  if(now-row.last_at>15000){this.invalidate(p,'Observation gap exceeds 15 seconds');return false;}
  const fresh=price!==null&&Number.isFinite(price)&&price>0&&priceAt!==null&&priceAt>=p.entryAt&&priceAt<=now&&now-priceAt<=10000;
  if(!fresh)return false;
  const r=(price!-p.entryPrice)*(p.side==='long'?1:-1)/Math.abs(p.entryPrice-p.slOriginal!);
  const protective=p.sl!==null&&(p.side==='long'?price!<=p.sl:price!>=p.sl);
  const liquidating=p.liqPrice!==null&&(p.side==='long'?price!<=p.liqPrice:price!>=p.liqPrice);
  const trigger=r<=-.5&&r>-1&&!exitPending&&!protective&&!liquidating;
  this.db.run('UPDATE advisory_scanner_exit_cohort SET last_at=?,status=? WHERE position_id=? AND entry_at=?',now,trigger?'triggered':'watching',p.id,p.entryAt);
  return trigger;
 }
 private invalidate(p:Position,reason:string){this.db.run("UPDATE advisory_scanner_exit_cohort SET status='unverified',reason=? WHERE position_id=? AND entry_at=?",reason,p.id,p.entryAt);}
 reconcile(now:number){
  // Do not silently lose very short trades or trades entered/closed during downtime from the denominator.
  this.db.run(`INSERT OR IGNORE INTO advisory_scanner_exit_cohort(position_id,entry_at,book,scanner,symbol,tf,policy_id,source_hash,qty,entry_price,original_stop,status,reason,last_at)
   SELECT p.id,p.entry_at,p.bt,p.scanner_id,p.symbol,p.tf,coalesce(p.policy_id,'unknown'),coalesce(t.source_hash,'unknown'),p.qty,p.entry_price,coalesce(p.sl_original,p.entry_price),'unverified','No prospective observations before closure',p.entry_at
   FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id
   WHERE p.status='closed' AND p.entry_at>=? AND p.entry_at>=? AND ((p.bt=0 AND p.evidence_scope='account') OR (p.bt=2 AND p.evidence_scope='shadow'))
   AND (p.scanner_id IN (?,?) OR (p.scanner_id=? AND p.symbol='SOLUSD' AND p.tf='15m'))`,this.startedAt,now-90*86400000,...EARLY_EXIT_SCANNERS);
  this.db.run(`UPDATE advisory_scanner_exit_cohort AS c SET status='unverified',reason='Entry exposure or bound policy changed'
   WHERE status IN ('watching','triggered') AND EXISTS(SELECT 1 FROM positions p WHERE p.id=c.position_id AND p.entry_at=c.entry_at AND (p.qty!=c.qty OR p.entry_price!=c.entry_price OR p.sl_original!=c.original_stop OR p.policy_id IS NOT c.policy_id OR p.policy_adopted_at IS NOT NULL))`);
  this.db.run(`UPDATE advisory_scanner_exit_cohort AS c SET
   status=CASE WHEN last_at>=p.exit_at-15000 THEN 'unchanged' ELSE 'unverified' END,
   reason=CASE WHEN last_at>=p.exit_at-15000 THEN NULL ELSE 'Observation gap before actual close' END
   FROM positions p WHERE c.status='watching' AND p.id=c.position_id AND p.entry_at=c.entry_at AND p.status='closed'`);
  this.db.run('DELETE FROM advisory_scanner_exit_cohort WHERE entry_at<?',now-90*86400000);
 }
 view(){
  const rows=this.db.all<Cohort&{actual_status:string|null;actual_net:number|null;risk_amount:number|null;exit_reason:string|null;base_status:string|null;base_net:number|null;stress_status:string|null;stress_net:number|null}>(`SELECT c.*,p.status actual_status,p.realized_pnl-p.fees actual_net,p.risk_amount,p.exit_reason,
   a.status base_status,a.net base_net,s.status stress_status,s.net stress_net
   FROM advisory_scanner_exit_cohort c LEFT JOIN positions p ON p.id=c.position_id AND p.entry_at=c.entry_at
   LEFT JOIN advisory_exits a ON a.position_id=c.position_id AND a.entry_at=c.entry_at AND a.rule=?
   LEFT JOIN advisory_exits s ON s.position_id=c.position_id AND s.entry_at=c.entry_at AND s.rule=? ORDER BY c.entry_at DESC`,SCANNER_EARLY_EXIT,SCANNER_EARLY_STRESS);
  const groups=new Map<string,ReturnType<typeof emptyGroup>>();
  for(const c of rows){
   const key=`${c.book}:${c.scanner}:${c.policy_id}`;
   const g=groups.get(key)??emptyGroup(c,key);groups.set(key,g);g.enrolled++;
   if(c.status==='triggered')g.triggered++;
   if(c.actual_status===null){g.missingActual++;continue;}
   if(c.actual_status!=='closed')continue;g.closed++;
   const same=c.status==='unchanged';
   const covered=same||(c.status==='triggered'&&c.base_status==='filled'&&c.stress_status==='filled');
   if(!covered||!(c.risk_amount!>0)||!Number.isFinite(c.actual_net)||(!same&&(!Number.isFinite(c.base_net)||!Number.isFinite(c.stress_net)))){g.unavailable++;continue;}
   const before=c.actual_net!,after=same?before:c.base_net!,stress=same?before:c.stress_net!,risk=c.risk_amount!;
   g.covered++;g.baselineR+=before/risk;g.candidateR+=after/risk;g.stressR+=stress/risk;
   if(c.book===0){g.baselineNet!+=before;g.candidateNet!+=after;g.stressNet!+=stress;}
   g.stopsBefore+=Number(c.exit_reason==='sl');g.stopsAfter+=Number(same&&c.exit_reason==='sl');g.stressStops+=Number(same&&c.exit_reason==='sl');
   g.losersBefore+=Number(before<0);g.losersAfter+=Number(after<0);g.stressLosers+=Number(stress<0);
   g.winnersCut+=Number(before>0&&after<before-1e-8);g.winnersLost+=Number(before>0&&after<=0);
   g.winnerGivebackR+=before>0?Math.max(0,before-after)/risk:0;
  }
  return {rule:SCANNER_EARLY_EXIT,startedAt:this.startedAt,mode:'shadow-advisory' as const,promotionEligible:false as const,retentionDays:90,
   description:'Future filled entries only. Half-stop exit versus unchanged actual exits; base uses configured latency, stress adds 3 seconds and 5 bps. Paper and shadow references and frozen policies remain separate. No orders or promotion evidence.',
   groups:[...groups.values()].map(g=>({...g,deltaR:g.candidateR-g.baselineR,stressDeltaR:g.stressR-g.baselineR})),
   recent:rows.slice(0,30).map(r=>({positionId:r.position_id,entryAt:r.entry_at,scanner:r.scanner,symbol:r.symbol,tf:r.tf,book:r.book,status:r.status,reason:r.reason,baseStatus:r.base_status,stressStatus:r.stress_status}))};
 }
}
function emptyGroup(c:Cohort,key:string){return {key,scanner:c.scanner,symbol:c.symbol,tf:c.tf,book:c.book,policyId:c.policy_id,sourceHash:c.source_hash,
 enrolled:0,closed:0,covered:0,unavailable:0,missingActual:0,triggered:0,baselineR:0,candidateR:0,stressR:0,
 baselineNet:c.book===0?0:null,candidateNet:c.book===0?0:null,stressNet:c.book===0?0:null,
 stopsBefore:0,stopsAfter:0,stressStops:0,losersBefore:0,losersAfter:0,stressLosers:0,winnersCut:0,winnersLost:0,winnerGivebackR:0};}
