/** Offline validation, never imports the application or opens its database.
 * node server/src/cli/validate-execution.ts --quotes export.json --capture public.json.gz --out result.json
 * Capture: {startedAt,finishedAt,markets:[{symbol,contractValue}],events:[{receivedAt,m}]}.
 * Quotes: {at,orders:[saved orders joined to positions]}. See report for read-only export SQL.
 */
import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {Db} from '../db.ts';
import {DepthRecorder} from '../execution/depthRecorder.ts';
import {parseQuote,toMs,isExecutableTrade} from '../delta/ws.ts';
import {evaluateDepthExit,quoteExitSensitivity} from '../research/executionValidation.ts';

const args=process.argv.slice(2);
const arg=(k:string)=>{const i=args.indexOf(k);if(i<0||!args[i+1])throw Error(`missing ${k}`);return args[i+1];};
const read=(p:string)=>JSON.parse(p.endsWith('.gz')?gunzipSync(readFileSync(p)).toString():readFileSync(p,'utf8'));
const q=read(arg('--quotes')),capture=read(arg('--capture'));
if(!Array.isArray(q.orders)||!Number.isFinite(q.at)||!Array.isArray(capture.events)||!Array.isArray(capture.markets))throw Error('invalid validation dataset');
for(let i=0;i<capture.events.length;i++)if(!Number.isFinite(capture.events[i].receivedAt)||(i&&capture.events[i].receivedAt<capture.events[i-1].receivedAt))throw Error('capture is not in receipt order');
const quantile=(xs:number[],p:number)=>xs.length?[...xs].sort((a,b)=>a-b)[Math.floor((xs.length-1)*p)]:null;
const stats=(xs:number[])=>({n:xs.length,mean:xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null,median:quantile(xs,.5),p95:quantile(xs,.95),max:quantile(xs,1)});
const rows=q.orders.filter((o:any)=>!/^tp[123]$/.test(o.reason)&&o.reason!=='liquidation').map((o:any)=>{
 const sensitivity=quoteExitSensitivity({side:o.position_side,qty:o.qty,contractValue:o.contract_value,price:o.price,fee:o.fee,at:o.at,bid:o.bid,ask:o.ask,quoteAt:o.quote_at,maxAgeMs:1000});
 return {...o,sensitivity,deltaR:sensitivity&&o.risk_amount>0?sensitivity.netDelta/o.risk_amount:null};
});
function summarize(rs:any[]){
 const priced=rs.filter(r=>r.sensitivity),positions=new Map<number,any>(),changes=new Map<number,number>();
 for(const r of priced){positions.set(r.position_id,r);changes.set(r.position_id,(changes.get(r.position_id)??0)+r.sensitivity.netDelta);}
 const closed=[...positions.values()].filter(r=>r.exit_at!=null);
 const net=closed.reduce((s,r)=>s+r.realized_pnl-r.fees,0),delta=closed.reduce((s,r)=>s+changes.get(r.position_id)!,0);
 return {exits:rs.length,priced:priced.length,positions:positions.size,closedPositions:closed.length,
   recordedNet:net,quoteSensitivityNet:net+delta,netDelta:delta,
   recordedR:closed.reduce((s,r)=>s+(r.risk_amount>0?(r.realized_pnl-r.fees)/r.risk_amount:0),0),
   deltaR:closed.reduce((s,r)=>s+(r.risk_amount>0?changes.get(r.position_id)!/r.risk_amount:0),0),
   pricesWorse:priced.filter(r=>r.sensitivity.netDelta<-.0000001).length,
   pricesBetter:priced.filter(r=>r.sensitivity.netDelta>.0000001).length,
   winnersTurnedLosers:closed.filter(r=>r.realized_pnl-r.fees>0&&r.realized_pnl-r.fees+changes.get(r.position_id)!<=0).length,
   quoteAgeMs:stats(priced.map(r=>r.sensitivity.ageMs))};
}
const windows=[1,7].map(days=>({days,books:[0,2].map(book=>({book,...summarize(rows.filter((r:any)=>r.bt===book&&r.at>=q.at-days*86400000))}))}));
const days=[...new Set<string>(rows.map((r:any)=>new Date(r.at).toISOString().slice(0,10)))].sort();
const daily=days.map(day=>({day,...summarize(rows.filter((r:any)=>r.bt===0&&new Date(r.at).toISOString().startsWith(day)))}));

