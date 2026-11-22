/** Per-trade execution equivalence with separate readiness and shadow policy boundaries.
 * Never rewrites the ledger, changes sizing, or treats missing inputs as an empty market. */
import {createHash} from 'node:crypto';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from '../paper/engine.ts';
import {saveTradePolicy,tradePolicyIdFor,stablePolicy,type TradePolicy} from '../paper/tradePolicy.ts';
import {strategyIdFor} from '../paper/strategyIdentity.ts';
import {plotLifecycle} from '../scanners/plotLifecycle.ts';
import {validReadinessPolicy,capacityExpansionCompatible,additionalReadinessCompatibility} from './readinessCompatibility.ts';
import {proveSameReadinessSize} from './readinessSizing.ts';
import {isExecutableTrade,MAX_TRADE_ARRIVAL_MS} from '../execution/tradeFreshness.ts';

export const EXECUTION_REPLAY_VERSION=2;
export interface ExecutionReplayEvent {version:1;receivedAt:number;archiveSequence:number;symbol:string;kind:string;source:string;payload:any}
export interface ExecutionReplayCoverage {from:number;to:number;sha256:string;segments:number;verified:boolean;gaps?:Array<{from:number;to:number}>;selectionWindow?:{symbol:string;from:number;to:number}}
export interface ExecutionReplayResult {
 version:2;positionId:number;entryAt:number;previousId:string;currentId:string;ledgerHash:string;
 outcome:'identical'|'changed'|'unverified';reason:string;inputHash:string;events:number;
 baseline?:unknown;candidate?:unknown;
 extensions?:{funding?:1;quietTape?:1};
}
const hash=(v:unknown)=>createHash('sha256').update(stablePolicy(v)).digest('hex');
const near=(a:any,b:any):boolean=>typeof a==='number'&&typeof b==='number'
 ?Number.isFinite(a)&&Number.isFinite(b)&&(Number.isSafeInteger(a)&&Number.isSafeInteger(b)?a===b:Math.abs(a-b)<=Math.max(1e-9,Math.abs(b)*1e-12))
 :a&&b&&typeof a==='object'&&typeof b==='object'
 ?Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>near(a[k],b[k])):a===b;

/** Normalisation is an ephemeral comparison only. Neither saved policy is changed. */
export function executionPolicyCompatible(db:Db,id:number,previous:TradePolicy,current:TradePolicy):boolean {
 if(!validReadinessPolicy(previous)||!validReadinessPolicy(current)||previous.sim!==211||current.sim!==212)return false;
 const aligned=structuredClone(current);aligned.sim=previous.sim;
 aligned.strategyId=strategyIdFor(aligned);aligned.id=tradePolicyIdFor(aligned);
 if(previous.id===aligned.id||capacityExpansionCompatible(previous,aligned))return true;
 const match=additionalReadinessCompatibility(previous,aligned);
 return match==='scope'||match==='sizing-proof'&&proveSameReadinessSize(db,id,previous,aligned).ok;
}

export function executionReplaySubject(db:Db,id:number){
 const position=db.get<any>('SELECT * FROM positions WHERE id=?',id);
 const intents=db.all<any>('SELECT * FROM paper_exit_intents WHERE position_id=? ORDER BY id',id);
 const reports=db.all<any>('SELECT * FROM paper_exit_reports WHERE intent_id IN (SELECT id FROM paper_exit_intents WHERE position_id=?) ORDER BY at,id',id);
 const state=db.get<any>('SELECT * FROM paper_execution_positions WHERE position_id=?',id);
 const orders=db.all<any>('SELECT * FROM orders WHERE position_id=? ORDER BY id',id);
 // Keep existing no-funding receipts byte compatible. Funding provenance is an
 // additional immutable input only for trades that actually contain settlements.
 let needsFunding=false;try{needsFunding=JSON.parse(position?.fills??'{}').fills?.some((f:any)=>f.reason==='funding');}catch{/* invalid subject is rejected below */}
 let settlements:any[]=[];
 if(needsFunding)try{settlements=db.all('SELECT symbol,at,rate,rate_at,mark,mark_at,status,source FROM funding_settlements WHERE symbol=? AND at>=? AND at<? ORDER BY at',position.symbol,position.entry_at,position.exit_at);}catch{/* no journal is not proof */}
 return {position,intents,reports,state,orders,...(needsFunding?{settlements}:{})};
}
export function executionSubjectHash(subject:ReturnType<typeof executionReplaySubject>){
 const r=subject.position;if(!r)return hash(subject);
 let meta:any;try{meta=JSON.parse(r.fills);}catch{return hash(subject);}
 if(!meta||typeof meta!=='object')return hash(subject);
 // Later ML/feature enrichment and presentation labels cannot change a fill.
 // Keep every field consumed by this replay plus scope, original risk and policy.
 const keys=['id','status','scanner_id','symbol','tf','side','qty','qty_open','contract_value','entry_price','entry_at','sl_original','tp','tp_hit','break_even',
  'realized_pnl','fees','risk_amount','exit_at','exit_price','exit_reason','signal_id','bt','policy_id','policy_adopted_at','evidence_scope','levels_source'];
 const position=Object.fromEntries(keys.map(k=>[k,r[k]??null]));
 position.fills=Object.fromEntries(['fills','legs','leverage','marginLeverage','liqPrice','maintenanceMarginPct','openedAt','basket','executionPlan'].map(k=>[k,meta[k]??null]));
 return hash({...subject,position});
}
export const executionReplayLedgerHash=(db:Db,id:number)=>executionSubjectHash(executionReplaySubject(db,id));

