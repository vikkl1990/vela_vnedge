import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from '../paper/engine.ts';
import {EntryDepthGate,wireEntryDepth} from '../risk/entryDepth.ts';
import {OpenTradeMonitor} from './openTradeMonitor.ts';
import {INTRABAR_RULE,INTRABAR_STRESS,pressure} from './intrabarProtection.ts';
import type {IntrabarFlowSnapshot} from '../orderflow/intrabar.ts';
const T=1800000000000;
const book=(at:number,price=101,size=10000,side:'long'|'short'='long')=>({receivedAt:at,exchangeAt:at,bids:[{price:side==='long'?price:price-.01,size:side==='long'?size:size*4}],asks:[{price:side==='long'?price+.01:price,size:side==='long'?size*4:size}]});
function flow(at:number,side:'long'|'short'='long'):IntrabarFlowSnapshot{
 const w={trades:20,buy:side==='long'?1:9,sell:side==='long'?9:1,imbalance:side==='long'?-.8:.8,firstPrice:100,lastPrice:side==='long'?99:101};
 return {at,since:T-60000,covered:true,reason:null,lastTradeAt:at,windows:{s5:{...w},s15:{...w},s60:{...w}}};
}
async function fixture(t:any,side:'long'|'short'='long',symbol='INITUSD'){
 const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);let now=T;
 Object.assign(cfg.paper,{initialEquity:1000,sizingMode:'risk',riskPerTradePct:1,maxStopLossPct:0,maxSignalAgeSec:0,minRiskFeeRatio:0,useSpread:true,requireQuote:true,quoteMaxAgeMs:1000,slippageBps:0,quotedSlippageBps:0,feeRatePct:.05,makerFeeRatePct:.02,feeTaxPct:18,liquidation:false,latencyMs:0,trailAfterR:0,floorAtR:0,limitEntry:undefined,skipScriptStops:false,fillSource:'candles'});
 cfg.execution.mode='paper';cfg.risk.marketGate={...cfg.risk.marketGate!,enabled:true,freshDepth:true,maxBookCostPct:1,exempt:[]};
 const engine=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});engine.causalExits=true;engine.sourceHashFor=()=> 'source';engine.quotes={executable:(_s,dir)=>dir==='buy'?100:99.99};
 const gate=new EntryDepthGate({cfg:()=>cfg,now:()=>now,book:async()=>({timestamp:now*1000,buy:[{price:99.99,size:1000000}],sell:[{price:100,size:1000000}]})});wireEntryDepth(engine,engine,gate);await gate.prepare(symbol);
 const d=engine.onEntry({kind:'entry',side,price:100,sl:side==='long'?95:105,tp:[],label:'entry',message:'',source:'alert',barTime:T-900000,barIndex:0},{scannerId:'test-scanner',scannerName:'Test',symbol,tf:'15m',market:{tickSize:.01,contractValue:1},refPrice:100,at:T,signalId:null,exitMode:'both'});
 assert.equal(d.action,'opened',d.reason);const p=d.position!;db.run("UPDATE positions SET evidence_scope='shadow' WHERE id=?",p.id);
 let monitor=new OpenTradeMonitor(db,T-1);
 const input=()=>({position:p,book:2,scope:'shadow',...engine.advisoryObservation(p)});
 const observe=(at:number,netPrice:number,overrides:Partial<ReturnType<typeof input>>={},f=flow(at,side),b=book(at,netPrice,10000,side))=>{now=at;monitor.observeIntrabar({...input(),...overrides},f,b,at);};
 const trigger=()=>{observe(T+100,side==='long'?102:98);observe(T+1100,side==='long'?101:99);observe(T+2100,side==='long'?101:99);};
 const rows=()=>db.all<any>('SELECT * FROM advisory_exits WHERE rule IN (?,?) ORDER BY rule',INTRABAR_RULE,INTRABAR_STRESS);
 const cohort=()=>db.get<any>('SELECT * FROM advisory_intrabar_cohort');
 const close=(net:number,reason='sl',at=T+6000)=>{db.run("UPDATE positions SET status='closed',exit_at=?,exit_reason=?,realized_pnl=?,fees=0 WHERE id=?",at,reason,net,p.id);monitor.resolve(at+1);};
 return {db,cfg,engine,p,input,observe,trigger,rows,cohort,close,get monitor(){return monitor;},restart:(at:number)=>{monitor=new OpenTradeMonitor(db,at);},settle:(at:number,b=book(at,side==='long'?100.9:99.1,10000,side))=>monitor.settle(symbol,b,at,()=>p)};
}
test('intrabar profit protection pairs causal depth fills with unchanged control and cannot modify paper or evidence',async t=>{
 const x=await fixture(t),before=JSON.stringify(x.p),cfg=JSON.stringify(x.cfg),orders=x.db.all('SELECT * FROM orders');
 x.trigger();assert.equal(x.rows().length,2,JSON.stringify(x.cohort()));
 x.settle(T+2100,book(T+2099));assert.ok(x.rows().every(r=>r.status==='waiting'));
 x.settle(T+2200);x.settle(T+5200);assert.ok(x.rows().every(r=>r.status==='filled'));
 assert.ok(x.rows().find(r=>r.rule===INTRABAR_STRESS).net<x.rows().find(r=>r.rule===INTRABAR_RULE).net);
 assert.equal(JSON.stringify(x.p),before);assert.equal(JSON.stringify(x.cfg),cfg);assert.deepEqual(x.db.all('SELECT * FROM orders'),orders);assert.equal(x.engine.pendingExits().length,0);
 x.close(-x.p.riskAmount);const g=x.monitor.view().intrabarStudy.groups[0];assert.equal(g.covered,1);assert.ok(g.deltaR>0);assert.equal(g.stopsBefore,1);assert.equal(g.stopsAfter,0);assert.equal(g.losersAfter,0);
 assert.equal(x.monitor.view().intrabarStudy.promotionEligible,false);assert.equal(x.cohort().promotion_eligible,0);
});
test('majors, alts and memes use symmetric short-side flow and ask execution',async t=>{
 for(const symbol of ['BTCUSD','PARTIUSD','1000PEPEUSD']){const x=await fixture(t,'short',symbol);x.trigger();assert.equal(x.rows().length,2,JSON.stringify(x.cohort()));x.settle(T+5200);const base=JSON.parse(x.rows().find(r=>r.rule===INTRABAR_RULE).payload);assert.equal(base.reports[0].price,99.1);}
});
test('winners cut short and unchanged trades remain in the full paired comparison',async t=>{
 const cut=await fixture(t);cut.trigger();cut.settle(T+5200);cut.close(cut.p.riskAmount,'trail');let g=cut.monitor.view().intrabarStudy.groups[0];assert.equal(g.winnersCut,1);assert.equal(g.winnersLost,0);assert.ok(g.deltaR<0);
 const held=await fixture(t);held.observe(T+100,102);held.observe(T+1100,102);held.close(held.p.riskAmount,'trail',T+2100);g=held.monitor.view().intrabarStudy.groups[0];assert.equal(g.covered,1);assert.equal(g.deltaR,0);
});
test('quiet flow, unknown coverage, stale depth and pending stops cannot trigger',async t=>{
 for(const kind of ['quiet','unknown','depth','pending','favorable']){const x=await fixture(t);x.observe(T+100,102);
  for(const at of [T+1100,T+2100]){const f=flow(at);if(kind==='quiet')f.windows.s60.trades=0;if(kind==='unknown')f.covered=false;if(kind==='favorable')f.windows.s15.imbalance=.8;
   x.observe(at,101,{exitPending:kind==='pending'},f,book(kind==='depth'?T:at));}
  assert.equal(x.rows().length,0,kind);
 }
});
test('old, experimental, maker-model and changed-policy entries never become comparable observations',async t=>{
 const x=await fixture(t);x.observe(T+100,102,{book:0});x.observe(T+100,102,{scope:'experiment'});x.observe(T+100,102,{position:{...x.p,entryAt:T-2}});assert.equal(x.cohort(),undefined);
 x.db.run("UPDATE entry_fill_evidence SET source='limit-candle-model' WHERE position_id=?",x.p.id);x.trigger();assert.equal(x.cohort().status,'unverified');assert.equal(x.rows().length,0);
 const changed=await fixture(t);changed.observe(T+100,102);changed.p.policy!.adoptedAt=T;changed.observe(T+1100,101);assert.equal(changed.cohort().status,'unverified');
});
test('observer gaps, short unseen trades and restarts remain unavailable rather than invented winners',async t=>{
 const gap=await fixture(t);gap.observe(T+100,102);gap.observe(T+4100,101);gap.close(-10);assert.equal(gap.monitor.view().intrabarStudy.groups[0].unavailable,1);
 const unseen=await fixture(t);unseen.close(-10);assert.equal(unseen.monitor.view().intrabarStudy.groups[0].unavailable,1);
 const restart=await fixture(t);restart.trigger();restart.restart(T+2200);restart.settle(T+5200);restart.close(-10);assert.equal(restart.monitor.view().intrabarStudy.groups[0].covered,0);
});
test('trigger and both arms commit atomically; missing fills and real exits stay censored',async t=>{
 const x=await fixture(t);x.observe(T+100,102);x.observe(T+1100,101);
 x.db.db.exec(`CREATE TRIGGER abort_intrabar BEFORE INSERT ON advisory_exits WHEN NEW.rule='${INTRABAR_STRESS}' BEGIN SELECT RAISE(ABORT,'test');END`);
 assert.throws(()=>x.observe(T+2100,101));assert.equal(x.rows().length,0);assert.equal(x.monitor.due(T+6000).length,0);
 const missed=await fixture(t);missed.trigger();missed.monitor.resolve(T+40000);missed.close(-10,'sl',T+41000);assert.equal(missed.monitor.view().intrabarStudy.groups[0].unavailable,1);
 const actual=await fixture(t);actual.trigger();actual.p.fills.push({at:T+2150,qty:actual.p.qty,price:95,pnl:-10,fee:0,reason:'sl'});actual.settle(T+2200);assert.ok(actual.rows().some(r=>r.status==='censored'));
});
test('a single print or order-book imbalance alone is insufficient',()=>{
 const f=flow(T);f.windows.s5.firstPrice=f.windows.s5.lastPrice;assert.equal(pressure(f,book(T),'long',T).adverse,false);
 f.windows.s5.firstPrice=110;f.windows.s15.imbalance=0;assert.equal(pressure(f,book(T),'long',T).adverse,false);
});

