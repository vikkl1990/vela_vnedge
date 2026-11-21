import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DEFAULT_CONFIG,ConfigStore} from '../config.ts';
import {Db} from '../db.ts';
import {PaperEngine} from '../paper/engine.ts';
import {PlanComparisons} from '../paper/planComparisons.ts';
import {planSnapshot,planScannerId} from '../paper/executionPlans.ts';
import {SOL_MAKER_REFERENCE,SOL_MAKER_SCANNER,solMakerReference} from './solMakerStudy.ts';
import {enableSolMakerStudy} from '../../../ops/enable-sol-maker-study.ts';
import {OpenTradeMonitor} from './openTradeMonitor.ts';
import {SCANNER_EARLY_EXIT,SCANNER_EARLY_STRESS} from './scannerEarlyExit.ts';
import {eligibleEvidence} from '../evidence/trades.ts';
const T=1800000000000,H=900000;
function config(){
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.execution.mode='paper';cfg.execution.allowProduction=false;cfg.incubator.enabled=true;
 cfg.scanners[SOL_MAKER_SCANNER]={enabled:true,symbols:null,timeframes:null,exitMode:'both',sources:['shape'],labels:['Upper Retest','Lower Retest'],sides:{'upper retest':'long','lower retest':'short'},entryLimit:{tfs:['15m'],atr:.1,minutes:5}};
 cfg.paper.maxStopLossPct=3;return cfg;
}
test('SOL reference activation changes only plans, preserves risk/evidence, refuses overwrite and is idempotent',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sol-study-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'config.json'),cfg=config();fs.writeFileSync(file,JSON.stringify(cfg));const original=fs.readFileSync(file,'utf8');
 assert.equal(enableSolMakerStudy(file,true).changed,true);assert.equal(fs.readFileSync(file,'utf8'),original);
 enableSolMakerStudy(file);const next=JSON.parse(fs.readFileSync(file,'utf8'));const {executionPlans:_,...unchanged}=next;assert.deepEqual(unchanged,cfg);
 const before=fs.statSync(file).mtimeMs;assert.equal(enableSolMakerStudy(file).changed,false);assert.equal(fs.statSync(file).mtimeMs,before);
 const snap=planSnapshot(new ConfigStore(file).get(),SOL_MAKER_REFERENCE,'source');assert.equal(snap.paper.limitEntry!.atr,.1);assert.equal(snap.paper.maxStopLossPct,cfg.paper.maxStopLossPct);assert.equal(snap.paper.marginPerTrade,cfg.paper.marginPerTrade);assert.equal(snap.paper.scalperOffer?.enabled,false);
 next.executionPlans[0].revision=2;fs.writeFileSync(file,JSON.stringify(next));assert.throws(()=>enableSolMakerStudy(file),/refusing overwrite/);
});
test('live source signal creates a resting maker reference; only fresh crossing fills it, and half-stop stays advisory',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=config();cfg.executionPlans=[structuredClone(SOL_MAKER_REFERENCE)];
 Object.assign(cfg.paper,{initialEquity:1000,marginPerTrade:50,fillSource:'tape',latencyMs:100,requireQuote:false,useSpread:false,minRiskFeeRatio:0,maxSignalAgeSec:0,liquidation:false,slippageBps:0,skipScriptStops:false});
 let now=T;const engine=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});engine.causalExits=true;engine.sourceHashFor=()=> 'source';
 const service=new PlanComparisons(db,()=>cfg,engine,()=> 'source'),monitor=new OpenTradeMonitor(db,T);
 const bars=Array.from({length:60},(_,i)=>({time:T-(60-i)*H,open:100,high:101,low:99,close:100,volume:1000}));
 service.observe({scannerId:SOL_MAKER_SCANNER,scannerName:'SOL maker',symbol:'SOLUSD',tf:'15m',bars,market:{tickSize:.01,contractValue:1},at:T,refPrice:100,refusal:null,
 event:{kind:'entry',side:'long',price:100,sl:97,tp:[],label:'Upper Retest',message:'',source:'shape',barTime:T-H,barIndex:59}});
 assert.equal(engine.openPositions().length,0);assert.equal(engine.pendingEntries().length,1);
 const pending=engine.pendingEntries()[0];const limit=pending.limit!.price;assert.ok(limit<100);
 now=T+1000;engine.onTrade('SOLUSD',limit-.01,1e6,T-5000,now);assert.equal(engine.openPositions().length,0,'stale prints never fill');
 now=T+1500;engine.onTrade('SOLUSD',limit-.01,1e6,now,now);const p=engine.openPositions()[0];assert.ok(p);assert.equal(p.entryAt,now);assert.equal(p.entryPrice,limit);assert.ok(solMakerReference(p));
 assert.equal(db.get<any>('SELECT evidence_scope FROM positions WHERE id=?',p.id).evidence_scope,'experiment');
 const before=JSON.stringify(p),cfgBefore=JSON.stringify(cfg),price=p.entryPrice-.6*Math.abs(p.entryPrice-p.slOriginal!);const at=now+500;
 monitor.observe([{position:p,book:2,scope:'experiment',...engine.advisoryObservation(p)}],new Map([['SOLUSD',{symbol:'SOLUSD',at,price,priceAt:at,depth:null,depthAt:null,flow:{covered:false,imbalance:null,throughAt:null,availableAt:null,minutes:0}}]]),()=>null,at);
 assert.equal(db.get<any>('SELECT count(*) n FROM advisory_exits WHERE rule IN (?,?)',SCANNER_EARLY_EXIT,SCANNER_EARLY_STRESS).n,2);
 monitor.settle('SOLUSD',{receivedAt:at+4000,exchangeAt:at+4000,bids:[{price,size:1e6}],asks:[{price:price+.01,size:1e6}]},at+4000,()=>p);
 assert.equal(db.get<any>("SELECT count(*) n FROM advisory_exits WHERE rule IN (?,?) AND status='filled'",SCANNER_EARLY_EXIT,SCANNER_EARLY_STRESS).n,2);
 assert.equal(JSON.stringify(p),before);assert.equal(JSON.stringify(cfg),cfgBefore);assert.equal(engine.pendingExits().length,0);
 assert.equal(db.get<any>(`SELECT count(*) n FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE ${eligibleEvidence}`).n,0);
 assert.equal(monitor.view().scannerExitStudy.groups[0].referenceKind,'research-control');
 db.run("UPDATE positions SET status='closed',exit_at=?,exit_reason='sl',realized_pnl=-10,fees=0 WHERE id=?",at+5000,p.id);monitor.resolve(at+6000);
 const group=monitor.view().scannerExitStudy.groups[0];assert.equal(group.covered,1);assert.equal(group.stopsBefore,1);assert.equal(group.stopsAfter,0);
 const raw=JSON.parse(db.get<any>('SELECT fills FROM positions WHERE id=?',p.id).fills);raw.executionPlan.paper.latencyMs++;
 db.run('UPDATE positions SET fills=? WHERE id=?',JSON.stringify(raw),p.id);monitor.resolve(at+7000);assert.equal(monitor.view().scannerExitStudy.groups[0].covered,0);

 assert.equal(solMakerReference({...p,scannerId:SOL_MAKER_SCANNER}),false);
 const changed={...p.executionPlan!,revision:2};assert.equal(solMakerReference({...p,executionPlan:changed,scannerId:planScannerId(changed)}),false);
});


test('tick-depth study activation retains its control and every account, risk and evidence setting',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sol-tick-study-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json'),cfg=config();fs.writeFileSync(file,JSON.stringify(cfg));enableSolMakerStudy(file);
 const before=fs.readFileSync(file,'utf8'),old=JSON.parse(before);
 assert.equal(enableSolMakerStudy(file,true,true).changed,true);assert.equal(fs.readFileSync(file,'utf8'),before);
 enableSolMakerStudy(file,false,true);const next=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.deepEqual(next.executionPlans[0],old.executionPlans[0]);assert.equal(next.executionPlans[1].makerFill,'tick-depth-v1');
 const {executionPlans:_,...a}=old,{executionPlans:__,...b}=next;assert.deepEqual(a,b);
 assert.equal(enableSolMakerStudy(file,false,true).changed,false);
 const c=new ConfigStore(file).get(),control=planSnapshot(c,next.executionPlans[0],'same-source'),candidate=planSnapshot(c,next.executionPlans[1],'same-source');
 assert.deepEqual(control.paper,candidate.paper);assert.deepEqual(control.reading,candidate.reading);assert.notEqual(control.signature,candidate.signature);
});
