import {depthFill} from '../paper/entryExecution.ts';
import {walkBook} from './marketGate.ts';
import {admissionCostPct} from '../paper/costs.ts';
/** Cost eligibility of an actual integer contract quantity on timestamped depth. */
export function freshDepthGate(inp:{now:number;deadlineAt?:number;receivedAt:number;exchangeAt:number;maxAgeMs:number;qty:number;contractValue:number;maker?:boolean;book:{bids:Array<[number,number]>;asks:Array<[number,number]>}|null;maxCostPct:number;fees:{feeRatePct:number;makerFeeRatePct?:number;feeTaxPct:number}}){
 const fail=(reason:string)=>({allowed:false,reason,notional:null as number|null,costPct:null as number|null});
 if(inp.deadlineAt!==undefined&&inp.now>=inp.deadlineAt)return fail('signal expired while waiting');
 if(!Number.isFinite(inp.now)||!Number.isFinite(inp.maxAgeMs)||inp.maxAgeMs<=0)return fail('invalid freshness policy');
 for(const at of [inp.receivedAt,inp.exchangeAt]){
  if(!Number.isFinite(at)||at<=0)return fail('missing depth timestamp');
  if(at>inp.now+2000)return fail('future depth timestamp');
  if(inp.now-at>inp.maxAgeMs)return fail('stale depth');
 }
 if(!Number.isInteger(inp.qty)||inp.qty<=0||!Number.isFinite(inp.contractValue)||inp.contractValue<=0)return fail('invalid contract quantity');
 if(!Number.isFinite(inp.maxCostPct)||inp.maxCostPct<=0)return fail('invalid cost ceiling');
 if(!Number.isFinite(inp.fees.feeRatePct)||inp.fees.feeRatePct<0||!Number.isFinite(inp.fees.feeTaxPct)||inp.fees.feeTaxPct<0)return fail('invalid fees');
 const b=inp.book;
 if(!b||!b.bids.length||!b.asks.length)return fail('missing depth');
 if([...b.bids,...b.asks].some(([p,q])=>!Number.isFinite(p)||p<=0||!Number.isFinite(q)||q<=0))return fail('malformed depth');
 const bid=Math.max(...b.bids.map(l=>l[0])),ask=Math.min(...b.asks.map(l=>l[0]));
 if(bid>ask)return fail('crossed depth');
 const notional=inp.qty*inp.contractValue*(bid+ask)/2;
 const w=walkBook(b,notional);
 if(!w||!w.deep)return {...fail('insufficient depth'),notional};
 const costPct=admissionCostPct(inp.fees,w.crossPct,{maker:inp.maker});
 return {allowed:costPct<=inp.maxCostPct,reason:costPct<=inp.maxCostPct?'passes cost gate':'cost exceeds ceiling',notional,costPct,crossingPct:w.crossPct};
}