function fundingProven(subject:ReturnType<typeof executionReplaySubject>):boolean {
 const {position:r,orders,settlements}=subject,fs=JSON.parse(r.fills).fills.filter((f:any)=>f.reason==='funding');
 if(!fs.length)return true;
 const meta=JSON.parse(r.fills);
 if(meta.basket||!settlements||settlements.some(s=>s.status!=='applied')||new Set(fs.map((f:any)=>f.at)).size!==fs.length)return false;
 for(const f of fs){
  const s=settlements?.find(s=>s.at===f.at),o=orders.find(o=>o.id===f.orderId&&o.reason==='funding');
  if(!s||s.status!=='applied'||s.source!=='observed-websocket'||!Number.isFinite(s.rate)||!(s.mark>0)||
   !Number.isFinite(s.rate_at)||s.rate_at>s.at||s.at-s.rate_at>120000||!Number.isFinite(s.mark_at)||Math.abs(s.mark_at-s.at)>10000||
   f.at<r.entry_at||f.at>=r.exit_at||f.qty!==0||f.fee!==0||!near(f.price,s.mark)||
   !near(f.pnl,-(s.rate/100)*(s.mark*r.qty*r.contract_value)*(r.side==='long'?1:-1))||
   !o||o.bt!==r.bt||o.at!==f.at||o.qty!==0||o.fee!==0||!near(o.price,f.price))return false;
 }
 // No applied settlement may be omitted from a funding-enabled trade.
 return settlements!.filter(s=>s.status==='applied').length===fs.length;
}

