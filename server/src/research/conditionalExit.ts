import type {Db} from '../db.ts';
import {TF_SECONDS} from '../config.ts';
import type {Position} from '../paper/logic.ts';
import {tradePolicyIdFor} from '../paper/tradePolicy.ts';
import {CAUSAL_EXIT_VERSION} from '../paper/exitExecution.ts';
import {earlyExitCell,EARLY_EXIT_SCANNERS} from './scannerEarlyExit.ts';
import {frozenSignalBar,signalWick} from './shadowInvalidation.ts';

export const CONDITIONAL_EXIT_VERSION='conditional-exit-v1';
export const EXIT_ARMS=['invalidation','protection','combined'] as const;
export type ExitArm=typeof EXIT_ARMS[number];
export const conditionalRule=(arm:ExitArm,stress=false)=>`${CONDITIONAL_EXIT_VERSION}-${arm}${stress?'-stress':''}`;
type ArmState={status:'watching'|'triggered'|'unchanged'|'unverified';reason:string|null;triggerAt:number|null};
export interface ConditionalState {
 lastAt:number;lastPriceAt:number;lastDepthAt:number;peakNetR:number;peakPriceR:number;priceSamples:number;netSamples:number;
 invalidSince:number|null;profitSince:number|null;profitLevel:number|null;level:number|null;
 samples:Array<{at:number;price:number}>;arms:Record<ExitArm,ArmState>;
}
export interface ConditionalSample {at:number;price:number;priceAt:number;depthAt:number|null;netR:number|null;exitPending:boolean}
export function conditionalParameters(scanner:string,tf:string){
 const sourceBar=(TF_SECONDS[tf]??900)*1000;
 if(scanner===EARLY_EXIT_SCANNERS[0])return {name:'Cluster signal-wick failure',graceMs:60000,failureMs:60000,peakLimit:null,armNetR:.2,profitMs:20000};
 if(scanner===EARLY_EXIT_SCANNERS[1])return {name:'Predictive regime without follow-through',graceMs:sourceBar,failureMs:120000,peakLimit:.1,armNetR:.25,profitMs:30000};
 return {name:'SOL maker failed continuation',graceMs:30000,failureMs:30000,peakLimit:null,armNetR:.2,profitMs:15000};
}
export function initialConditionalState(p:Position,level:number|null):ConditionalState {
 return {lastAt:p.entryAt,lastPriceAt:0,lastDepthAt:0,peakNetR:0,peakPriceR:0,priceSamples:0,netSamples:0,invalidSince:null,profitSince:null,profitLevel:null,level,samples:[],
  arms:Object.fromEntries(EXIT_ARMS.map(a=>[a,{status:'watching',reason:null,triggerAt:null}])) as ConditionalState['arms']};
}
export function invalidateConditional(s:ConditionalState,reason:string){
 for(const a of EXIT_ARMS)if(s.arms[a].status==='watching')s.arms[a]={status:'unverified',reason,triggerAt:null};
 s.invalidSince=null;s.profitSince=null;s.profitLevel=null;
}
/** Research hypotheses, not author-native exits. Only information actually observed by `at` is consumed. */
export function advanceConditional(p:Position,s:ConditionalState,x:ConditionalSample):ExitArm[]{
 if(x.at<=s.lastAt)return [];
 if(x.at-s.lastAt>15000){invalidateConditional(s,'Fresh-price observation gap exceeds 15 seconds');return [];}
 if(![x.price,x.priceAt].every(Number.isFinite)||x.price<=0||x.priceAt>x.at||x.priceAt<p.entryAt||x.at-x.priceAt>10000)return [];
 // A cached quote cannot supply repeated confirmations or extend measured price coverage.
 if(x.priceAt<=s.lastPriceAt)return [];
 s.lastAt=x.at;s.lastPriceAt=x.priceAt;s.priceSamples++;
 const netFresh=x.netR!==null&&Number.isFinite(x.netR)&&x.depthAt!==null&&Number.isFinite(x.depthAt)
  &&x.depthAt>=p.entryAt&&x.depthAt<=x.at&&x.at-x.depthAt<=1000&&x.depthAt>s.lastDepthAt;
 if(netFresh){s.lastDepthAt=x.depthAt!;s.peakNetR=Math.max(s.peakNetR,x.netR!);s.netSamples++;}
 const dir=p.side==='long'?1:-1,unit=Math.abs(p.entryPrice-p.slOriginal!);
 const r=dir*(x.price-p.entryPrice)/unit,q=conditionalParameters(p.scannerId,p.tf);
 const protective=x.exitPending||(p.sl!==null&&dir*(x.price-p.sl)<=0)||(p.liqPrice!==null&&dir*(x.price-p.liqPrice)<=0);
 s.peakPriceR=Math.max(s.peakPriceR,r);
 // Use a trailing observed range, not a candle's future high/low. This is explicitly sampled microstructure.
 s.samples=s.samples.filter(v=>v.at>=x.at-120000);
 const reference=s.samples.filter(v=>v.at>=x.at-90000&&v.at<=x.at-30000);
 const rangeReady=reference.length>=6&&reference.at(-1)!.at-reference[0].at>=25000;
 const level=s.profitLevel??(rangeReady?(dir===1?Math.min(...reference.map(v=>v.price)):Math.max(...reference.map(v=>v.price))):null);
 const broken=level!==null&&dir*(x.price-level)<0;
 const stressCostR=p.qtyOpen*p.contractValue*x.price*.0005/p.riskAmount;
 const protect=netFresh&&!protective&&s.peakNetR>=q.armNetR&&x.netR!>.02+stressCostR
  &&s.peakNetR-x.netR!>=Math.max(.08,.35*s.peakNetR)&&broken;
 s.profitSince=protect?s.profitSince??x.at:null;
 s.profitLevel=protect?level:null;
 const failed=!protective&&s.level!==null&&dir*(x.price-s.level)<0&&r<=-.2&&r>-1
  &&x.at-p.entryAt>=q.graceMs&&(q.peakLimit===null||s.peakPriceR<q.peakLimit);
 s.invalidSince=failed?s.invalidSince??x.at:null;
 const invalid=s.invalidSince!==null&&x.at-s.invalidSince>=q.failureMs;
 const protection=s.profitSince!==null&&x.at-s.profitSince>=q.profitMs;
 s.samples.push({at:x.at,price:x.price});s.samples=s.samples.slice(-64);
 const triggered:ExitArm[]=[];
 for(const arm of EXIT_ARMS){
  const fire=arm==='invalidation'?invalid:arm==='protection'?protection:invalid||protection;
  if(fire&&s.arms[arm].status==='watching'){
   s.arms[arm]={status:'triggered',triggerAt:x.at,reason:invalid&&arm!=='protection'?q.name:'Net profit giveback with persistent observed-range failure'};
   triggered.push(arm);
  }
 }
 return triggered;
}
interface Cohort {position_id:number;entry_at:number;book:number;scanner:string;symbol:string;tf:string;policy_id:string;source_hash:string;binding:string;state:string}
function binding(p:Position){return JSON.stringify([p.policy?.id,p.qty,p.entryPrice,p.slOriginal,p.riskAmount,p.contractValue,p.side,p.fills.filter(f=>f.reason==='entry')]);}
/** Separate advisory tables only. No engine, execution queue, admission or configuration access. */
export class ConditionalExitStudy {
 readonly startedAt:number;
 private db:Db;
 constructor(db:Db,now=Date.now()){
  this.db=db;
  db.db.exec(`CREATE TABLE IF NOT EXISTS advisory_conditional_studies(version TEXT PRIMARY KEY,started_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS advisory_conditional_cohort(position_id INTEGER NOT NULL,entry_at INTEGER NOT NULL,book INTEGER NOT NULL,
    scanner TEXT NOT NULL,symbol TEXT NOT NULL,tf TEXT NOT NULL,policy_id TEXT NOT NULL,source_hash TEXT NOT NULL,binding TEXT NOT NULL,state TEXT NOT NULL,
    promotion_eligible INTEGER NOT NULL DEFAULT 0 CHECK(promotion_eligible=0),PRIMARY KEY(position_id,entry_at));`);
  db.run('INSERT OR IGNORE INTO advisory_conditional_studies VALUES(?,?)',CONDITIONAL_EXIT_VERSION,now);
  this.startedAt=db.get<{started_at:number}>('SELECT started_at FROM advisory_conditional_studies WHERE version=?',CONDITIONAL_EXIT_VERSION)!.started_at;
 }
 observe(p:Position,book:number,scope:string,x:ConditionalSample|null,now:number):ExitArm[]{
  if(!earlyExitCell(p.scannerId,p.symbol,p.tf)||!((book===0&&scope==='paper')||(book===2&&scope==='shadow'))
   ||p.executionPlan||p.basket||p.status!=='open'||p.entryAt<this.startedAt||p.entryAt>now)return [];
  let c=this.db.get<Cohort>('SELECT * FROM advisory_conditional_cohort WHERE position_id=? AND entry_at=?',p.id,p.entryAt);
  if(!c){
   const s=initialConditionalState(p,signalWick(p,frozenSignalBar(this.db,p))),policy=p.policy;
   const reason=!(policy?.sourceHash&&policy.adoptedAt==null&&policy.sim>=CAUSAL_EXIT_VERSION&&tradePolicyIdFor(policy)===policy.id)?'Unverifiable entry policy'
    :now-p.entryAt>10000?'Observation started late':!(p.riskAmount>0&&p.slOriginal!==null&&Math.abs(p.entryPrice-p.slOriginal)>0)?'Invalid original risk'
    :p.qtyOpen!==p.qty?'Partial exit preceded observation':null;
   if(reason)invalidateConditional(s,reason);
   this.db.run('INSERT INTO advisory_conditional_cohort(position_id,entry_at,book,scanner,symbol,tf,policy_id,source_hash,binding,state) VALUES(?,?,?,?,?,?,?,?,?,?)',
    p.id,p.entryAt,book,p.scannerId,p.symbol,p.tf,policy?.id??'unknown',policy?.sourceHash??'unknown',binding(p),JSON.stringify(s));
   c=this.db.get<Cohort>('SELECT * FROM advisory_conditional_cohort WHERE position_id=? AND entry_at=?',p.id,p.entryAt)!;
  }
  const s:ConditionalState=JSON.parse(c.state);
  if(!EXIT_ARMS.some(a=>s.arms[a].status==='watching'))return [];
  if(c.binding!==binding(p)||p.policy?.adoptedAt!=null){
   for(const a of EXIT_ARMS)s.arms[a]={status:'unverified',reason:'Entry exposure or policy changed',triggerAt:s.arms[a].triggerAt};
  }else if(p.qtyOpen!==p.qty)invalidateConditional(s,'Actual partial exit precedes candidate');
  else if(now-s.lastAt>15000)invalidateConditional(s,'Fresh-price observation gap exceeds 15 seconds');
  const fires=x&&x.at===now?advanceConditional(p,s,x):[];
  this.db.run('UPDATE advisory_conditional_cohort SET state=? WHERE position_id=? AND entry_at=?',JSON.stringify(s),p.id,p.entryAt);
  return fires;
 }
 reconcile(now:number){
  const unseen=this.db.all<{id:number;entry_at:number;bt:number;scanner_id:string;symbol:string;tf:string;policy_id:string|null}>(`SELECT p.* FROM positions p
   LEFT JOIN advisory_conditional_cohort c ON c.position_id=p.id AND c.entry_at=p.entry_at
   WHERE c.position_id IS NULL AND p.status='closed' AND p.entry_at>=? AND p.entry_at>=?
   AND ((p.bt=0 AND p.evidence_scope='account') OR (p.bt=2 AND p.evidence_scope='shadow'))
   AND (p.scanner_id IN (?,?) OR (p.scanner_id=? AND p.symbol='SOLUSD' AND p.tf='15m'))`,this.startedAt,now-90*86400000,...EARLY_EXIT_SCANNERS);
  for(const p of unseen){
   const state=initialConditionalState({entryAt:p.entry_at} as Position,null);invalidateConditional(state,'No prospective observations before closure');
   this.db.run('INSERT OR IGNORE INTO advisory_conditional_cohort(position_id,entry_at,book,scanner,symbol,tf,policy_id,source_hash,binding,state) VALUES(?,?,?,?,?,?,?,?,?,?)',p.id,p.entry_at,p.bt,p.scanner_id,p.symbol,p.tf,p.policy_id??'unknown','unknown','unseen',JSON.stringify(state));
  }
  for(const c of this.db.all<Cohort&{exit_at:number;policy_current:string|null;adopted:number|null;qty:number;entry_price:number;sl_original:number;side:string;risk_amount:number;contract_value:number}>(`SELECT c.*,p.exit_at,p.policy_id policy_current,p.policy_adopted_at adopted,p.qty,p.entry_price,p.sl_original,p.side,p.risk_amount,p.contract_value FROM advisory_conditional_cohort c JOIN positions p ON p.id=c.position_id AND p.entry_at=c.entry_at WHERE p.status='closed'`)){
   const s:ConditionalState=JSON.parse(c.state);let changed=false;
   const b:unknown[]=c.binding==='unseen'?[]:JSON.parse(c.binding);
   const altered=c.policy_current!==c.policy_id||c.adopted!==null||(b.length>0&&JSON.stringify(b.slice(0,8))!==JSON.stringify([c.policy_current,c.qty,c.entry_price,c.sl_original,c.risk_amount,c.contract_value,c.side,b[7]]));
   for(const a of EXIT_ARMS){
    if(altered){s.arms[a]={status:'unverified',reason:'Entry exposure or policy changed',triggerAt:s.arms[a].triggerAt};changed=true;}
    else if(s.arms[a].status==='watching'){
     s.arms[a]={status:s.lastAt>=c.exit_at-15000?'unchanged':'unverified',reason:s.lastAt>=c.exit_at-15000?null:'Observation gap before actual close',triggerAt:null};changed=true;
    }
   }
   if(changed)this.db.run('UPDATE advisory_conditional_cohort SET state=? WHERE position_id=? AND entry_at=?',JSON.stringify(s),c.position_id,c.entry_at);
  }
  this.db.run('DELETE FROM advisory_conditional_cohort WHERE entry_at<?',now-90*86400000);
 }
 view(){
  const groups=new Map<string,ReturnType<typeof emptyGroup>>();
  const cohorts=this.db.all<Cohort&{actual_status:string|null;actual_net:number|null;risk_amount:number|null;exit_reason:string|null}>(`SELECT c.*,p.status actual_status,p.realized_pnl-p.fees actual_net,p.risk_amount,p.exit_reason FROM advisory_conditional_cohort c LEFT JOIN positions p ON p.id=c.position_id AND p.entry_at=c.entry_at ORDER BY c.entry_at DESC`);
  const trials=new Map(this.db.all<{position_id:number;entry_at:number;rule:string;status:string;net:number|null}>('SELECT position_id,entry_at,rule,status,net FROM advisory_exits WHERE rule LIKE ?',CONDITIONAL_EXIT_VERSION+'-%').map(t=>[`${t.position_id}:${t.entry_at}:${t.rule}`,t]));
  for(const c of cohorts)for(const arm of EXIT_ARMS){
   const s:ConditionalState=JSON.parse(c.state),a=s.arms[arm],key=`${c.book}:${c.scanner}:${c.symbol}:${c.tf}:${c.policy_id}:${arm}`;
   const g=groups.get(key)??emptyGroup(c,key,arm);groups.set(key,g);g.enrolled++;if(a.status==='triggered')g.triggered++;
   if(c.actual_status===null){g.missingActual++;continue;}if(c.actual_status!=='closed')continue;g.closed++;
   const base=trials.get(`${c.position_id}:${c.entry_at}:${conditionalRule(arm)}`),stress=trials.get(`${c.position_id}:${c.entry_at}:${conditionalRule(arm,true)}`),same=a.status==='unchanged';
   if(!(c.risk_amount!>0)||c.actual_net===null||!Number.isFinite(c.actual_net)||(!same&&(a.status!=='triggered'||base?.status!=='filled'||stress?.status!=='filled'||base.net===null||stress.net===null||!Number.isFinite(base.net)||!Number.isFinite(stress.net)))){g.unavailable++;continue;}
   const before=c.actual_net,after=same?before:base!.net!,stressed=same?before:stress!.net!,risk=c.risk_amount!;
   g.covered++;g.baselineR+=before/risk;g.candidateR+=after/risk;g.stressR+=stressed/risk;
   if(c.book===0){g.baselineNet!+=before;g.candidateNet!+=after;g.stressNet!+=stressed;}
   g.stopsBefore+=Number(c.exit_reason==='sl');g.stopsAfter+=Number(same&&c.exit_reason==='sl');
   g.losersBefore+=Number(before<0);g.losersAfter+=Number(after<0);g.stressLosers+=Number(stressed<0);
   g.winnersCut+=Number(before>0&&after<before-1e-8);g.winnersLost+=Number(before>0&&after<=0);
   g.stressWinnersCut+=Number(before>0&&stressed<before-1e-8);
   g.winnerGivebackR+=before>0?Math.max(0,before-after)/risk:0;
   g.gainsBefore+=Math.max(0,before/risk);g.lossesBefore+=Math.max(0,-before/risk);
   g.gainsAfter+=Math.max(0,after/risk);g.lossesAfter+=Math.max(0,-after/risk);
  }
  return {rule:CONDITIONAL_EXIT_VERSION,startedAt:this.startedAt,mode:'shadow-advisory' as const,promotionEligible:false as const,
   description:'Independent invalidation, conditional net-profit protection and combined arms. Fresh quotes for setup failure; fresh full-size depth for net-profit conditions and every fill. Same future entries, fees and funding, configured delay plus +3s/+5bps stress. Experimental hypotheses, not author-native exits. No orders or promotion evidence.',
   groups:[...groups.values()].map(g=>({...g,deltaR:g.candidateR-g.baselineR,stressDeltaR:g.stressR-g.baselineR,profitFactorBefore:g.lossesBefore>0?g.gainsBefore/g.lossesBefore:null,profitFactorAfter:g.lossesAfter>0?g.gainsAfter/g.lossesAfter:null})),
   recent:cohorts.slice(0,30).map(c=>({positionId:c.position_id,entryAt:c.entry_at,scanner:c.scanner,symbol:c.symbol,book:c.book,state:JSON.parse(c.state) as ConditionalState}))};
 }
}
function emptyGroup(c:Cohort,key:string,arm:ExitArm){return {key,scanner:c.scanner,symbol:c.symbol,tf:c.tf,book:c.book,policyId:c.policy_id,arm,
 enrolled:0,closed:0,covered:0,unavailable:0,missingActual:0,triggered:0,baselineR:0,candidateR:0,stressR:0,
 baselineNet:c.book===0?0:null,candidateNet:c.book===0?0:null,stressNet:c.book===0?0:null,
 stopsBefore:0,stopsAfter:0,losersBefore:0,losersAfter:0,stressLosers:0,winnersCut:0,winnersLost:0,stressWinnersCut:0,winnerGivebackR:0,
 gainsBefore:0,lossesBefore:0,gainsAfter:0,lossesAfter:0};}