const db=new Db(':memory:');
const symbols=capture.markets.map((m:any)=>m.symbol);
const recorder=new DepthRecorder(db,symbols),lastQuotes=new Map<string,any>(),lastTrades=new Map<string,any>();
const observations:any[]=[],perSymbol=new Map<string,any>();
let depthMicros=0,maxDepthMicros=0;
const update=(e:any)=>{
 if(e.m.type==='ob_updates'){const start=performance.now();recorder.onDepth(e.m,e.receivedAt);const elapsed=(performance.now()-start)*1000;depthMicros+=elapsed;maxDepthMicros=Math.max(maxDepthMicros,elapsed);}
 if(e.m.type==='ob_l1'){const quote=parseQuote(e.m,e.receivedAt);if(quote)lastQuotes.set(quote.symbol,quote);}
 if(e.m.type==='trades'){
  const t={symbol:e.m.sy,price:Number(e.m.p),qty:Number(e.m.s),timeMs:toMs(e.m.t,0),timeKnown:!!e.m.t,aggressor:null};
  if(isExecutableTrade(t,e.receivedAt))lastTrades.set(t.symbol,{...t,receivedAt:e.receivedAt});
 }
};
// Fixed wall-clock samples avoid counting active pairs more heavily simply because they print more often.
let cursor=0;
for(let at=capture.startedAt+2000;at<=capture.finishedAt-1000;at+=1000){
 while(cursor<capture.events.length&&capture.events[cursor].receivedAt<=at)update(capture.events[cursor++]);
 for(const m of capture.markets){
  const book=recorder.bookAt(m.symbol,at,1000),quote=lastQuotes.get(m.symbol),trade=lastTrades.get(m.symbol);
  const state=perSymbol.get(m.symbol)??{symbol:m.symbol,samples:0,validDepth:0,validDepth5s:0,validDepth10s:0,validQuote:0,depthAgeMs:[],quoteLagMs:[],partial:0};perSymbol.set(m.symbol,state);state.samples++;
  if(recorder.bookAt(m.symbol,at,5000))state.validDepth5s++;
  if(recorder.bookAt(m.symbol,at,10000))state.validDepth10s++;
  if(book){state.validDepth++;state.depthAgeMs.push(at-book.exchangeAt);}
  if(quote&&at-quote.receivedAt<=1000&&at-quote.timeMs<=1000){state.validQuote++;state.quoteLagMs.push(quote.receivedAt-quote.timeMs);}
  if(!book)continue;
  const mid=(book.bids[0]?.price+book.asks[0]?.price)/2;
  if(!(mid>0))continue;
  for(const target of [750,1500])for(const side of ['long','short'] as const){
   const qty=Math.floor(target/(mid*m.contractValue));if(!qty)continue;
   const exit=evaluateDepthExit({side,qty,contractValue:m.contractValue,at,maxAgeMs:1000,book,feeRatePct:.05,feeTaxPct:18});
   if(exit.status==='partial')state.partial++;
   const sign=side==='long'?1:-1,best=side==='long'?book.bids[0].price:book.asks[0].price;
   const old=trade&&at-trade.timeMs<=5000&&at-trade.receivedAt<=5000?trade.price*(1-sign*.0002):null;
   observations.push({at,symbol:m.symbol,target,side,qty,status:exit.status,coverage:exit.coverage,price:exit.price,
    best,mid,extraDepthBps:exit.price!==null?sign*(best-exit.price)/mid*10000:null,
    spreadExitBps:sign*(mid-best)/mid*10000,
    printModelDeltaBps:old&&exit.price!==null?sign*(exit.price-old)/mid*10000:null});
  }
 }
 // Flush on the same 5s cadence as the app; never let benchmark queue overflow distort coverage.
 if((at-capture.startedAt)%5000===0)recorder.flush(at);
}
recorder.flush(capture.finishedAt);
const depth=recorder.summary(capture.finishedAt);
const marketStats=[...perSymbol.values()].map(s=>({...s,depthAgeMs:stats(s.depthAgeMs),quoteLagMs:stats(s.quoteLagMs)}));
const tiers=[750,1500].map(target=>{
 const rs=observations.filter(o=>o.target===target),full=rs.filter(o=>o.status==='complete');
 return {target,samples:rs.length,full:full.length,partial:rs.filter(o=>o.status==='partial').length,
  extraDepthBps:stats(full.map(o=>o.extraDepthBps)),spreadExitBps:stats(full.map(o=>o.spreadExitBps)),
  printModelDeltaBps:stats(full.filter(o=>o.printModelDeltaBps!==null).map(o=>o.printModelDeltaBps))};
});
const byMarket=symbols.map((symbol:string)=>({symbol,tiers:[750,1500].map(target=>{const rs=observations.filter(o=>o.symbol===symbol&&o.target===target&&o.status==='complete');return {target,n:rs.length,extraDepthBps:stats(rs.map(o=>o.extraDepthBps)),spreadExitBps:stats(rs.map(o=>o.spreadExitBps))};})}));
const sha256=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const result={generatedAt:Date.now(),inputs:{quotesSha256:sha256(arg('--quotes')),captureSha256:sha256(arg('--capture'))},quotesAt:q.at,windows,daily,
 worstAccount:rows.filter((r:any)=>r.bt===0&&r.sensitivity).sort((a:any,b:any)=>a.sensitivity.netDelta-b.sensitivity.netDelta).slice(0,20).map((r:any)=>({id:r.position_id,symbol:r.symbol,tf:r.tf,scanner:r.scanner_name,reason:r.reason,at:r.at,price:r.price,quotePrice:r.sensitivity.price,netDelta:r.sensitivity.netDelta,deltaR:r.deltaR})),
 capture:{startedAt:capture.startedAt,finishedAt:capture.finishedAt,counts:capture.counts,errors:capture.errors,dropped:capture.dropped,bytes:capture.bytes,
  markets:marketStats,tiers,byMarket,depthFailures:depth.failures,queueDrops:depth.droppedPending,
  processing:{depthMessages:capture.counts.ob_updates,totalDepthCpuMs:depthMicros/1000,maxOneDepthMs:maxDepthMicros/1000},
  recorded:depth.stored},
 limitations:['Quote-only historical repricing has no historical size or exchange publication clock; it is a sensitivity, not a fill guarantee.',
 'Entry, signal timestamps, exit trigger times, funding, stops and targets are held fixed. This is not a strategy backtest.',
 'The public depth test contains hypothetical exits at fixed intervals, not scanner trades. Correlated samples are not independent evidence of profit.',
 'Shadow monetary results use synthetic sizing: compare R, not dollars, with the account.',
 'Public snapshots do not model order acknowledgement latency, queue position or liquidity consumed by other traders.']};
writeFileSync(arg('--out'),JSON.stringify(result,null,2));db.db.close();
console.log(JSON.stringify({windows,daily,tiers,depthFailures:depth.failures,markets:marketStats.map(s=>({symbol:s.symbol,depth:`${s.validDepth}/${s.samples}`}))},null,2));
