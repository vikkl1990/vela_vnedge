import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createHash} from 'node:crypto';
import {ENTRY_CONTRACTS,type SignalContract,contractRuntimeHash} from './entryContracts.ts';
import {extractEvents,type ExtractOptions} from './extractor.ts';import {readingOf} from './reading.ts';import {ScannerRegistry} from './registry.ts';
import {DEFAULT_CONFIG,validateConfig,PINE_DIR} from '../config.ts';import {Db} from '../db.ts';import {PaperEngine} from '../paper/engine.ts';import {PlanComparisons} from '../paper/planComparisons.ts';import {planSnapshot,planScannerId,MAX_RESEARCH_PLANS} from '../paper/executionPlans.ts';
import {CONTRACT_PLANS,enableEntryContracts} from '../../../ops/enable-entry-contract-comparisons.ts';
import {profileSignature} from './profile.ts';import {strategyIdentity} from './identity.ts';import {eligibleEvidence} from '../evidence/trades.ts';
const T=1800000000000,H=900000;
const opts=(contract:SignalContract):ExtractOptions=>({reader:2,signalContract:contract,scannerId:ENTRY_CONTRACTS[contract].scannerId,contractSourceHash:ENTRY_CONTRACTS[contract].runtime,sinceBarTime:T});
const alert=(message:string)=>({type:'alert' as const,time:T,barIndex:99,message});
const condition=(title:string)=>({...alert('source condition'),type:'alertcondition' as const,title});
const shape=(title:string)=>({title,times:[T]});

