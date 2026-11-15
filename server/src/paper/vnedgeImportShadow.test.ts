import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ConfigStore,DEFAULT_CONFIG} from '../config.ts';
import {Db} from '../db.ts';
import {PaperEngine} from './engine.ts';
import {PlanComparisons,type ComparisonScan} from './planComparisons.ts';
import {planSnapshot,MAX_RESEARCH_PLANS} from './executionPlans.ts';
import {eligibleEvidence} from '../evidence/trades.ts';
import {STEALTH_NATIVE,TREND_CONTINUATION,plotPrefix} from '../scanners/plotLifecycle.ts';
import {VNEDGE_IMPORT_PLANS,enableVnedgeImportShadow} from '../../../ops/enable-vnedge-import-shadow.ts';
const T=1800000000000;
function fixture(t:any){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vnedge-import-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json'),raw=structuredClone(DEFAULT_CONFIG);
 raw.execution.mode='paper';raw.paper.sizingMode='margin';raw.paper.marginPerTrade=150;raw.paper.maxStopLossPct=3;raw.incubator.enabled=true;raw.risk.ddScale=[];
 fs.writeFileSync(file,JSON.stringify(raw));return {file,raw,cfg:new ConfigStore(file).get()};
}
test('six import plans retain 73 existing plans and every capital, evidence and risk setting; installation is idempotent',t=>{
 const {file,raw}=fixture(t);
 raw.executionPlans=Array.from({length:73},(_,i)=>({id:`existing-${i}`,revision:1,enabled:true,scannerId:'control',symbol:'BTCUSD',tf:'15m',variant:'current',referenceEquity:1000}));
 fs.writeFileSync(file,JSON.stringify(raw));const before=fs.readFileSync(file,'utf8');
 assert.equal(enableVnedgeImportShadow(file,true).totalPlans,79);assert.equal(fs.readFileSync(file,'utf8'),before);
 enableVnedgeImportShadow(file);const after=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.deepEqual({...after,executionPlans:raw.executionPlans},raw);
 assert.deepEqual(after.executionPlans.slice(0,73),raw.executionPlans);
 assert.equal(enableVnedgeImportShadow(file).changed,false);
 while(after.executionPlans.length<=MAX_RESEARCH_PLANS)after.executionPlans.push({...raw.executionPlans[0],id:`overflow-${after.executionPlans.length}`});fs.writeFileSync(file,JSON.stringify(after));
 assert.throws(()=>enableVnedgeImportShadow(file),new RegExp(String(MAX_RESEARCH_PLANS)));
});
test('new native policies remain disabled for paper and preserve economics with no invented targets or trailing',t=>{
 const {cfg}=fixture(t),before=JSON.stringify([cfg.paper,cfg.risk,cfg.incubator,cfg.execution]);
 for(const p of VNEDGE_IMPORT_PLANS){
  const s=planSnapshot(cfg,p,'source');
  assert.equal(cfg.scanners[p.scannerId].enabled,false);
  assert.equal(s.paper.marginPerTrade,150);assert.equal(s.paper.maxStopLossPct,3);
  assert.equal(s.paper.minRiskFeeRatio,cfg.paper.minRiskFeeRatio);
  assert.deepEqual(s.paper.fallbackRR,[0,0,0]);assert.equal(s.paper.trailAfterR,0);assert.equal(s.paper.floorAtR,0);
  assert.equal(s.paper.scalperOffer?.enabled,false);
  assert.equal(s.nativeReentryVersion,p.scannerId===STEALTH_NATIVE?1:undefined);
 }
 assert.equal(JSON.stringify([cfg.paper,cfg.risk,cfg.incubator,cfg.execution]),before);
});
test('imports fill once, charge fees, close one-target trades fully and amend Stealth stops causally after restart',t=>{
 const {cfg}=fixture(t);
 Object.assign(cfg.paper,{fillSource:'tape',latencyMs:100,slippageBps:0,quotedSlippageBps:0,useSpread:false,requireQuote:false,maxSignalAgeSec:0,liquidation:false,minRiskFeeRatio:6});
 cfg.executionPlans=structuredClone(VNEDGE_IMPORT_PLANS.filter(p=>p.symbol==='ETHUSD'));
 const db=new Db(':memory:');t.after(()=>db.db.close());let now=T;
 let e=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});e.causalExits=true;
 let service=new PlanComparisons(db,()=>cfg,e,()=> 'source');
 const send=(id:string,values:Record<string,number>,time?:number)=>{
  const tf=id===STEALTH_NATIVE?'15m':'1h',h=tf==='15m'?900000:3600000;time??=now-h;
  const bars=Array.from({length:300},(_,i)=>({time:time!-(299-i)*h,open:100,high:101,low:99,close:100,volume:1000}));
  const result:ComparisonScan['result']={id:1,ok:true,ms:1,bars:300,lastBarTime:time,warnings:0,alerts:[],shapes:[],labels:[],plots:Object.entries(values).map(([key,value])=>({title:plotPrefix+key,style:'line',overlay:true,data:[{time:time!,value}]}))};
  const input:ComparisonScan={scannerId:id,scannerName:id,symbol:'ETHUSD',tf,patched:'source',since:time,newLabelKeys:new Set(),bars,market:{tickSize:.01,contractValue:.01},at:now,refPrice:100,refusal:()=>null,result};
  service.observeScan(input);return input;
 };
 const sv={entry:1,stop:98,tp1:102,tp2:104,tp3:106,exitSide:0,close:0,hit1:0,hit2:0,amend:0};
 service.observeScan(send(STEALTH_NATIVE,sv));
 service.observeScan(send(TREND_CONTINUATION,{entry:1,stop:98,tp1:104}));
 assert.equal(e.pendingEntries().length,2);
 now+=100;e.onTrade('ETHUSD',100,1e6,now,now,'entry');assert.equal(e.openPositions().length,2);
 const trend=e.openPositions().find(p=>p.executionPlan!.sourceScannerId===TREND_CONTINUATION)!;
 const stealth=e.openPositions().find(p=>p.executionPlan!.sourceScannerId===STEALTH_NATIVE)!;
 assert.deepEqual(trend.tp,[104]);assert.ok(trend.riskAmount<=30);assert.ok(stealth.riskAmount<=30);
 const depth=(price:number)=>{now+=100;e.settleExits('ETHUSD',{receivedAt:now,exchangeAt:now,bids:[{price,size:1e6}],asks:[{price:price+.01,size:1e6}]},now);};
 now+=100;e.onTrade('ETHUSD',104.1,1e6,now,now,'target');depth(104);
 assert.equal(trend.status,'closed');assert.equal(trend.qtyOpen,0);assert.equal(stealth.qtyOpen,stealth.qty,'milestones do not take partial profit');
 now=T+900000;send(STEALTH_NATIVE,{...sv,entry:0,exitSide:1,hit1:1,hit2:1,amend:100},T);
 assert.equal(stealth.sl,98,'amendment cannot move stop backwards in time');
 e=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});e.causalExits=true;service=new PlanComparisons(db,()=>cfg,e,()=> 'source');
 now+=100;e.onTrade('ETHUSD',99.99,1e6,now,now,'amended-stop');depth(99.98);
 assert.equal(e.openPositions().length,0);
 const rows=db.all<any>('SELECT fees,evidence_scope FROM positions');
 assert.equal(rows.length,2);assert.ok(rows.every(p=>p.fees>0&&p.evidence_scope==='experiment'));
 assert.equal(db.get<any>(`SELECT count(*) n FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE ${eligibleEvidence}`)!.n,0);
});