import type {AppConfig} from '../config.ts';
import {toMs} from '../delta/ws.ts';
export interface EntryDepthRequest {symbol:string;qty:number;contractValue:number;maker?:boolean;at:number;book?:number;virtualQty?:number}
type RawBook={buy:Array<{price:string|number;size:string|number}>;sell:Array<{price:string|number;size:string|number}>;timestamp?:unknown;last_updated_at?:unknown};
/** Bounded public reads, coalesced per symbol; checks always use the final sized quantity. */
export class EntryDepthGate {
 private cache=new Map<string,{receivedAt:number;exchangeAt:number;book:RawBook}>();
 private pending=new Map<string,Promise<void>>();
 private queue:Array<{symbol:string;urgent:boolean;run:()=>void}>=[];private active=0;private background=0;
 readonly counts={requests:0,errors:0,checks:0,blocked:0};
 private last:Array<Record<string,unknown>>=[];
 constructor(deps:{cfg:()=>AppConfig;book:(symbol:string)=>Promise<RawBook>;now?:()=>number;save?:(state:unknown)=>void}){this.deps=deps;}
 private deps:{cfg:()=>AppConfig;book:(symbol:string)=>Promise<RawBook>;now?:()=>number;save?:(state:unknown)=>void};
 private now(){return this.deps.now?.()??Date.now();}
 enabled(symbol?:string){const m=this.deps.cfg().risk.marketGate;return !!(m?.enabled&&m.freshDepth&&(m.maxBookCostPct??0)>0&&(!symbol||!m.exempt?.includes(symbol)));}
 get stats(){return {enabled:this.enabled(),...this.counts,inFlight:this.active,queued:this.queue.length,last:this.last};}
 async prepare(symbol:string,urgent=false):Promise<void>{
  if(!this.enabled(symbol))return;
  const old=this.cache.get(symbol),now=this.now();
  if(old&&now-old.receivedAt<Math.min(2000,this.deps.cfg().paper.quoteMaxAgeMs)&&now-old.exchangeAt<Math.min(2000,this.deps.cfg().paper.quoteMaxAgeMs)&&old.exchangeAt<=now+2000)return;
  const existing=this.pending.get(symbol);if(existing){if(urgent){const job=this.queue.find(j=>j.symbol===symbol);if(job)job.urgent=true;}return existing;}
  if(this.queue.length>=(urgent?120:100)){this.cache.delete(symbol);this.counts.errors++;return;}
  const task=new Promise<void>(resolve=>{const job={symbol,urgent,run:()=>{
   this.active++;if(!job.urgent)this.background++;this.counts.requests++;
   void Promise.resolve().then(()=>this.deps.book(symbol)).then(book=>{
    if(!book||!Array.isArray(book.buy)||!Array.isArray(book.sell))throw Error('malformed depth response');
    this.cache.set(symbol,{book,receivedAt:this.now(),exchangeAt:toMs(book.timestamp??book.last_updated_at,0)});
   }).catch(()=>{this.cache.delete(symbol);this.counts.errors++;}).finally(()=>{this.active--;if(!job.urgent)this.background--;this.pending.delete(symbol);resolve();this.drain();});
  }};this.queue.push(job);});
  this.pending.set(symbol,task);this.drain();return task;
 }
 private drain(){while(this.active<4&&this.queue.length){let i=this.queue.findIndex(j=>j.urgent);if(i<0){if(this.background>=2)break;i=0;}this.queue.splice(i,1)[0].run();}}
 executionPrice(symbol:string,side:'long'|'short',qty:number):{price?:number;reject?:string}{
  const snapshot=this.cache.get(symbol),now=this.now(),maxAge=this.deps.cfg().paper.quoteMaxAgeMs;
  if(!snapshot||!(maxAge>0)||[snapshot.receivedAt,snapshot.exchangeAt].some(t=>!Number.isFinite(t)||t<=0||t>now+2000||now-t>maxAge))return {reject:'fresh execution depth unavailable'};
  const b=snapshot.book;
  if(!b.buy.length||!b.sell.length||[...b.buy,...b.sell].some(l=>!Number.isFinite(Number(l.price))||Number(l.price)<=0||!Number.isFinite(Number(l.size))||Number(l.size)<=0))return {reject:'malformed execution depth'};
  if(Math.max(...b.buy.map(l=>Number(l.price)))>Math.min(...b.sell.map(l=>Number(l.price))))return {reject:'crossed execution depth'};
  const f=depthFill(side==='long'?b.sell:b.buy,qty,side);
  return f.coverage>=1&&f.vwap!==null?{price:f.vwap}:{reject:'insufficient execution depth'};
 }
 check(req:EntryDepthRequest):{reject?:string;crossingPct?:number}{
  if(!this.enabled(req.symbol))return {};
  const c=this.deps.cfg(),snapshot=this.cache.get(req.symbol),at=this.now();
  const side=(ls:RawBook['buy'])=>ls.map(l=>[Number(l.price),Number(l.size)*req.contractValue]as[number,number]);
  const result=freshDepthGate({now:at,receivedAt:snapshot?.receivedAt??0,exchangeAt:snapshot?.exchangeAt??0,maxAgeMs:c.paper.quoteMaxAgeMs,qty:req.qty,contractValue:req.contractValue,maker:req.maker,book:snapshot?{bids:side(snapshot.book.buy??[]),asks:side(snapshot.book.sell??[])}:null,maxCostPct:c.risk.marketGate!.maxBookCostPct!,fees:{...c.paper,feeTaxPct:c.paper.feeTaxPct??0}});
  this.counts.checks++;if(!result.allowed)this.counts.blocked++;
  this.last=[{at,symbol:req.symbol,qty:req.qty,book:req.book??null,virtualQty:req.virtualQty??null,maker:!!req.maker,...result},...this.last].slice(0,30);
  try{this.deps.save?.(this.stats);}catch{/* advisory telemetry cannot affect entry eligibility */}
  return result.allowed&&'crossingPct'in result?{crossingPct:result.crossingPct}:{reject:`risk market: fresh depth ${result.reason}${result.costPct!==null?` (${result.costPct.toFixed(3)}% for $${result.notional!.toFixed(0)})`:''}`};
 }
}

import type {PaperEngine} from '../paper/engine.ts';
/** Shadow dollars are synthetic. Test depth at a deployable account-equivalent quantity, never its research purse. */
export function wireEntryDepth(account:PaperEngine,shadow:PaperEngine,gate:EntryDepthGate){
 account.prepareEntryDepth=symbol=>gate.prepare(symbol,true);
 shadow.prepareEntryDepth=symbol=>gate.prepare(symbol);
 account.entryDepthGate=req=>gate.check({...req,book:0});
 account.marketDepthPrice=(symbol,side,qty)=>gate.enabled(symbol)?gate.executionPrice(symbol,side,qty):undefined;
 shadow.entryDepthGate=req=>gate.check({...req,qty:req.executionPlan?req.qty:account.previewDepthQuantity(req),virtualQty:req.qty,book:2});
 shadow.marketDepthPrice=(symbol,side,qty)=>gate.enabled(symbol)?gate.executionPrice(symbol,side,qty):undefined;
}