test('quarantine and late accounting changes stay visible and cannot restore a disqualified cohort',async t=>{
 const x=await fixture(t);x.trigger();x.settle(T+5200);x.close(-x.p.riskAmount);
 const before=x.monitor.view().intrabarStudy.groups[0];assert.equal(before.covered,1);
 x.db.run('UPDATE positions SET fills=?,realized_pnl=realized_pnl-2 WHERE id=?',JSON.stringify({fills:[...x.p.fills,{at:T+2150,price:100,qty:0,pnl:-2,fee:0,reason:'funding'}]}),x.p.id);
 x.monitor.resolve(T+7000);const after=x.monitor.view().intrabarStudy.groups[0];assert.ok(after.candidateNet<before.candidateNet);assert.ok(after.baselineNet<before.baselineNet);
 x.db.run("INSERT INTO evidence_flags(position_id,entry_at,status,reason,source,checked_at) VALUES(?,?,'quarantined','test','test',?)",x.p.id,x.p.entryAt,T+7001);
 x.monitor.resolve(T+7100);assert.equal(x.monitor.view().intrabarStudy.groups[0].covered,0);
 x.db.run("UPDATE evidence_flags SET status='cleared' WHERE position_id=?",x.p.id);x.monitor.resolve(T+7200);assert.equal(x.monitor.view().intrabarStudy.groups[0].covered,0);
});