function run(subject:ReturnType<typeof executionReplaySubject>,policy:TradePolicy,events:ExecutionReplayEvent[],entryBoundary=Infinity){
 const {position:r,reports,state}=subject,meta=JSON.parse(r.fills),entry=meta.fills[0];
 const db=new Db(':memory:');let now=r.entry_at;
 try{
  saveTradePolicy(db,policy);
  const row={...r,signal_id:null,status:'open',qty_open:r.qty,sl:r.sl_original,tp_hit:JSON.stringify(JSON.parse(r.tp).map(()=>false)),
   break_even:0,realized_pnl:0,fees:entry.fee,exit_at:null,exit_price:null,exit_reason:null,peak_r:0,peak_at:r.entry_at,worst_r:0,worst_at:r.entry_at,policy_id:policy.id,
   fills:JSON.stringify({...meta,fills:[entry],lastPriceBar:undefined,peakR:0,trailOff:undefined,trailArmedAt:undefined,trailPeakR:undefined,trailPeakAt:undefined})};
  const columns=Object.keys(row);db.run(`INSERT INTO positions (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`,...columns.map(k=>row[k]??null));
  const cfg=structuredClone(DEFAULT_CONFIG);cfg.execution.mode='paper';
  const engine=new PaperEngine(db,()=>cfg,{book:r.bt,now:()=>now});engine.causalExits=true;
  const held=engine.openPositions()[0];engine.exitExecution.register(held,state.market_qty);
  for(const e of events){
   now=e.receivedAt;if(now>r.exit_at)continue;
   // Pre-roll only seeds tape ordering/liveness. It cannot act on this position.
   if(e.kind==='trade'&&e.source==='execution-feed'&&isExecutableTrade(e.payload,now)){
    // The print that created a maker position did not also evaluate its exit.
    if(now<r.entry_at||now===r.entry_at&&e.archiveSequence<entryBoundary)held.entryAt=Infinity;
    engine.onTrade(r.symbol,e.payload.price,e.payload.qty,e.payload.timeMs,now,e.payload.id);
    held.entryAt=r.entry_at;
   }
   // Seed marks before entry too; applyMark itself rejects pre-entry liquidation.
   if(e.kind==='mark'&&e.source==='execution-feed'){
    if(now<r.entry_at||now===r.entry_at&&e.archiveSequence<entryBoundary)held.entryAt=Infinity;
    engine.onMarkPrice(r.symbol,e.payload.markPrice,e.payload.timeMs);held.entryAt=r.entry_at;
   }
   if(now<r.entry_at||now===r.entry_at&&e.archiveSequence<entryBoundary)continue;
   if(e.kind==='paper_bar'&&e.source==='paper-input'&&e.payload.book===r.bt)engine.onBar(r.symbol,e.payload.bar,now,{historical:e.payload.historical});
  }
  for(const report of reports){
   now=report.at;const depth=JSON.parse(report.depth);
   if(depth.consumedQty)db.run('INSERT INTO paper_exit_liquidity VALUES(?,?,?,?,?,?)',r.bt===2?`2:${r.id}`:'0',r.symbol,r.side,report.book_key,depth.consumedQty,now);
   engine.settleExits(r.symbol,depth,now);
  }
  // Supported SL/trail rules use price and original stop risk, not funding P&L.
  // Reconcile the independently verified settlements after price replay. A
  // different close changes exposure to the settlement and therefore net P&L.
  for(const s of subject.settlements??[])if(s.status==='applied')engine.reconcileFunding(r.symbol,s.rate,s.mark,s.at);
  return {intent:db.all('SELECT reason,trigger_at,ready_at,reference,qty,market_qty FROM paper_exit_intents ORDER BY id'),
   trade:engine.trades({limit:1}).map(t=>({exitAt:t.exitAt,exitPrice:t.exitPrice,exitReason:t.exitReason,net:t.pnl,fees:t.fees,qty:t.qty})),
   open:engine.openPositions().map(p=>({sl:p.sl,qty:p.qtyOpen}))};
 }finally{db.db.close();}
}

/** Input must come from checksum-verified, consecutive sealed segments in archive order.
 * Single-entry, single depth exit, with independently verified funding only.
 * Script amendments, partial fills,
 * baskets, restart gaps and external context-dependent exits need dedicated replayers. */
export function replayReadinessExecution(db:Db,id:number,previous:TradePolicy,current:TradePolicy,events:ExecutionReplayEvent[],coverage:ExecutionReplayCoverage):ExecutionReplayResult {
 return replayExecution(db,id,previous,current,events,coverage,0,executionPolicyCompatible(db,id,previous,current));
}

/** Book-explicit kernel. Callers supply their own policy boundary; account readiness
 * exceptions are never inherited by shadow qualification. */
