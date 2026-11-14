/** Read-only, reproducible execution research. Never an admission/evidence-policy writer. */
import {createHash} from 'node:crypto';
import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {eligibleEvidence} from '../evidence/trades.ts';
import {stablePolicy} from '../paper/strategyIdentity.ts';

export const digest=(value:unknown)=>createHash('sha256').update(stablePolicy(value)).digest('hex');
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function parse(s:unknown):any {try{return typeof s==='string'?JSON.parse(s):null;}catch{return null;}}
const finite=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x);
export function median(xs:number[]):number|null {
 const sorted=xs.filter(finite).sort((a,b)=>a-b),n=sorted.length;
 return n?n%2?sorted[(n-1)/2]:(sorted[n/2-1]+sorted[n/2])/2:null;
}
export interface ResearchWindow {from:number;asOf:number;repositoryCommit:string}
export interface Provenance {owner:'provided'|'bot'|'mixed'|'unknown';basis:string}
export interface ResearchTrade {
 positionId:number;book:number;scope:string;scannerId:string;symbol:string;tf:string;side:string;
 entryAt:number;exitAt:number;policyId:string|null;strategyId:string|null;sourceHash:string|null;
 policyStatus:'bound'|'plan-bound'|'adopted'|'missing'|'invalid';planId:string|null;planSignature:string|null;
 executionVersion:number|null;quarantined:boolean;eligibleByExistingBoundary:boolean;
 risk:number|null;net:number|null;r:number|null;holdMinutes:number|null;exitReason:string|null;
 channels:string[];stop:Provenance;targets:Provenance;exit:Provenance;
 costs:{bookedFees:number|null;cashCommission:number|null;grossCommission:number|null;feeDiscount:number|null;fundingPnl:number|null;voucherBenefit:null;fundingCoverage:'not-certified'};
 quality:string[];ledger:unknown;orders:Record<string,any>[];receipts:Record<string,Record<string,any>[]>;
}
export interface ExecutionEvidence {
 schema:1;manifest:ResearchWindow&{selection:string;schemaHash:string;producerHash:string;dataHash:string;snapshotHash:string;scope:'research-only';promotionEligible:false;warnings:string[]};
 policies:Record<string,unknown>;trades:ResearchTrade[];allocations:Record<string,any>[];
 cohorts:Array<{key:string;scannerId:string;symbol:string;tf:string;book:number;scope:string;policyId:string|null;planSignature:string|null;n:number;net:number;r:number;validOutcomes:number;medianHoldMinutes:number|null;eligibleByExistingBoundary:number}>;
 summary:{trades:number;scanners:number;cells:number;bookCells:number;cohorts:number;scopes:Record<string,number>;medianHoldMinutes:number|null;eligibleByExistingBoundary:number;qualityIssues:Record<string,number>};
}
/** Initial level provenance can be known without knowing the later stop's owner.
 * Legacy mixed/ATR flags conflate SL and TP. Never use them to infer both. */
export function levelProvenance(levelsSource:unknown,paper:unknown):{stop:Provenance;targets:Provenance;exit:Provenance} {
 const unknown={owner:'unknown' as const,basis:'Historical record lacks independent provenance'};
 const stop:Provenance=levelsSource==='atr-fallback'?{owner:'bot',basis:'Recorded ATR fallback stop'}:
  levelsSource==='script'||levelsSource==='mixed'?{owner:'provided',basis:'Resolver recorded a supplied initial stop; author-intent parity still requires contract validation'}:unknown;
 // Source means supplied to the level resolver, not proof of faithful author intent.
 const targets:Provenance=object(paper)&&paper.scriptTargets==='ignore'?{owner:'bot',basis:'Frozen policy ignores source targets'}:
  levelsSource==='script'?{owner:'provided',basis:'Resolver recorded supplied targets'}:unknown;
 return {stop,targets,exit:{owner:'unknown',basis:'Exit reason alone does not identify the source of an amended stop, TP, or reversal'}};
}
function sumKnown(xs:Record<string,any>[],field:string){return xs.every(x=>finite(x[field]))?xs.reduce((n,x)=>n+x[field],0):null;}
const tablesWithReceipts:Record<string,string>={entry_fill_evidence:'position_id',entry_execution:'position_id',paper_execution_positions:'position_id'};

