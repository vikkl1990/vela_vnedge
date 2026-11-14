/** Public-data feasibility screen, NOT promotion or profitability evidence.
 * node ops/study-markittick-pairs.ts INPUT_DIR HISTORY_DIR OUTPUT.json
 */
import fs from 'node:fs';
import path from 'node:path';
import {DEFAULT_CONFIG,loadSpecs} from '../server/src/config.ts';
import {PinePool} from '../server/src/pine/pool.ts';
import {ScannerRegistry} from '../server/src/scanners/registry.ts';
import {MARKITTICK_NATIVE} from '../server/src/scanners/markitTick.ts';
import {extractEvents} from '../server/src/scanners/extractor.ts';
import {lastAtr} from '../server/src/data/indicators.ts';
import {regimeRefusal} from '../server/src/risk/manager.ts';
import {toMs} from '../server/src/delta/ws.ts';
import {freshDepthGate} from '../server/src/risk/entryDepth.ts';
import {checkRiskVsFees,sizeContracts} from '../server/src/paper/logic.ts';
import {productFees,withProductFees} from '../server/src/paper/productFees.ts';
import type {Bar} from '../server/src/data/candleStore.ts';
const [input,history,output]=process.argv.slice(2),read=(f:string)=>JSON.parse(fs.readFileSync(f,'utf8'));
const config=read(path.join(input,'current-input.json')),cfg=structuredClone(DEFAULT_CONFIG);
cfg.paper={...cfg.paper,...config.paper};cfg.risk={...cfg.risk,...config.risk};
const products=new Map<string,any>(read(path.join(input,'products.json')).result.map((p:any)=>[p.symbol,p]));
const universe=read(path.join(history,'universe-input.json')).rows;
const allowed=new Set(universe.filter((r:any)=>!r.exclusions.length&&r.bars>=6000).map((r:any)=>r.symbol));
const tickers=read(path.join(input,'tickers.json')).result.filter((t:any)=>allowed.has(t.symbol)).sort((a:any,b:any)=>Number(b.turnover_usd)-Number(a.turnover_usd)).slice(0,30);
const specs=loadSpecs(),registry=new ScannerRegistry(),pool=new PinePool(2,30000),rows:any[]=[];
const books=new Map<string,any[]>();
try{
 for(let round=0;round<3;round++)for(const t of tickers){
  const started=Date.now();let sample:any;
  try{const response=await fetch('https://api.india.delta.exchange/v2/l2orderbook/'+t.symbol,{signal:AbortSignal.timeout(12000)}),j:any=await response.json();if(!response.ok||!j.success)throw Error('book unavailable');sample={at:Date.now(),latencyMs:Date.now()-started,book:j.result};}
  catch(e){sample={at:Date.now(),error:String(e)};}
  books.set(t.symbol,[...(books.get(t.symbol)??[]),sample]);
 }
 for(const t of tickers){
  const p=products.get(t.symbol)!,cv=Number(p.contract_value),tick=Number(p.tick_size),fees=productFees(p);
  const paper=withProductFees(cfg.paper,fees,t.symbol),all:Bar[]=read(path.join(history,'market-data',t.symbol+'-15m.json')).bars,bars=all.slice(-2000);
  const probeQty=Math.ceil(cfg.risk.marketGate!.probeNotionalUsd/(Number(t.close)*cv));
  const samples=(books.get(t.symbol)??[]).map(s=>{
   if(!s.book)return {at:s.at,error:s.error,allowed:false};
   const b=s.book,exchangeAt=toMs(b.timestamp??b.last_updated_at);
   const check=freshDepthGate({now:s.at,receivedAt:s.at,exchangeAt,maxAgeMs:10000,qty:probeQty,contractValue:cv,maxCostPct:cfg.risk.marketGate!.maxBookCostPct,fees:{...paper,feeTaxPct:paper.feeTaxPct??0},book:{bids:b.buy.map((l:any)=>[Number(l.price),Number(l.size)*cv]),asks:b.sell.map((l:any)=>[Number(l.price),Number(l.size)*cv])}});
   return {at:s.at,exchangeAt,latencyMs:s.latencyMs,...check};
  });
  for(const id of Object.keys(MARKITTICK_NATIVE)){
   const source=registry.get(id)!;
   const result=await pool.run({scannerId:id,source:source.patched,symbol:t.symbol,tf:'15m',tickSize:tick,bars,tailBars:'all',plotTail:0});
   if(!result.ok){rows.push({scannerId:id,symbol:t.symbol,error:result.error});continue;}
   const events=extractEvents(result.alerts,result.shapes,{...specs[id],scannerId:id,barMs:900000}).filter(e=>e.kind==='entry');
   const counts:Record<string,number>={},passing:any[]=[];
   for(const ev of events){
    const i=bars.findIndex(b=>b.time===ev.barTime);if(i<100)continue;
    const xs=bars.slice(0,i+1),price=ev.price!;
    const regime=regimeRefusal(cfg.risk.regime,id,{at:ev.barTime+900001,price,atr:lastAtr(xs,14)},xs);
    const cost=checkRiskVsFees(price,ev.sl!,paper,t.symbol,0,{quoted:true});
    const size=sizeContracts(price,ev.sl!,{equity:1000,contractValue:cv,tickSize:tick,cfg:paper,maxLeverage:100/Number(p.initial_margin),maintenanceMarginPct:Number(p.maintenance_margin),entryExecution:{quoted:true}});
    const reason=regime?'regime':cost?'fees':size.qty<=0?'size':'feasible';counts[reason]=(counts[reason]??0)+1;
    if(reason==='feasible')passing.push({at:ev.barTime,side:ev.side,entry:price,sl:ev.sl,tp:ev.tp,qty:size.qty,risk:size.riskAmount});
   }
   rows.push({scannerId:id,symbol:t.symbol,turnoverUsd:Number(t.turnover_usd),bars:bars.length,from:bars[0].time,to:bars.at(-1)!.time,signals:events.length,counts,passing,depth:samples,probeQty,fees});
   process.stderr.write(`${id} ${t.symbol}: ${events.length} signals, ${passing.length} feasible, depth ${samples.filter(s=>s.allowed).length}/3\n`);
  }
 }
 const selected=Object.keys(MARKITTICK_NATIVE).map(id=>({scannerId:id,rows:rows.filter(r=>r.scannerId===id&&!r.error&&r.passing.length>=2&&r.depth.length===3&&r.depth.every((s:any)=>s.allowed)).slice(0,6).map(r=>({symbol:r.symbol,turnoverUsd:r.turnoverUsd,signals:r.signals,feasible:r.passing.length}))}));
 fs.writeFileSync(output,JSON.stringify({at:new Date().toISOString(),scope:'Feasibility only: 2000 closed 15m bars, existing regime/fee/size gates, 3 fresh public depth samples at >=$750. Historical spread/latency unavailable: feasible is an upper bound. No profit ranking or promotion evidence.',selected,rows},null,2)+'\n');
 console.log(JSON.stringify(selected));
}finally{pool.stop();}
