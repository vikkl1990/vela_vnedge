/** Readiness-only, per-trade execution equivalence. Never rewrites the original ledger,
 * promotes a scanner, changes sizing, or treats missing inputs as an empty market. */
import {createHash} from 'node:crypto';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from '../paper/engine.ts';
import {saveTradePolicy,tradePolicyIdFor,stablePolicy,type TradePolicy} from '../paper/tradePolicy.ts';
import {strategyIdFor} from '../paper/strategyIdentity.ts';
import {plotLifecycle} from '../scanners/plotLifecycle.ts';
import {validReadinessPolicy,capacityExpansionCompatible,additionalReadinessCompatibility} from './readinessCompatibility.ts';
import {proveSameReadinessSize} from './readinessSizing.ts';
import {isExecutableTrade} from '../execution/tradeFreshness.ts';

export const EXECUTION_REPLAY_VERSION=1;
export interface ExecutionReplayEvent {version:1;receivedAt:number;archiveSequence:number;symbol:string;kind:string;source:string;payload:any}
export interface ExecutionReplayCoverage {from:number;to:number;sha256:string;segments:number;verified:boolean;gaps?:Array<{from:number;to:number}>}
export interface ExecutionReplayResult {
 version:1;positionId:number;entryAt:number;previousId:string;currentId:string;ledgerHash:string;
 outcome:'identical'|'changed'|'unverified';reason:string;inputHash:string;events:number;
 baseline?:unknown;candidate?:unknown;
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
 return {position,intents,reports,state,orders};
}
export const executionReplayLedgerHash=(db:Db,id:number)=>hash(executionReplaySubject(db,id));

function run(subject:ReturnType<typeof executionReplaySubject>,policy:TradePolicy,events:ExecutionReplayEvent[]){
 const {position:r,reports,state}=subject,meta=JSON.parse(r.fills),entry=meta.fills[0];
 const db=new Db(':memory:');let now=r.entry_at;
 try{
  saveTradePolicy(db,policy);
  const row={...r,signal_id:null,status:'open',qty_open:r.qty,sl:r.sl_original,tp_hit:JSON.stringify(JSON.parse(r.tp).map(()=>false)),
   break_even:0,realized_pnl:0,fees:entry.fee,exit_at:null,exit_price:null,exit_reason:null,peak_r:0,peak_at:r.entry_at,worst_r:0,worst_at:r.entry_at,policy_id:policy.id,
   fills:JSON.stringify({...meta,fills:[entry],lastPriceBar:undefined,peakR:0,trailOff:undefined,trailArmedAt:undefined,trailPeakR:undefined,trailPeakAt:undefined})};
  const columns=Object.keys(row);db.run(`INSERT INTO positions (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`,...columns.map(k=>row[k]??null));
  const cfg=structuredClone(DEFAULT_CONFIG);cfg.execution.mode='paper';
  const engine=new PaperEngine(db,()=>cfg,{now:()=>now});engine.causalExits=true;
  const held=engine.openPositions()[0];engine.exitExecution.register(held,state.market_qty);
  for(const e of events){
   now=e.receivedAt;if(now>r.exit_at)continue;
   // Pre-roll only seeds tape ordering/liveness. It cannot act on this position.
   if(e.kind==='trade'&&e.source==='execution-feed'&&isExecutableTrade(e.payload,now)){
    // The print that created a maker position did not also evaluate its exit.
    if(now===r.entry_at)held.entryAt=r.entry_at+1;
    engine.onTrade(r.symbol,e.payload.price,e.payload.qty,e.payload.timeMs,now,e.payload.id);
    held.entryAt=r.entry_at;
   }
   if(now<=r.entry_at)continue;
   if(e.kind==='mark'&&e.source==='execution-feed')engine.onMarkPrice(r.symbol,e.payload.markPrice,e.payload.timeMs);
   if(e.kind==='paper_bar'&&e.source==='paper-input'&&e.payload.book===0)engine.onBar(r.symbol,e.payload.bar,now,{historical:e.payload.historical});
  }
  for(const report of reports){
   now=report.at;const depth=JSON.parse(report.depth);
   if(depth.consumedQty)db.run('INSERT INTO paper_exit_liquidity VALUES(?,?,?,?,?,?)','0',r.symbol,r.side,report.book_key,depth.consumedQty,now);
   engine.settleExits(r.symbol,depth,now);
  }
  return {intent:db.all('SELECT reason,trigger_at,ready_at,reference,qty,market_qty FROM paper_exit_intents ORDER BY id'),
   trade:engine.trades({limit:1}).map(t=>({exitAt:t.exitAt,exitPrice:t.exitPrice,exitReason:t.exitReason,net:t.pnl,fees:t.fees,qty:t.qty})),
   open:engine.openPositions().map(p=>({sl:p.sl,qty:p.qtyOpen}))};
 }finally{db.db.close();}
}

