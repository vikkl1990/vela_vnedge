/** Offline only. Inputs: read-only journal export and checksum-verified replay capture.
 * Usage: node ops/replay-conditional-exits.ts <export.json> <events.ndjson.gz> <result.json>
 * No network, config writes or exchange access. Actual entries and outcomes remain immutable references.
 */
import fs from 'node:fs';
import {createGunzip} from 'node:zlib';
import {createInterface} from 'node:readline';
import {Db} from '../server/src/db.ts';
import {rowToPosition} from '../server/src/paper/engine.ts';
import {loadTradePolicy} from '../server/src/paper/tradePolicy.ts';
import {OpenTradeMonitor,type WatchInput,type MarketObservation} from '../server/src/research/openTradeMonitor.ts';
import {DepthRecorder} from '../server/src/execution/depthRecorder.ts';
import type {Position} from '../server/src/paper/logic.ts';

const [exportFile,eventsFile,outFile]=process.argv.slice(2);
if(!exportFile||!eventsFile||!outFile)throw Error('Expected journal export, verified replay gzip and output path');
const data=JSON.parse(fs.readFileSync(exportFile,'utf8'));
const manifestFile=new URL('./manifest.json',`file://${eventsFile}`).pathname;
const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
if(!Array.isArray(manifest.segments)||manifest.segments.some((s:any)=>s.verified!==true))throw Error('Missing checksum verification');
const db=new Db(':memory:');
function insert(table:string,row:Record<string,unknown>){const keys=Object.keys(row);db.run(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,...keys.map(k=>row[k] as any));}
for(const p of data.policies)insert('trade_policies',p);
const excluded:Array<{id:number;reason:string}>=[],held=new Map<number,Position>(),rows=new Map<number,any>(),sizes=new Map<number,number>();
for(const row of data.positions){
 const r=structuredClone(row),extra=JSON.parse(r.fills),entries=extra.fills.filter((f:any)=>f.reason==='entry');
 const size=data.execution.find((x:any)=>x.position_id===r.id)?.market_qty;
 let reason:string|null=null;
 if(!entries.length||entries.some((f:any)=>f.at>r.entry_at)||entries.reduce((n:number,f:any)=>n+f.qty,0)!==r.qty||extra.executionPlan||extra.basket)reason='Unsupported partial/basket entry chronology or research plan';
 else if(!Number.isSafeInteger(size)||size<1)reason='Missing frozen market quantity';
 if(reason){excluded.push({id:r.id,reason});continue;}
 r.status='open';r.qty_open=r.qty;r.sl=r.sl_original;r.tp_hit=JSON.stringify(JSON.parse(r.tp).map(()=>false));r.break_even=0;r.realized_pnl=0;r.fees=entries.reduce((n:number,f:any)=>n+f.fee,0);
 r.exit_at=null;r.exit_price=null;r.exit_reason=null;r.signal_id=null;r.peak_r=0;r.peak_at=null;r.worst_r=0;r.worst_at=null;
 for(const k of ['lastPriceBar','peakR','peakAt','worstR','worstAt','trailOff','trailArmedAt','trailPeakR','trailPeakAt'])delete extra[k];
 extra.fills=entries;r.fills=JSON.stringify(extra);insert('positions',r);
 const p=rowToPosition(r);p.policy=loadTradePolicy(db,r.policy_id,r.policy_adopted_at);held.set(p.id,p);rows.set(p.id,row);sizes.set(p.id,size);
}
for(const trace of data.traces)if(held.has(trace.position_id))insert('decision_trace',{...trace,signal_id:null});
const start=Math.min(...data.positions.map((p:any)=>p.entry_at)),end=Math.max(...data.positions.map((p:any)=>p.exit_at));
const monitor=new OpenTradeMonitor(db,start-1),depth=new DepthRecorder(db,[...new Set<string>(data.positions.map((p:any)=>p.symbol))],()=>{},false);
let next=start+1000,lastEvent=0,events=0,regressions=0;
const quotes=new Map<string,{price:number;at:number;exchangeAt:number}>();
function active(at:number){
 const inputs:WatchInput[]=[];
 for(const [id,p] of held){const row=rows.get(id);
  if(p.entryAt>at)continue;
  if(row.exit_at<=at){
   const keys=Object.keys(row).filter(k=>k!=='id'&&k!=='signal_id');db.run(`UPDATE positions SET ${keys.map(k=>k+'=?').join(',')} WHERE id=?`,...keys.map(k=>row[k]),id);held.delete(id);continue;
  }
  const fills=JSON.parse(row.fills).fills.filter((f:any)=>f.at<=at),exits=fills.filter((f:any)=>f.reason!=='entry'&&f.reason!=='funding'&&f.qty>0);
  p.fills=fills;p.qtyOpen=p.qty-exits.reduce((n:number,f:any)=>n+f.qty,0);p.fees=fills.reduce((n:number,f:any)=>n+f.fee,0);p.realizedPnl=fills.reduce((n:number,f:any)=>n+f.pnl,0);
  const path=data.paths.filter((v:any)=>v.position_id===id&&v.at<=at).at(-1);if(path?.sl!=null)p.sl=path.sl;
  inputs.push({position:p,book:row.bt,scope:row.bt===0?'paper':'shadow',config:p.policy!.paper,marketQty:sizes.get(id)!,exitPending:data.intents.some((i:any)=>i.position_id===id&&i.trigger_at<=at)});
 }return inputs;
}
function observe(at:number){
 const inputs=active(at),markets=new Map<string,MarketObservation>();
 for(const i of inputs){const b=depth.bookAt(i.position.symbol,at,1000),q=quotes.get(i.position.symbol),fresh=q&&q.at<=at&&q.exchangeAt<=at&&at-q.at<=10000&&at-q.exchangeAt<=10000;
  markets.set(i.position.symbol,{symbol:i.position.symbol,at,price:fresh?q.price:null,priceAt:fresh?q.at:null,depth:b,depthAt:b?.receivedAt??null,flow:{covered:false,imbalance:null,throughAt:null,availableAt:null,minutes:0}});
 }monitor.observe(inputs,markets,()=>null,at);
}
for await(const line of createInterface({input:fs.createReadStream(eventsFile).pipe(createGunzip()),crlfDelay:Infinity})){
 const e=JSON.parse(line),at=e.receivedAt;if(!Number.isFinite(at))throw Error('Invalid event time');events++;
 if(at<lastEvent){regressions++;depth.disconnect(lastEvent);quotes.clear();continue;}lastEvent=at;
 while(next<at&&next<=end){observe(next);next+=5000;}
 if(e.kind==='gap'){
  if(e.symbol==='*'){depth.disconnect(at);quotes.clear();}else{depth.invalidateSymbols([e.symbol],at);if(e.source!=='advisory-depth')quotes.delete(e.symbol);}
 }else if(e.source==='execution-feed'&&e.kind==='quote'){
  const q=e.payload;if(q.bestBid>0&&q.bestAsk>=q.bestBid&&Number.isFinite(q.timeMs))quotes.set(e.symbol,{price:(q.bestBid+q.bestAsk)/2,at,exchangeAt:q.bookTimeMs??q.timeMs});
 }else if(e.source==='advisory-depth'&&['snapshot','checkpoint','update'].includes(e.kind)){
  depth.onDepth(e.payload,at);const book=depth.bookAt(e.symbol,at,1000);
  active(at);if(book)monitor.settle(e.symbol,book,at,id=>held.get(id));
 }
}
while(next<=end+5000){observe(next);next+=5000;}active(end+1);monitor.resolve(end+1);
const view=monitor.view().conditionalExitStudy;
fs.writeFileSync(outFile,JSON.stringify({mode:'historical-shadow-replay',at:Date.now(),start,end,inputTrades:data.positions.length,excluded,events,regressions,
 coverage:{segments:manifest.segments.length,missing:manifest.missing??[],note:'Checksum verification is not proof of continuous executable depth. Per-trade observation gaps remain unavailable.'},
 reference:'Actual filled entries and journal exits; decisions use recorded bid/ask quotes on a 5s clock, fresh full-size depth for profit tests and fills. No reconstructed candle extrema, fabricated fills or retroactive trading.',
 study:view,trials:db.all("SELECT position_id,rule,status,trigger_at,ready_at,net,actual_net,delta,error FROM advisory_exits WHERE rule LIKE 'conditional-exit-v1-%'"),
 deployment:'Not qualified: no independent prospective proof. Risk and admission evidence unchanged.'},null,2));
db.db.close();