/** Caller supplies an already-open SQLite handle. No Db constructor/migrations, writes or config reads. */
export function exportExecutionEvidence(db:DatabaseSync,window:ResearchWindow):ExecutionEvidence {
 if(!Number.isSafeInteger(window.from)||!Number.isSafeInteger(window.asOf)||window.from<0||window.asOf<=window.from||!window.repositoryCommit.trim())throw Error('Explicit increasing UTC window and repository commit required');
 const all=(sql:string,...args:SQLInputValue[])=>db.prepare(sql).all(...args) as Record<string,any>[];
 db.exec('BEGIN');
 try{
  const schema=all("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','index','trigger') ORDER BY type,name");
  const tables=new Set(schema.filter(r=>r.type==='table').map(r=>r.name));
  for(const t of ['positions','trade_policies','evidence_flags','orders'])if(!tables.has(t))throw Error(`Required evidence table missing: ${t}; do not migrate the live DB through this tool`);
  const rows=all(`SELECT p.*,t.strategy_id,t.source_hash,t.snapshot,
   EXISTS(SELECT 1 FROM evidence_flags f WHERE f.position_id=p.id AND f.entry_at=p.entry_at AND f.status='quarantined') quarantined,
   (${eligibleEvidence}) eligible FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id
   WHERE p.status='closed' AND p.exit_at>=? AND p.exit_at<? ORDER BY p.exit_at,p.id`,window.from,window.asOf);
  const policies:Record<string,unknown>={},trades:ResearchTrade[]=[];
  const byPosition=(table:string,foreign='position_id')=>{
   const map=new Map<number,Record<string,any>[]>();if(!tables.has(table))return map;
   for(const r of all(`SELECT a.* FROM ${table} a JOIN positions p ON p.id=a.${foreign} WHERE p.status='closed' AND p.exit_at>=? AND p.exit_at<? ORDER BY p.id,a.rowid`,window.from,window.asOf)){
    const list=map.get(r[foreign])??[];list.push(r);map.set(r[foreign],list);
   }return map;
  };
  const orders=byPosition('orders'),receipts=Object.fromEntries(Object.entries(tablesWithReceipts).map(([t,f])=>[t,byPosition(t,f)]));
  const exitReports=new Map<number,Record<string,any>[]>();
  if(tables.has('paper_exit_reports')&&tables.has('paper_exit_intents'))for(const r of all(`SELECT r.*,i.position_id,i.book,i.reason,i.trigger_at,i.ready_at FROM paper_exit_reports r JOIN paper_exit_intents i ON i.id=r.intent_id JOIN positions p ON p.id=i.position_id WHERE p.status='closed' AND p.exit_at>=? AND p.exit_at<? ORDER BY r.at,r.id`,window.from,window.asOf)){
   const list=exitReports.get(r.position_id)??[];list.push(r);exitReports.set(r.position_id,list);
  }
  for(const row of rows){
   const quality:string[]=[],extra=parse(row.fills),snapshot=parse(row.snapshot),plan=object(extra?.executionPlan)?extra.executionPlan:null;
   const bound=object(snapshot)&&snapshot.version===1&&snapshot.id===row.policy_id&&snapshot.strategyId===row.strategy_id&&snapshot.sourceHash===row.source_hash&&snapshot.scannerId===row.scanner_id&&snapshot.symbol===row.symbol&&snapshot.tf===row.tf&&object(snapshot.paper);
   const planBound=plan&&typeof plan.id==='string'&&typeof plan.signature==='string'&&typeof plan.sourceHash==='string'&&typeof plan.sourceScannerId==='string'&&plan.symbol===row.symbol&&plan.tf===row.tf&&object(plan.paper);
   const policyStatus=row.policy_adopted_at!=null?'adopted':!row.policy_id?(planBound?'plan-bound':'missing'):bound?'bound':'invalid';
   if(policyStatus!=='bound'&&policyStatus!=='plan-bound')quality.push(`policy-${policyStatus}`);
   if(row.policy_id)policies[row.policy_id]=snapshot??{unreadable:true};
   const fills=Array.isArray(extra)?extra:object(extra)&&Array.isArray(extra.fills)?extra.fills:null;
   if(!fills?.length||!fills.every(object))quality.push('fill-ledger-invalid');
   const fs=fills?.filter(object)??[],commission=fs.filter(f=>f.reason!=='funding'),funding=fs.filter(f=>f.reason==='funding');
   const cashCommission=fills?.length?sumKnown(commission,'fee'):null,grossCommission=fills?.length?sumKnown(commission,'feeGross'):null,feeDiscount=fills?.length?sumKnown(commission,'feeDiscount'):null;
   const fundingPnl=fills?.length?sumKnown(funding,'pnl'):null;
   const risk=finite(row.risk_amount)&&row.risk_amount>0?row.risk_amount:null;
   const net=finite(row.realized_pnl)&&finite(row.fees)&&finite(row.realized_pnl-row.fees)?row.realized_pnl-row.fees:null;
   const r=risk&&net!==null&&finite(net/risk)?net/risk:null;
   if(r===null)quality.push('invalid-net-risk');
   const chronology=finite(row.entry_at)&&finite(row.exit_at)&&row.entry_at<=row.exit_at;
   if(!chronology)quality.push('invalid-chronology');
   if(fs.some(f=>!finite(f.at)||f.at<row.entry_at||f.at>row.exit_at))quality.push('fill-outside-position-lifetime');
   if(fs.some(f=>finite(f.at)&&f.at>=window.asOf))quality.push('ledger-observation-after-asof');
   const ledgerFees=fills?sumKnown(fs,'fee'):null,ledgerPnl=fills?sumKnown(fs,'pnl'):null;
   if(ledgerFees!==null&&finite(row.fees)&&Math.abs(ledgerFees-row.fees)>1e-7)quality.push('fees-do-not-reconcile');
   if(ledgerPnl!==null&&finite(row.realized_pnl)&&Math.abs(ledgerPnl-row.realized_pnl)>1e-7)quality.push('pnl-does-not-reconcile');
   const savedOrders=(orders.get(row.id)??[]).filter(o=>o.bt===row.bt&&o.at>=row.entry_at&&o.at<=row.exit_at);
   if((orders.get(row.id)?.length??0)!==savedOrders.length)quality.push('orders-outside-book-or-lifetime');
   const savedReceipts:Record<string,Record<string,any>[]>={};
   for(const [t,map] of Object.entries(receipts))savedReceipts[t]=(map.get(row.id)??[]).filter(x=>x.book===row.bt&&(t!=='entry_execution'||x.entry_at===row.entry_at));
   savedReceipts.paper_exit_reports=(exitReports.get(row.id)??[]).filter(x=>x.book===row.bt&&x.at>=row.entry_at&&x.at<=row.exit_at);
   const rawScope=typeof row.evidence_scope==='string'?row.evidence_scope:'unknown';
   const scope=row.quarantined?'quarantined':plan||row.scanner_id.startsWith('plan:')?'experiment':rawScope;
   const features=object(extra?.features)?extra.features:{};
   const channels=['alert','shape','condition','derived'].filter(c=>features[`src_${c==='condition'?'cond':c}`]>0);
   if(!channels.length)channels.push('unknown');
   const ep=savedReceipts.paper_execution_positions[0];
   trades.push({positionId:row.id,book:row.bt,scope,scannerId:row.scanner_id,symbol:row.symbol,tf:row.tf,side:row.side,
    entryAt:row.entry_at,exitAt:row.exit_at,policyId:row.policy_id??null,strategyId:row.strategy_id??null,sourceHash:row.source_hash??plan?.sourceHash??null,
    policyStatus,planId:plan?.id??null,planSignature:plan?.signature??null,executionVersion:ep?.version??plan?.executionVersion??null,
    quarantined:Boolean(row.quarantined),eligibleByExistingBoundary:Boolean(row.eligible),risk,net,r,holdMinutes:chronology?(row.exit_at-row.entry_at)/60000:null,exitReason:row.exit_reason??null,
    channels,...levelProvenance(row.levels_source,bound?snapshot.paper:plan?.paper),
    costs:{bookedFees:finite(row.fees)?row.fees:null,cashCommission,grossCommission,feeDiscount,fundingPnl,voucherBenefit:null,fundingCoverage:'not-certified'},
    quality,ledger:extra??{invalid:true},orders:savedOrders,receipts:savedReceipts});
  }
  const groups=new Map<string,ResearchTrade[]>();
  for(const t of trades){const key=JSON.stringify([t.scannerId,t.symbol,t.tf,t.book,t.scope,t.policyId,t.planSignature,t.executionVersion]);const g=groups.get(key)??[];g.push(t);groups.set(key,g);}
  const cohorts=[...groups].map(([key,ts])=>{const t=ts[0];return {key,scannerId:t.scannerId,symbol:t.symbol,tf:t.tf,book:t.book,scope:t.scope,policyId:t.policyId,planSignature:t.planSignature,n:ts.length,net:ts.reduce((s,t)=>s+(t.net??0),0),r:ts.reduce((s,t)=>s+(t.r??0),0),validOutcomes:ts.filter(t=>t.r!==null).length,medianHoldMinutes:median(ts.flatMap(t=>t.holdMinutes===null?[]:[t.holdMinutes])),eligibleByExistingBoundary:ts.filter(t=>t.eligibleByExistingBoundary).length};}).sort((a,b)=>a.key.localeCompare(b.key));
  const scopes:Record<string,number>={},qualityIssues:Record<string,number>={};
  for(const t of trades){scopes[t.scope]=(scopes[t.scope]??0)+1;for(const q of t.quality)qualityIssues[q]=(qualityIssues[q]??0)+1;}
  const allocations=tables.has('incubator_pairs')?all('SELECT scanner_id,symbol,tf,stage FROM incubator_pairs ORDER BY scanner_id,symbol,tf'):[];
  const body={policies,trades,cohorts,allocations};
  const result:ExecutionEvidence={schema:1,manifest:{...window,snapshotHash:'',selection:'Closed trades by exit time: from inclusive, asOf exclusive; all books, no silent risk/quality exclusions',schemaHash:digest(schema),producerHash:digest([exportExecutionEvidence.toString(),levelProvenance.toString(),median.toString(),sumKnown.toString(),parse.toString(),finite.toString(),object.toString(),snapshotHash.toString(),digest.toString(),stablePolicy.toString(),eligibleEvidence,tablesWithReceipts]),dataHash:digest(body),scope:'research-only',promotionEligible:false,warnings:[
   'Snapshot of recorded state, not an as-of reconstruction of later corrections. Preserve this file and hash to reproduce the study.',
   'Existing-boundary eligibility is reported, not a promotion decision or a new evidence rule.',
   'Provided level means supplied to the resolver; it does not establish correct author interpretation. Exit ownership is unknown without an explicit amendment receipt.',
   'Funding rows show booked funding only; historical coverage is not certified. Missing fee components and vouchers are null, not zero.',
   'Independent shadow purses cannot be summed into a feasible shared portfolio. No profitability comparison is made across policies or books.'
  ]},...body,summary:{trades:trades.length,scanners:new Set(trades.map(t=>t.scannerId)).size,cells:new Set(trades.map(t=>JSON.stringify([t.scannerId,t.symbol,t.tf]))).size,bookCells:new Set(trades.map(t=>JSON.stringify([t.scannerId,t.symbol,t.tf,t.book]))).size,cohorts:cohorts.length,scopes,medianHoldMinutes:median(trades.flatMap(t=>t.holdMinutes===null?[]:[t.holdMinutes])),eligibleByExistingBoundary:trades.filter(t=>t.eligibleByExistingBoundary).length,qualityIssues}};
  result.manifest.snapshotHash=snapshotHash(result);
  return result;
 }finally{db.exec('ROLLBACK');}
}

/** Bind the whole snapshot, including cutoff, scope and summary, not only trade rows. */
export function snapshotHash(evidence:ExecutionEvidence){
 const {snapshotHash:ignored,...manifest}=evidence.manifest;
 return digest({...evidence,manifest});
}
export function verifyEvidenceSnapshot(evidence:ExecutionEvidence){
 try{return evidence.schema===1&&evidence.manifest.snapshotHash===snapshotHash(evidence)&&evidence.manifest.dataHash===digest({policies:evidence.policies,trades:evidence.trades,cohorts:evidence.cohorts,allocations:evidence.allocations});}catch{return false;}
}