export function replayExecution(db:Db,id:number,previous:TradePolicy,current:TradePolicy,events:ExecutionReplayEvent[],coverage:ExecutionReplayCoverage,book:0|2,compatible:boolean):ExecutionReplayResult {
 const subject=executionReplaySubject(db,id),r=subject.position;
 const result:ExecutionReplayResult={version:2,positionId:id,entryAt:r?.entry_at??0,previousId:previous.id,currentId:current.id,ledgerHash:executionSubjectHash(subject),
  outcome:'unverified',reason:'unsupported-lifecycle',inputHash:hash({coverage,events}),events:events.length};
 const refuse=(reason:string)=>({...result,reason});
 try{
  if(!compatible)return refuse('other-policy-differences');
  if(!r||r.bt!==book||!(book===0?r.evidence_scope==='account':['shadow','legacy-shadow'].includes(r.evidence_scope))||r.policy_adopted_at!=null||r.policy_id!==previous.id||r.status!=='closed'||
   r.symbol!==previous.symbol||r.tf!==previous.tf||r.scanner_id!==previous.scannerId||!Number.isFinite(r.risk_amount)||r.risk_amount<=0)return result;
  if(db.get("SELECT 1 FROM evidence_flags WHERE position_id=? AND entry_at=? AND status='quarantined'",id,r.entry_at))return refuse('quarantined');
  const meta=JSON.parse(r.fills),pc=previous.paper,fs=meta.fills.filter((f:any)=>f.reason!=='funding');
  if(meta.basket||meta.executionPlan||fs.length!==2||fs[0].reason!=='entry'||fs[0].qty!==r.qty||fs[0].at!==r.entry_at||fs[0].price!==r.entry_price||
   fs[1].qty!==r.qty||!['sl','trail'].includes(r.exit_reason)||subject.intents.length!==1||subject.reports.length!==1||!subject.state||subject.state.version!==211||
   !Number.isSafeInteger(r.qty)||r.qty<=0||!(r.sl_original>0)||pc.trailAtrMult||pc.structureTrail?.enabled||pc.trendExit?.enabled||pc.earlyCut||pc.earlyStall||
   (previous.reading.reader??1)>=3||plotLifecycle(previous.scannerId))return result;
  if(meta.fills.length!==fs.length){
   if(pc.fundingCharges===false||!fundingProven(subject))return refuse('funding-unverified');
   result.extensions={funding:1};
  }
  const intent=subject.intents[0],report=subject.reports[0];
  if(intent.status!=='filled'||intent.book!==book||intent.qty!==r.qty||intent.filled_qty!==r.qty||intent.market_filled!==intent.market_qty||
   report.qty!==r.qty||report.at!==r.exit_at||report.price!==r.exit_price||fs[1].at!==r.exit_at||fs[1].reason!==r.exit_reason)return result;
  if(!coverage.verified||!Number.isSafeInteger(coverage.segments)||coverage.segments<1||! /^[a-f0-9]{64}$/.test(coverage.sha256)||coverage.from>r.entry_at-60000||coverage.to<r.exit_at)return refuse('archive-coverage');
  const selected=coverage.selectionWindow;
  if(selected&&(selected.symbol!==r.symbol||!Number.isFinite(selected.from)||!Number.isFinite(selected.to)||selected.from>r.entry_at-60000||selected.to<r.exit_at))return refuse('archive-coverage');
  if(coverage.gaps?.some(g=>!Number.isFinite(g.from)||!Number.isFinite(g.to)||g.from>g.to||g.from<=r.exit_at&&g.to>=r.entry_at-60000))return refuse('archive-gap');
  let sequence=-1;let lastAt=-Infinity;let seeded=false;let maxExchange=-Infinity;let activeUntil=-Infinity;let fallbackObserved=false;
  for(const e of events){
   if(e.version!==1||!Number.isSafeInteger(e.archiveSequence)||e.archiveSequence<=sequence||!Number.isFinite(e.receivedAt)||e.receivedAt<lastAt||
    ![r.symbol,'*'].includes(e.symbol)||e.receivedAt<r.entry_at-60000||e.receivedAt>r.exit_at)return refuse('input-order');
   sequence=e.archiveSequence;lastAt=e.receivedAt;
   if(e.kind==='gap'&&(e.source==='archive'||book===2&&e.source==='execution-feed'))return refuse('archive-gap');
   if(e.kind==='selection'&&(e.payload.added?.includes(r.symbol)||e.payload.removed?.includes(r.symbol))&&e.receivedAt>r.entry_at-60000)return refuse('selection-gap');
   if(e.symbol!==r.symbol)continue;
   if(e.kind==='trade'&&e.source==='execution-feed'&&isExecutableTrade(e.payload,e.receivedAt)&&e.payload.timeMs>=maxExchange){
    maxExchange=e.payload.timeMs;activeUntil=e.receivedAt+(pc.tapeFallbackMs??5000);if(e.receivedAt<r.entry_at)seeded=true;
   }
   if(e.kind==='paper_bar'&&e.payload.book===book&&e.source==='paper-input'&&e.receivedAt>=r.entry_at&&!e.payload.historical&&e.receivedAt>activeUntil)fallbackObserved=true;
  }
  if(!seeded){
   // A complete quiet interval can establish an inactive tape without inventing
   // a seed print. A prior mark proves capture was selected for this symbol.
   // The interval also exceeds the accepted 5s-old / 2s-future trade clocks, so
   // an unseen older print cannot reorder a valid post-entry print.
   const w=coverage.selectionWindow,quietMs=Math.max(pc.tapeFallbackMs??5000,MAX_TRADE_ARRIVAL_MS+2000)+1;
   const witness=events.some(e=>e.symbol===r.symbol&&e.kind==='mark'&&e.source==='execution-feed'&&
    e.receivedAt<=r.entry_at-quietMs&&e.payload.markPrice>0&&Number.isFinite(e.payload.timeMs));
   if(!w||w.symbol!==r.symbol||w.from>r.entry_at-60000||w.to<r.exit_at||!witness)return refuse('missing-tape-preroll');
   result.extensions={...result.extensions,quietTape:1};
  }
  if(events.filter(e=>e.kind==='trade'&&e.source==='execution-feed'&&e.receivedAt===r.entry_at).length>1)return refuse('entry-order-ambiguity');
  // Require actual candle callbacks, even when none ultimately triggered an exit.
  if(!events.some(e=>e.kind==='paper_bar'&&e.source==='paper-input'&&e.payload.book===book&&e.receivedAt>=r.entry_at))return refuse('missing-candle-inputs');
  const input=events.filter(e=>e.symbol===r.symbol);
  const baseline=run(subject,previous,input),candidate=run(subject,current,input);
  const observed={intent:subject.intents.map(({reason,trigger_at,ready_at,reference,qty,market_qty})=>({reason,trigger_at,ready_at,reference,qty,market_qty})),
   trade:[{exitAt:r.exit_at,exitPrice:r.exit_price,exitReason:r.exit_reason,net:r.realized_pnl-r.fees,fees:r.fees,qty:r.qty}],open:[]};
  result.baseline=baseline;result.candidate=candidate;
  if(!near(baseline,observed))return {...result,reason:'baseline-mismatch'};
  if(near(candidate,observed)){
   // Receipt clocks do not identify where entry committed inside the same ms.
   // Test every possible boundary in archive order, including the entry candle's
   // post-fill callback. Credit only if every boundary reproduces the ledger.
   const boundaries=input.filter(e=>e.receivedAt===r.entry_at&&['trade','mark','paper_bar'].includes(e.kind)).map(e=>e.archiveSequence);
   for(const boundary of boundaries){
    if(!near(run(subject,previous,input,boundary),observed)||!near(run(subject,current,input,boundary),observed))
     return {...result,reason:'entry-boundary-sensitive'};
   }
  }
  return {...result,outcome:near(candidate,observed)?'identical':'changed',reason:near(candidate,observed)?'same-execution':fallbackObserved?'candle-or-amendment-changed':'amendment-changed'};
 }catch{return refuse('invalid-replay-input');}
}

