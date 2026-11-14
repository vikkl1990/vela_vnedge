/** Compare baseline and candidate engines using the same retained Pine outputs.
 * OHLC-interpolated prints/depth test mechanics only, not profitability or promotion.
 * args: baseline checkout, Delta 15m candle JSON, sanitized config JSON, NEW output JSON
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {ConfigStore} from '../server/src/config.ts';
import {ScannerRegistry} from '../server/src/scanners/registry.ts';
import {PinePool} from '../server/src/pine/pool.ts';
import {extractEvents} from '../server/src/scanners/extractor.ts';
import {NATIVE_REENTRY_SCANNERS} from '../server/src/scanners/nativeLifecycle.ts';
import {strategyIdentity} from '../server/src/scanners/identity.ts';
import {sourceHash} from '../server/src/paper/fingerprint.ts';
import {lastAtr} from '../server/src/data/indicators.ts';
import {regimeRefusal} from '../server/src/risk/manager.ts';
import {eligibleEvidence} from '../server/src/evidence/trades.ts';

const [baselineRoot,dataFile,configFile,outFile]=process.argv.slice(2);
assert.ok(baselineRoot&&dataFile&&configFile&&outFile,'four arguments required');
assert.ok(!fs.existsSync(outFile),'output must be new');
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const baselineCommit=execFileSync('git',['-C',baselineRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(execFileSync('git',['-C',baselineRoot,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim(),'','baseline tracked files must be clean');
const config=new ConfigStore(configFile).get(),protectedConfig=JSON.stringify(config);
assert.equal(config.execution.mode,'paper');
const data=JSON.parse(fs.readFileSync(dataFile,'utf8')),bars=data.bars;
assert.equal(data.tf,'15m');assert.ok(bars.length>200);
assert.ok(bars.every((b:any,i:number)=>i===0||b.time-bars[i-1].time===900000));
const root=path.resolve(import.meta.dirname,'..');
async function modules(dir:string){
 const read=(s:string)=>import(pathToFileURL(path.join(dir,'server/src',s)).href);
 const [engine,plans,comparisons,db,identity]=await Promise.all([read('paper/engine.ts'),read('paper/executionPlans.ts'),read('paper/planComparisons.ts'),read('db.ts'),read('scanners/identity.ts')]);
 return {engine,plans,comparisons,db,identity};
}
const old=await modules(baselineRoot),current=await modules(root);
const registry=new ScannerRegistry(),pool=new PinePool(1,60000),reports:any[]=[];
const changedPlans=(config.executionPlans??[]).filter(p=>old.plans.planSnapshot(config,p,'source').signature!==current.plans.planSnapshot(config,p,'source').signature).map(p=>p.id);
const expected=(config.executionPlans??[]).filter(p=>NATIVE_REENTRY_SCANNERS.has(p.scannerId)).map(p=>p.id);
assert.deepEqual(changedPlans,expected,'only the six native research cohorts may change');
const identityChanges=registry.all().filter(s=>s.status==='ok'&&old.identity.strategyIdentity(s.patched,config,s.id)!==strategyIdentity(s.patched,config,s.id)).map(s=>s.id);
assert.deepEqual(identityChanges,[],'all ordinary scanner identities stay intact');
try{
 for(const id of NATIVE_REENTRY_SCANNERS){
  const s=registry.get(id)!;assert.equal(s.status,'ok');
  const sc=config.scanners[id];
  const run=(xs:any[])=>pool.run({scannerId:id,source:s.patched,symbol:data.symbol,tf:'15m',tickSize:data.market.tickSize,bars:xs,tailBars:'all',plotTail:0,inputs:sc.inputs,timezone:sc.timezone});
  const raw=await run(bars);assert.ok(raw.ok,`${id}: ${raw.error}`);
  const events=extractEvents(raw.alerts,raw.shapes,{scannerId:id,...sc,barMs:900000});
  const pairs=events.filter(e=>e.kind==='entry'&&events.some(x=>x.kind==='exit'&&x.exitType!=='stop_update'&&x.barTime===e.barTime));
  const canonical=(xs:any[])=>xs.filter(e=>e.kind!=='info').map(({kind,side,barTime,exitType,price,sl,tp})=>({kind,side,barTime,exitType,price,sl,tp}));
  let prefixChecks=0;
  for(const time of [...new Set(pairs.map(e=>e.barTime))].slice(-3)){
   const end=bars.findIndex((b:any)=>b.time===time)+1;
   const prefix=await run(bars.slice(0,end));assert.ok(prefix.ok);
   assert.deepEqual(canonical(extractEvents(prefix.alerts,prefix.shapes,{scannerId:id,...sc,barMs:900000})).filter(e=>e.barTime===time),canonical(events).filter(e=>e.barTime===time));
   prefixChecks++;
  }
  const results:any={};
  for(const [name,m] of [['baseline',old],['candidate',current]] as const){
   const c=structuredClone(config),plan=c.executionPlans!.find(p=>p.scannerId===id)!;
   c.executionPlans=[plan];const db=new m.db.Db(':memory:');let now=bars[0].time,mark=bars[0].open,maxRisk=0;
   const engine=new m.engine.PaperEngine(db,()=>c,{book:2,now:()=>now});engine.causalExits=true;
   engine.quotes={executable:(_s:string,side:string)=>mark*(side==='buy'?1.0001:.9999),markState:()=>({bestBid:mark*.9999,bestAsk:mark*1.0001,at:now,quoteAt:now,quoteExchangeAt:now})};
   const service=new m.comparisons.PlanComparisons(db,()=>c,engine,()=>sourceHash(s.patched));
   try{
    for(let i=60;i<bars.length;i++){
     const b=bars[i],prefix=bars.slice(0,i+1);
     for(const [j,price] of [b.open,b.open,b.low,b.low,b.high,b.high,b.close,b.close].entries()){
      now=b.time+[2000,4000,120000,122000,360000,362000,720000,722000][j];mark=price;
      engine.onTrade(data.symbol,price,100000,now,now,`synthetic:${i}:${j}`);
      engine.onBar(data.symbol,{time:Math.floor(now/60000)*60000,high:price,low:price,close:price},now);
      engine.settleExits(data.symbol,{receivedAt:now,exchangeAt:now,bids:[{price:mark*.9999,size:100000}],asks:[{price:mark*1.0001,size:100000}]},now);
     }
     now=b.time+900001;mark=b.close;
     service.observeScan({scannerId:id,scannerName:s.name,symbol:data.symbol,tf:'15m',bars:prefix,result:{...raw,alerts:raw.alerts.filter(a=>a.time===b.time),shapes:[],labels:[],plots:[]},
      patched:s.patched,variantOf:s.variantOf,since:b.time,newLabelKeys:new Set(),at:now,refPrice:mark,market:data.market,
      refusal:(ev:any)=>regimeRefusal(c.risk.regime,id,{at:now,price:ev.price??mark,atr:lastAtr(prefix,14)},prefix)});
     for(const p of engine.openPositions()){
      maxRisk=Math.max(maxRisk,p.riskAmount);assert.ok(p.riskAmount<=plan.referenceEquity*c.paper.maxStopLossPct/100+1e-6);
      assert.equal(p.executionPlan.paper.marginPerTrade,c.paper.marginPerTrade);
      assert.equal(p.executionPlan.paper.scalperOffer?.enabled,false);assert.ok(p.fills[0].fee>0);
     }
    }
    const eligible=db.get(`SELECT count(*) n FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE ${eligibleEvidence}`).n;
    assert.equal(eligible,0);
    const positions=db.all("SELECT status,count(*) n FROM positions WHERE bt=2 GROUP BY status");
    results[name]={positions,maxRisk,eligible,admission:db.all("SELECT action,reason,count(*) n FROM execution_plan_events GROUP BY action,reason")};
   }finally{db.db.close();}
  }
  reports.push({scannerId:id,rawEntries:events.filter(e=>e.kind==='entry').length,sameBarClosureAndEntry:pairs.length,prefixChecks,sourceHash:sha(s.patched),...results});
  process.stderr.write(`${id}: ${pairs.length} same-bar closure/entry sequences; baseline/candidate replay complete\n`);
 }
 assert.equal(JSON.stringify(config),protectedConfig);
 fs.writeFileSync(outFile,JSON.stringify({verifiedAt:new Date().toISOString(),baselineCommit,baselineTree:execFileSync('git',['-C',baselineRoot,'rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),
  implementationHash:sha(['server/src/paper/engine.ts','server/src/paper/executionPlans.ts','server/src/paper/partialExits.ts','server/src/scanners/nativeLifecycle.ts'].map(p=>[p,fs.readFileSync(path.join(root,p),'utf8')])),
  scope:'Execution mechanics only; synthetic OHLC path and depth. No profitability or promotion claim.',
  exclusions:['historical order book/queue and funding not reconstructed','historical market eligibility not reconstructed','ordinary account portfolio not simulated'],
  dataset:{hash:sha(data),source:data.source,bars:bars.length,from:bars[0].time,to:bars.at(-1).time},
  settings:{mode:config.execution.mode,margin:config.paper.marginPerTrade,stopCap:config.paper.maxStopLossPct,feeGate:config.paper.minRiskFeeRatio,latencyMs:config.paper.latencyMs,fillSource:config.paper.fillSource},
  changedPlans,ordinaryIdentityChanges:identityChanges,reports},null,2)+'\n',{flag:'wx'});
}finally{pool.stop();}
