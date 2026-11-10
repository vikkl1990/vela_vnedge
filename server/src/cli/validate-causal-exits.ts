/** Offline Phase 1 comparison. Input is a read-only export of positions, orders, tape_audit and depth_tape.
 * node server/src/cli/validate-causal-exits.ts source.json result.json
 * Holds legacy trigger times fixed: execution sensitivity, NOT an alternate-strategy profit backtest.
 */
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Db} from '../db.ts';
import {DepthRecorder} from '../execution/depthRecorder.ts';
import {priceExit} from '../paper/exitExecution.ts';
import {quoteExitSensitivity} from '../research/executionValidation.ts';
const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('usage: source.json result.json');
const bytes=readFileSync(input),x=JSON.parse(bytes.toString());
const positions=new Map<number,any>(x.positions.map((p:any)=>[p.id,p]));
const exits=x.orders.filter((o:any)=>!['entry','funding'].includes(o.reason)&&positions.has(o.position_id));
const sum=(a:number[])=>a.reduce((s,n)=>s+n,0);
const groups=[0,2].map(book=>{
 const ps=x.positions.filter((p:any)=>p.bt===book),os=exits.filter((o:any)=>o.bt===book);
 const quotes=os.map((o:any)=>{const p=positions.get(o.position_id)!;const q=quoteExitSensitivity({side:p.side,qty:o.qty,contractValue:p.contract_value,price:o.price,fee:o.fee,at:o.at,bid:o.bid,ask:o.ask,quoteAt:o.quote_at,maxAgeMs:1000});return q?{id:p.id,delta:q.netDelta,r:q.netDelta/p.risk_amount}:null;}).filter(Boolean);
 const tape=x.audit.filter((a:any)=>a.book===book&&a.kind.startsWith('stop')&&a.first_print>0).filter((a:any)=>{const e=JSON.parse(a.extra||'{}');return !e.unobserved&&!(e.lateSec>10);}).flatMap((a:any)=>{
  const p=positions.get(a.position_id),o=os.find((o:any)=>o.position_id===a.position_id&&o.at===a.at);if(!p||!o)return [];
  const sign=p.side==='long'?1:-1,delta=sign*(a.first_print-o.price)*o.qty*p.contract_value-o.fee*(a.first_print/o.price-1);
  return [{id:p.id,delta,r:delta/p.risk_amount}];
 });
 return {book,trades:ps.length,exits:os.length,recordedR:sum(ps.map((p:any)=>(p.realized_pnl-p.fees)/p.risk_amount)),recordedNet:book===0?sum(ps.map((p:any)=>p.realized_pnl-p.fees)):null,
 quoteOnly:{priced:quotes.length,missing:os.length-quotes.length,deltaR:sum(quotes.map((q:any)=>q.r)),netDelta:book===0?sum(quotes.map((q:any)=>q.delta)):null},
 firstPrintBenchmark:{priced:tape.length,deltaR:sum(tape.map((q:any)=>q.r)),netDelta:book===0?sum(tape.map((q:any)=>q.delta)):null}};
});
const db=new Db(':memory:'),rec=new DepthRecorder(db),start=x.depth[0]?.received_at,end=x.depth.at(-1)?.received_at;
const candidates=exits.filter((o:any)=>o.bt===0&&o.at>=start&&o.at+1500<=end&&['BTCUSD','ETHUSD','SOLUSD'].includes(o.symbol));
const remaining=new Map<number,any>(candidates.map((o:any)=>[o.id,{o,remaining:o.qty,qty:0,value:0,reports:0,firstAt:null,lastAt:null}]));
let cursor=0,flushAt=0;
for(let at=start;at<=end;at+=100){
 while(cursor<x.depth.length&&x.depth[cursor].received_at<=at){const row=x.depth[cursor++];if(['snapshot','update'].includes(row.kind))rec.onDepth(JSON.parse(row.payload),row.received_at);else if(row.kind==='gap')rec.disconnect(row.received_at);}
 for(const r of remaining.values()){
  if(!r.remaining||at<r.o.at+1500)continue;const p=positions.get(r.o.position_id)!,b=rec.bookAt(r.o.symbol,at,1000);
  if(!b||b.receivedAt<r.o.at+1500)continue;
  const key=JSON.stringify([b.exchangeAt,b.bids,b.asks]);if(r.key===key)continue;
  const fill=priceExit(b,p.side,r.remaining,at,1000);if(!fill.qty||fill.price===null)continue;
  r.key=key;r.remaining-=fill.qty;r.qty+=fill.qty;r.value+=fill.qty*fill.price;r.reports++;r.firstAt??=at;r.lastAt=at;
 }
 if(at-flushAt>=5000){rec.flush(at);flushAt=at;}
}
const depthRows=[...remaining.values()].map(r=>{const p=positions.get(r.o.position_id)!,price=r.qty?r.value/r.qty:null;
 const delta=price===null?null:(p.side==='long'?1:-1)*(price-r.o.price)*r.qty*p.contract_value-r.o.fee*(r.qty/r.o.qty)*(price/r.o.price-1);
 return {positionId:p.id,symbol:p.symbol,reason:r.o.reason,triggerAt:r.o.at,readyAt:r.o.at+1500,oldPrice:r.o.price,price,filledQty:r.qty,remainingQty:r.remaining,reports:r.reports,firstAt:r.firstAt,lastAt:r.lastAt,netDelta:delta,deltaR:delta===null?null:delta/p.risk_amount};});
const result={at:x.at,inputSha256:createHash('sha256').update(bytes).digest('hex'),groups,depth:{start,end,retainedEvents:x.depth.length,accountExitCandidates:candidates.length,rows:depthRows},limitations:[
 'Trigger times and entry/stop/target/sizing settings held fixed. Quote and tape figures are sensitivities, not simulated executable P&L.',
 'Depth replays use retained validated snapshots and consecutive updates only, after 1500ms configured latency; missing depth is unpriced. They do not reproduce REST polling delay or external competition.',
 'Historical shadow deployable quantities were not frozen: full-depth historical repricing is limited to account exits with known actual contract quantities.',
 'First-print benchmark inherits the legacy audit window (up to 3s before a stop); it is not a post-latency execution guarantee.',
 'No closed trade, configuration, allocation or evidence row is changed by this offline command.'
]};
writeFileSync(output,JSON.stringify(result,null,2));db.db.close();console.log(JSON.stringify(result,null,2));