/** The ops replay writes only a separate audit receipt; all trade facts stay immutable. */
export function recordExecutionReplay(db:Db,result:ExecutionReplayResult,at=Date.now()){
 if(result.version!==EXECUTION_REPLAY_VERSION||result.ledgerHash!==executionReplayLedgerHash(db,result.positionId))throw Error('replay subject changed');
 db.run('INSERT INTO readiness_execution_replays VALUES(?,?,?,?,?) ON CONFLICT(position_id,entry_at,policy_id) DO UPDATE SET recorded_at=excluded.recorded_at,result=excluded.result',
  result.positionId,result.entryAt,result.currentId,at,JSON.stringify(result));
}

/** Stored receipt is valid only for this exact ledger, target policy and replay algorithm. */
export function executionReplayEvidence(db:Db,id:number,previous:TradePolicy,current:TradePolicy):'identical'|'changed'|'unverified'|null {
 try{
  const row=db.get<{entry_at:number;result:string}>('SELECT entry_at,result FROM readiness_execution_replays WHERE position_id=? AND policy_id=?',id,current.id);
  if(!row)return null;
  const proof=JSON.parse(row.result) as ExecutionReplayResult,subject=executionReplaySubject(db,id),r=subject.position;
  if(!r||row.entry_at!==r.entry_at||proof.entryAt!==r.entry_at||proof.positionId!==id||proof.version!==EXECUTION_REPLAY_VERSION||
   proof.previousId!==previous.id||proof.currentId!==current.id||proof.ledgerHash!==executionSubjectHash(subject)||! /^[a-f0-9]{64}$/.test(proof.inputHash)||
   !executionPolicyCompatible(db,id,previous,current))return null;
  if(proof.outcome==='changed'||proof.outcome==='unverified')return proof.outcome;
  return validIdenticalExecution(proof,subject)?'identical':null;
 }catch{return null;}
}

/** Shared receipt integrity, always bound to the immutable original ledger. */
export function validIdenticalExecution(proof:ExecutionReplayResult,subject:ReturnType<typeof executionReplaySubject>):boolean {
 const r=subject.position;
 if(!r)return false;
  const observed={intent:subject.intents.map(({reason,trigger_at,ready_at,reference,qty,market_qty})=>({reason,trigger_at,ready_at,reference,qty,market_qty})),
   trade:[{exitAt:r.exit_at,exitPrice:r.exit_price,exitReason:r.exit_reason,net:r.realized_pnl-r.fees,fees:r.fees,qty:r.qty}],open:[]};
  return proof.outcome==='identical'&&proof.reason==='same-execution'&&proof.events>0&&near(proof.baseline,observed)&&near(proof.candidate,observed);
}