/** Input must come from checksum-verified, consecutive sealed segments in archive order.
 * Single-entry, single depth exit only. Script amendments, funding, partial fills,
 * baskets, restart gaps and external context-dependent exits need dedicated replayers. */
export function replayReadinessExecution(db:Db,id:number,previous:TradePolicy,current:TradePolicy,events:ExecutionReplayEvent[],coverage:ExecutionReplayCoverage):ExecutionReplayResult {
 const subject=executionReplaySubject(db,id),r=subject.position;
 const result:ExecutionReplayResult={version:1,positionId:id,entryAt:r?.entry_at??0,previousId:previous.id,currentId:current.id,ledgerHash:hash(subject),
  outcome:'unverified',reason:'unsupported-lifecycle',inputHash:hash({coverage,events}),events:events.length};
 const refuse=(reason:string)=>({...result,reason});
 try{
  if(!executionPolicyCompatible(db,id,previous,current))return refuse('other-policy-differences');
  if(!r||r.bt!==0||r.evidence_scope!=='account'||r.policy_adopted_at!=null||r.policy_id!==previous.id||r.status!=='closed'||
   r.symbol!==previous.symbol||r.tf!==previous.tf||r.scanner_id!==previous.scannerId||!Number.isFinite(r.risk_amount)||r.risk_amount<=0)return result;
  if(db.get("SELECT 1 FROM evidence_flags WHERE position_id=? AND entry_at=? AND status='quarantined'",id,r.entry_at))return refuse('quarantined');
  const meta=JSON.parse(r.fills),pc=previous.paper,fs=meta.fills;
  if(meta.basket||meta.executionPlan||fs.length!==2||fs[0].reason!=='entry'||fs[0].qty!==r.qty||fs[0].at!==r.entry_at||fs[0].price!==r.entry_price||
   fs[1].qty!==r.qty||!['sl','trail'].includes(r.exit_reason)||subject.intents.length!==1||subject.reports.length!==1||!subject.state||subject.state.version!==211||
   !Number.isSafeInteger(r.qty)||r.qty<=0||!(r.sl_original>0)||pc.trailAtrMult||pc.structureTrail?.enabled||pc.trendExit?.enabled||pc.earlyCut||pc.earlyStall||
   (previous.reading.reader??1)>=3||plotLifecycle(previous.scannerId))return result;
  const intent=subject.intents[0],report=subject.reports[0];
  if(intent.status!=='filled'||intent.book!==0||intent.qty!==r.qty||intent.filled_qty!==r.qty||intent.market_filled!==intent.market_qty||
   report.qty!==r.qty||report.at!==r.exit_at||report.price!==r.exit_price||fs[1].at!==r.exit_at||fs[1].reason!==r.exit_reason)return result;
  if(!coverage.verified||!Number.isSafeInteger(coverage.segments)||coverage.segments<1||! /^[a-f0-9]{64}$/.test(coverage.sha256)||coverage.from>r.entry_at-60000||coverage.to<r.exit_at)return refuse('archive-coverage');
  if(coverage.gaps?.some(g=>!Number.isFinite(g.from)||!Number.isFinite(g.to)||g.from>g.to||g.from<=r.exit_at&&g.to>=r.entry_at-60000))return refuse('archive-gap');
  let sequence=-1;let lastAt=-Infinity;let seeded=false;let maxExchange=-Infinity;let activeUntil=-Infinity;let fallbackObserved=false;
  for(const e of events){
   if(e.version!==1||!Number.isSafeInteger(e.archiveSequence)||e.archiveSequence<=sequence||!Number.isFinite(e.receivedAt)||e.receivedAt<lastAt||
    ![r.symbol,'*'].includes(e.symbol)||e.receivedAt<r.entry_at-60000||e.receivedAt>r.exit_at)return refuse('input-order');
   sequence=e.archiveSequence;lastAt=e.receivedAt;
   if(e.kind==='gap'&&e.source==='archive')return refuse('archive-gap');
   if(e.kind==='selection'&&(e.payload.added?.includes(r.symbol)||e.payload.removed?.includes(r.symbol))&&e.receivedAt>r.entry_at-60000)return refuse('selection-gap');
   if(e.symbol!==r.symbol)continue;
   if(e.kind==='trade'&&e.source==='execution-feed'&&isExecutableTrade(e.payload,e.receivedAt)&&e.payload.timeMs>=maxExchange){
    maxExchange=e.payload.timeMs;activeUntil=e.receivedAt+(pc.tapeFallbackMs??5000);if(e.receivedAt<r.entry_at)seeded=true;
   }
   if(e.kind==='paper_bar'&&e.payload.book===0&&e.source==='paper-input'&&e.receivedAt>=r.entry_at&&!e.payload.historical&&e.receivedAt>activeUntil)fallbackObserved=true;
  }
  if(!seeded)return refuse('missing-tape-preroll');
  if(events.filter(e=>e.kind==='trade'&&e.source==='execution-feed'&&e.receivedAt===r.entry_at).length>1)return refuse('entry-order-ambiguity');
  // Require actual candle callbacks, even when none ultimately triggered an exit.
  if(!events.some(e=>e.kind==='paper_bar'&&e.source==='paper-input'&&e.payload.book===0&&e.receivedAt>=r.entry_at))return refuse('missing-candle-inputs');
  const input=events.filter(e=>e.symbol===r.symbol);
  const baseline=run(subject,previous,input),candidate=run(subject,current,input);
  const observed={intent:subject.intents.map(({reason,trigger_at,ready_at,reference,qty,market_qty})=>({reason,trigger_at,ready_at,reference,qty,market_qty})),
   trade:[{exitAt:r.exit_at,exitPrice:r.exit_price,exitReason:r.exit_reason,net:r.realized_pnl-r.fees,fees:r.fees,qty:r.qty}],open:[]};
  result.baseline=baseline;result.candidate=candidate;
  if(!near(baseline,observed))return {...result,reason:'baseline-mismatch'};
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
   proof.previousId!==previous.id||proof.currentId!==current.id||proof.ledgerHash!==hash(subject)||! /^[a-f0-9]{64}$/.test(proof.inputHash)||
   !executionPolicyCompatible(db,id,previous,current))return null;
  if(proof.outcome==='changed'||proof.outcome==='unverified')return proof.outcome;
  const observed={intent:subject.intents.map(({reason,trigger_at,ready_at,reference,qty,market_qty})=>({reason,trigger_at,ready_at,reference,qty,market_qty})),
   trade:[{exitAt:r.exit_at,exitPrice:r.exit_price,exitReason:r.exit_reason,net:r.realized_pnl-r.fees,fees:r.fees,qty:r.qty}],open:[]};
  return proof.outcome==='identical'&&proof.reason==='same-execution'&&proof.events>0&&near(proof.baseline,observed)&&near(proof.candidate,observed)?'identical':null;
 }catch{return null;}
}