test('versioned contracts bind the exact three installed sources; a same-named Regime publication is not interchangeable',()=>{
 const r=new ScannerRegistry();for(const [contract,pin] of Object.entries(ENTRY_CONTRACTS)){
  const s=r.get(pin.scannerId)!;assert.equal(createHash('sha256').update(s.source).digest('hex'),pin.source);assert.equal(contractRuntimeHash(s.patched),pin.runtime);
  const read=readingOf({reader:2,signalContract:contract as SignalContract},s.id,H,s.patched);assert.equal(read.extract.contractSourceHash,pin.runtime);
  assert.notEqual(profileSignature(s,{reader:2,signalContract:contract as SignalContract},'15m'),profileSignature(s,{reader:2},'15m'));
  assert.equal(extractEvents([condition('Long Signal')],[],{...read.extract,contractSourceHash:'changed'}).length,0);
 }
 assert.notEqual(ENTRY_CONTRACTS['market-regime-context-v1'].source,createHash('sha256').update(fs.readFileSync(path.join(PINE_DIR,'Nr5RMcSh-Market-Regime-Engine.pine'))).digest('hex'));
});
test('Regime state alerts and directional drawings remain visible context and cannot create entries or exits',()=>{
 const events=extractEvents([condition('Turned trending up'),condition('Turned trending down'),condition('Turned ranging')],[shape('Buy')],{...opts('market-regime-context-v1'),drawn:[{text:'TRENDING ▲',time:T,createdAt:T,y:100,style:'label_up'}],derived:[{kind:'entry',side:'long',source:'derived',barTime:T,barIndex:99,label:'Long',message:'',tp:[]}]});
 assert.equal(events.length,3);assert.ok(events.every(e=>e.kind==='info'));
 assert.ok(extractEvents([condition('Turned trending up')],[],{scannerId:'market-regime-engine',reader:1}).some(e=>e.kind==='entry'),'control interpretation remains unchanged');
});
test('Smart Money accepts dynamic OB and FVG first-retest messages and preserves source grade toggles',()=>{
 for(const side of ['long','short'] as const)for(const kind of ['A-OB Retest','B-OB Retest','C-OB Retest','FVG Retest']){
  const text=`${side==='long'?'🟢':'🔴'} ${kind} | DELTA:INJUSD | 12.25`;
  const e=extractEvents([alert(text)],[],opts('smart-money-retests-v1'));
  assert.equal(e.length,1);assert.equal(e[0].kind,'entry');assert.equal(e[0].side,side);assert.equal(e[0].price,12.25);assert.equal(e[0].sl,undefined);assert.deepEqual(e[0].tp,[]);
 }
 const e=extractEvents([alert(JSON.stringify({event:'ob_entry',ticker:'DELTA:INJUSD',direction:'bear',price:.009,grade:'A'}))],[],opts('smart-money-retests-v1'));
 assert.equal(e[0].side,'short');assert.equal(e[0].price,.009);
});
test('Smart Money cannot promote OTE, BOS drawings, sweeps, ungated static retests or malformed payloads into orders',()=>{
 const messages=['🟢 OTE Entry | DELTA:INJUSD | 12','🟢 BOS | DELTA:INJUSD | 12','🔴 BSL Sweep | DELTA:INJUSD | 12','{"event":"ob_entry","ticker":"INJUSD","direction":"bull","price":12}','{"event":"ob_entry","ticker":"INJUSD","direction":"bull","price":"12","grade":"A"}','{bad}','🟢 A-OB Retest | DELTA:INJUSD | NaN'];
 const e=extractEvents([...messages.map(alert),condition('Bullish OB Retest'),condition('Bearish FVG Retest')],[shape('Long')],{...opts('smart-money-retests-v1'),drawn:[{text:'BOS',time:T-H,createdAt:T,y:100,style:'label_up'}]});
 assert.ok(e.every(x=>x.kind==='info'));
 assert.equal(extractEvents([{...alert('🟢 A-OB Retest | INJUSD | 12'),time:T-1}],[],opts('smart-money-retests-v1')).length,0);
 assert.ok(extractEvents([alert('🟢 A-OB Retest | INJUSD | 12')],[],{...opts('smart-money-retests-v1'),sources:['shape']}).every(x=>x.kind!=='entry'));
});
test('ML RSI accepts exact classifier messages once per side/bar; flips and loosely matching titles remain context',()=>{
 const e=extractEvents([alert('🟢 LONG | SOLUSD (15) Rank 83 / Conf 91'),condition('Long Signal'),condition('Trend Flip Down'),condition('Long Signal Invalidated')],[shape('Long'),shape('Long'),shape('ST Flip Dn'),shape('ST Flip Up'),shape('Longer')],opts('ml-rsi-classifier-v1'));
 assert.equal(e.filter(x=>x.kind==='entry').length,1);assert.equal(e.find(x=>x.kind==='entry')!.side,'long');assert.equal(e.find(x=>x.kind==='entry')!.source,'alert');
 const s=extractEvents([condition('Short Signal')],[shape('Short')],opts('ml-rsi-classifier-v1'));assert.equal(s.length,1);assert.equal(s[0].side,'short');
 for(const unknown of [alert('▲ Trend Up | SOLUSD (15)'),alert('🔴 SHORT | random text'),condition('Long Win')])assert.ok(extractEvents([unknown],[],opts('ml-rsi-classifier-v1')).every(x=>x.kind==='info'));
 assert.equal(extractEvents([], [shape('ST Flip Up')],{scannerId:ENTRY_CONTRACTS['ml-rsi-classifier-v1'].scannerId,reader:1})[0].kind,'entry','legacy interpretation remains frozen');
});
function config(){const c=structuredClone(DEFAULT_CONFIG);c.execution.mode='paper';c.execution.allowProduction=false;c.incubator.enabled=true;for(const x of Object.values(ENTRY_CONTRACTS))c.scanners[x.scannerId]={enabled:false,symbols:null,timeframes:null,exitMode:'both'};return c;}
test('contract config is research-only, versioned, source-specific and cannot change comparison execution',()=>{
 const c=config();c.executionPlans=structuredClone(CONTRACT_PLANS);assert.deepEqual(validateConfig(c),[]);
 const p=c.executionPlans[1];p.readingOverride!.signalContract='ml-rsi-classifier-v1';assert.ok(validateConfig(c).some(e=>e.includes('signal contract')));
 c.executionPlans=structuredClone(CONTRACT_PLANS);c.executionPlans[0].maxHoldMinutes=10;assert.ok(validateConfig(c).some(e=>e.includes('differ only in reading')));
 c.executionPlans=[];c.scanners['market-regime-engine'].signalContract='market-regime-context-v1';assert.ok(validateConfig(c).some(e=>e.includes('shadow-plan readings only')));
 const base=config(),p1=planSnapshot(base,CONTRACT_PLANS[0]),p2=planSnapshot(base,CONTRACT_PLANS[1]);assert.deepEqual(p1.paper,p2.paper);assert.notEqual(p1.signature,p2.signature);
 const identity=strategyIdentity('source',base,'market-regime-engine');base.scanners['market-regime-engine'].signalContract='market-regime-context-v1';assert.notEqual(strategyIdentity('source',base,'market-regime-engine'),identity);
});
test('activation is dry-run safe, private, additive, idempotent and refuses drift or edited arms',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'entry-contracts-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'config.json');
 const c=config();fs.writeFileSync(file,JSON.stringify(c));const before=fs.readFileSync(file,'utf8');
 assert.equal(enableEntryContracts(file,true).changed,true);assert.equal(fs.readFileSync(file,'utf8'),before);
 assert.throws(()=>enableEntryContracts(file,false,'stale'),/changed since preflight/);
 enableEntryContracts(file);assert.equal(fs.statSync(file).mode&0o777,0o600);const next=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(next.executionPlans.length,6);delete next.executionPlans;delete(c as any).executionPlans;assert.deepEqual(next,c);
 assert.equal(enableEntryContracts(file).changed,false);
 const edited=JSON.parse(fs.readFileSync(file,'utf8'));edited.executionPlans[0].label='edited';fs.writeFileSync(file,JSON.stringify(edited));assert.throws(()=>enableEntryContracts(file),/will not be overwritten/);
});
test('same raw run reaches both arms, keeps current fills and isolates context/no-signal outcomes from promotion',t=>{
 const registry=new ScannerRegistry();
 for(const contract of Object.keys(ENTRY_CONTRACTS) as SignalContract[]){
  const c=config(),pin=ENTRY_CONTRACTS[contract],s=registry.get(pin.scannerId)!;
  Object.assign(c.paper,{marginPerTrade:150,initialEquity:1000,sizingMode:'margin',maxStopLossPct:3,latencyMs:100,fillSource:'tape',maxSignalAgeSec:0,minRiskFeeRatio:0,useSpread:false,requireQuote:false,slippageBps:0,quotedSlippageBps:0,depthUsdPerBp:0,liquidation:false,limitEntry:undefined,trailAfterR:0,floorAtR:0,trendGate:{enabled:false,emaLen:50,tf:'',mode:'follow'}});
  c.paper.marginLeverage={base:5,strong:5,weak:5,minTrades:20,lookback:30,strongAboveR:.05,weakBelowR:-.05};
  c.executionPlans=structuredClone(CONTRACT_PLANS.filter(p=>p.scannerId===pin.scannerId));
  const [control,candidate]=c.executionPlans,step=control.tf==='1h'?3600000:H;
  const db=new Db(':memory:');t.after(()=>db.db.close());let now=T;
  const paper=new PaperEngine(db,()=>c,{book:2,now:()=>now});paper.causalExits=true;paper.sourceHashFor=()=>pin.runtime;
  const svc=new PlanComparisons(db,()=>c,paper,()=>pin.runtime);
  const alerts=contract==='market-regime-context-v1'?[{...condition('Turned trending up'),time:T-step}]:contract==='smart-money-retests-v1'?[{...alert('🟢 A-OB Retest | INJUSD | 100'),time:T-step},{...condition('Bullish OB Retest'),time:T-step}]:[{...condition('Long Signal'),time:T-step}];
  const bars=Array.from({length:60},(_,i)=>({time:T-(60-i)*step,open:100,high:102,low:98,close:100,volume:100}));
  const input={scannerId:s.id,scannerName:s.name,symbol:control.symbol,tf:control.tf,patched:s.patched,since:T-step,newLabelKeys:new Set<string>(),bars,market:{tickSize:.01,contractValue:.01},at:T,refPrice:100,refusal:()=>null,result:{id:1,ok:true,ms:2,bars:60,lastBarTime:T-step,warnings:0,alerts,shapes:[],labels:[],plots:[]}};
  const frozen=JSON.stringify(c);svc.observeScan(input);svc.observeScan(input);
  now=T+200;paper.onTrade(control.symbol,100,1000000,now,now);
  assert.equal(paper.openPositions().length,contract==='market-regime-context-v1'?1:2);
  assert.equal(JSON.stringify(c),frozen);
  assert.equal(db.get<any>('SELECT count(*) n FROM execution_plan_scans')!.n,2);
  assert.equal(db.get<any>(`SELECT count(*) n FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE ${eligibleEvidence}`)!.n,0);
  assert.ok(db.all<any>('SELECT evidence_scope FROM positions').every(p=>p.evidence_scope==='experiment'));
  const a=planSnapshot(c,control,pin.runtime),b=planSnapshot(c,candidate,pin.runtime);assert.deepEqual(a.paper,b.paper);
  assert.equal(paper.openPositions().filter(p=>p.scannerId===planScannerId(a)).length,1,'current reader retains its trade');
  assert.equal(svc.view().comparisons[0].sharedSignals,contract==='market-regime-context-v1'?0:1,JSON.stringify({contract,events:db.all('SELECT source_event,action FROM execution_plan_events')}));
  // Rejected candidate observations stay visible without a fill; unchanged control evidence is retained.
  const after=paper.trades();svc.observeScan({...input,at:T+step,bars:bars.map(b=>({...b,time:b.time+step})),since:T,result:{...input.result,lastBarTime:T,alerts:alerts.map(a=>({...a,time:T}))},refusal:()=> 'market: unchanged gate'});
  assert.ok(db.all<any>("SELECT action,reason FROM execution_plan_events WHERE at=?",T+step).every(e=>e.action==='rejected'));
  assert.deepEqual(paper.trades(),after);
 }
});

test('six new comparison arms remain inside a bounded research capacity; overflow is refused',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'entry-contract-cap-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'config.json');
 const c=config();c.executionPlans=Array.from({length:MAX_RESEARCH_PLANS-5},(_,i)=>({...structuredClone(CONTRACT_PLANS[0]),id:`existing-${i}`,comparison:undefined}));fs.writeFileSync(file,JSON.stringify(c));const before=fs.readFileSync(file,'utf8');
 assert.throws(()=>enableEntryContracts(file),new RegExp(String(MAX_RESEARCH_PLANS)));assert.equal(fs.readFileSync(file,'utf8'),before);
});
