import {BREAKOUT_NATIVE,ML_RSI_NATIVE} from '../server/src/scanners/plotLifecycle.ts';
import {readingOf} from '../server/src/scanners/reading.ts';
import {applyRules} from '../server/src/scanners/rules.ts';
/** Offline, experimental shadow mechanics validation. No VM writes or eligibility changes.
 * node ops/validate-contract-lifecycles.ts /path/ETHUSD-15m.json
 * OHLC-derived prices/depth are synthetic: these results do not measure executable profitability.
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DEFAULT_CONFIG,type ScannerConfig} from '../server/src/config.ts';
import {Db} from '../server/src/db.ts';
import {PinePool} from '../server/src/pine/pool.ts';
import {ScannerRegistry} from '../server/src/scanners/registry.ts';
import {extractEvents,type ScanEvent} from '../server/src/scanners/extractor.ts';
import {PaperEngine} from '../server/src/paper/engine.ts';
import {PlanComparisons} from '../server/src/paper/planComparisons.ts';
import {eligibleEvidence} from '../server/src/evidence/trades.ts';
import type {Bar} from '../server/src/data/candleStore.ts';
const data=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),bars:Bar[]=Array.isArray(data)?data:data.bars;
assert.ok(bars.length>100&&bars.every((b,i)=>i===0||b.time-bars[i-1].time===900000),'contiguous closed 15m candles required');
const ids=[BREAKOUT_NATIVE,ML_RSI_NATIVE];
const specs=JSON.parse(fs.readFileSync(new URL('../scripts/specs.json',import.meta.url),'utf8'));
const registry=new ScannerRegistry(),pool=new PinePool(1,30000),reports:any[]=[];
const canonical=(events:ScanEvent[])=>events.filter(e=>e.kind!=='info').map(({kind,side,exitType,price,sl,tp,barTime})=>({kind,side,exitType,price,sl,tp,barTime}));
try{
 for(const id of ids){
  const script=registry.get(id)!;assert.equal(script?.status,'ok',id);
  const source=script.patched,hash=createHash('sha256').update(source).digest('hex'),sc=specs[id];
  const run=async(xs:Bar[],profile:typeof sc=sc)=>{const r=await pool.run({scannerId:id,source,symbol:'ETHUSD',tf:'15m',tickSize:.05,bars:xs,tailBars:'all',plotTail:xs.length,inputs:profile?.inputs,timezone:profile?.timezone});assert.ok(r.ok,`${id}: ${r.error}`);return r;};
  const result=await run(bars),read=(r:typeof result,xs:Bar[]=bars)=>{const reading=readingOf(sc,id,900000,source,script.variantOf);const derived=applyRules({scannerId:id,...r,bars:xs,mode:'backtest',...reading.rule});return extractEvents(r.alerts,r.shapes,{...reading.extract,derived});};
  const events=read(result),actionable=canonical(events);assert.ok(actionable.some(e=>e.kind==='entry'),`${id}: no entries exercised`);
  let prefixChecks=0;
  for(const time of new Set(actionable.filter(e=>e.exitType!=='stop_update'||bars.findIndex(b=>b.time===e.barTime)%50===0).map(e=>e.barTime))){
   const end=bars.findIndex(b=>b.time===time)+1;if(end<60)continue;
   assert.deepEqual(canonical(read(await run(bars.slice(0,end)),bars.slice(0,end))).filter(e=>e.barTime===time),actionable.filter(e=>e.barTime===time),`${id}: changed closed-bar event ${time}`);prefixChecks++;
  }
  const control=script.variantOf!,controlResult=await pool.run({scannerId:control,source:registry.get(control)!.patched,symbol:'ETHUSD',tf:'15m',tickSize:.05,bars,tailBars:'all',plotTail:bars.length,inputs:specs[control]?.inputs});assert.ok(controlResult.ok,controlResult.error);
  const original=await pool.run({scannerId:control,source:registry.get(control)!.patched,symbol:'ETHUSD',tf:'15m',tickSize:.05,bars,tailBars:'all',plotTail:bars.length,inputs:sc.inputs});assert.ok(original.ok,original.error);assert.deepEqual(result.alerts,original.alerts,'observation exports changed original alerts');assert.deepEqual(result.shapes,original.shapes,'observation exports changed original shapes');
  const oldEvents=extractEvents(controlResult.alerts,controlResult.shapes,{scannerId:control,...specs[control],barMs:900000});
  const cfg=structuredClone(DEFAULT_CONFIG);cfg.execution.mode='paper';
  Object.assign(cfg.paper,{sizingMode:'margin',marginPerTrade:150,maxStopLossPct:3,initialEquity:1000,latencyMs:100,fillSource:'tape',requireQuote:false,useSpread:false,liquidation:true,slippageBps:2,quotedSlippageBps:0,maxSignalAgeSec:60});
  const protectedBefore=JSON.stringify([cfg.paper,cfg.risk,cfg.execution]);
  cfg.scanners[id]={symbols:null,timeframes:null,...sc} as ScannerConfig;
  cfg.executionPlans=[{id:'lifecycle-validation',revision:1,enabled:true,scannerId:id,symbol:'ETHUSD',tf:'15m',variant:'current',referenceEquity:1000,readingOverride:{version:1}}];
  const db=new Db(':memory:');let now=bars[0].time,restarts=0,maxRisk=0;
  try{
   let engine=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});engine.causalExits=true;
   let service=new PlanComparisons(db,()=>cfg,engine,()=>hash);
   for(let i=60;i<bars.length;i++){
    const b=bars[i];
    for(const [k,price] of [b.open,b.open,b.low,b.low,b.high,b.high,b.close].entries()){
     now=b.time+[101,301,120000,120100,360000,360100,720000][k];
     engine.onTrade('ETHUSD',price,Math.max(1,Math.floor(b.volume/7)),now,now,`synthetic:${i}:${k}`);
     engine.settleExits('ETHUSD',{receivedAt:now+100,exchangeAt:now+100,bids:[{price:price*.9999,size:1e6}],asks:[{price:price*1.0001,size:1e6}]},now+100);
    }
    now=b.time+900001;
    const prefix={...result,lastBarTime:b.time,bars:i+1,alerts:result.alerts.filter(a=>a.time<=b.time),shapes:result.shapes.map(s=>({...s,times:s.times.filter(t=>t<=b.time)})),labels:[],plots:result.plots.map(p=>({...p,data:p.data.filter(d=>d.time<=b.time)}))};
    service.observeScan({scannerId:id,scannerName:script.name,symbol:'ETHUSD',tf:'15m',bars:bars.slice(0,i+1),result:prefix,patched:source,since:b.time,newLabelKeys:new Set(),at:now,refPrice:b.close,market:{tickSize:.05,contractValue:.01},refusal:()=>null});
    for(const p of engine.openPositions()){
     assert.equal(p.executionPlan!.paper.marginPerTrade,150);assert.equal(p.executionPlan!.paper.maxStopLossPct,3);
     assert.ok(p.riskAmount<=30+1e-6);maxRisk=Math.max(maxRisk,p.riskAmount);
     assert.ok(p.fills[0].fee>0);assert.equal(p.executionPlan!.paper.scalperOffer?.enabled,false);
    }
    if(i%137===0){engine=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});engine.causalExits=true;service=new PlanComparisons(db,()=>cfg,engine,()=>hash);restarts++;}
   }
   assert.equal(JSON.stringify([cfg.paper,cfg.risk,cfg.execution]),protectedBefore);
   const eligible=db.get<any>(`SELECT count(*) n FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE ${eligibleEvidence}`)!.n;assert.equal(eligible,0);
   const view=service.view().cohorts[0];assert.ok(view?.filled>0,`${id}: no fills exercised`);
   const count=(xs:ScanEvent[])=>({entries:xs.filter(e=>e.kind==='entry').length,exits:xs.filter(e=>e.kind==='exit'&&e.exitType!=='stop_update').length,stopAmendments:xs.filter(e=>e.exitType==='stop_update').length});
   reports.push({id,control,sourceHash:hash,currentReading:count(oldEvents),candidateReading:count(events),prefixChecks,restarts,filled:view.filled,closed:view.closed,open:view.open,maxRisk,eligible,admission:db.all('SELECT action,reason,count(*) n FROM execution_plan_events GROUP BY action,reason')});
   process.stderr.write(`${id}: ${prefixChecks} prefix checks, ${view.filled} simulated fills\n`);
  }finally{db.db.close();}
 }
 console.log(JSON.stringify({verifiedAt:new Date().toISOString(),scope:'mechanics only: synthetic OHLC tape/depth; NOT executable historical fills or profitability evidence',simulation:{fillSource:'tape',latencyMs:100,marginPerTrade:150,maxStopLossPct:3,referenceEquity:1000},datasetHash:createHash('sha256').update(JSON.stringify(bars)).digest('hex'),bars:bars.length,from:bars[0].time,to:bars.at(-1)!.time,continuousActivation:'two isolated profiles; existing 34 plans retained within 36 research slots; no account/risk/evidence changes',reports},null,2));
}finally{pool.stop();}
