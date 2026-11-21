import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {Journal} from '../analytics/journal.ts';
import {DEFAULT_CONFIG,TF_SECONDS} from '../config.ts';
import {PaperEngine} from './engine.ts';
import {feeFor} from './logic.ts';
import {planSnapshot,planScannerId,planBacktest,validateExecutionPlans} from './executionPlans.ts';
import {SOL_MAKER_REFERENCE,SOL_MAKER_TICK_REFERENCE,SOL_MAKER_SCANNER} from '../research/solMakerStudy.ts';
import {OpenTradeMonitor} from '../research/openTradeMonitor.ts';
import {eligibleEvidence} from '../evidence/trades.ts';
import {makerDepthEvidence} from './partialMaker.ts';
import type {ExitBook} from './exitExecution.ts';
const T=1800000000000;
function setup(t:any,side:'long'|'short'='long',candidate=true){
 const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);let now=T;
 Object.assign(cfg.paper,{initialEquity:1000,marginPerTrade:150,marginLeverage:{base:5,strong:5,weak:5,strongAboveR:1,weakBelowR:-1,minTrades:30,lookback:30},
  fillSource:'candles',latencyMs:100,requireQuote:true,useSpread:true,quoteMaxAgeMs:1000,liquidation:false,minRiskFeeRatio:0,maxSignalAgeSec:0,skipScriptStops:false,slippageBps:0,quotedSlippageBps:0,trailAfterR:0,floorAtR:0,scalperOffer:undefined});
 cfg.scanners[SOL_MAKER_SCANNER]={enabled:true,symbols:null,timeframes:null,exitMode:'both',entryLimit:{tfs:['15m'],atr:.1,minutes:5}};
 const plan={...(candidate?SOL_MAKER_TICK_REFERENCE:SOL_MAKER_REFERENCE),enabled:true};cfg.executionPlans=[plan];
 const snap=planSnapshot(cfg,plan,'source');let book:ExitBook|null=null;
 const wire=(e:PaperEngine)=>{e.causalExits=true;e.quotes={executable:(_s,side)=>side==='buy'?100.01:99.99};e.makerFillBook=()=>book;return e;};
 const e=wire(new PaperEngine(db,()=>cfg,{book:2,now:()=>now}));
 const enter=()=>e.onEntry({kind:'entry',side,price:100,sl:side==='long'?98:102,tp:side==='long'?[110,115,120]:[90,85,80],label:'entry',message:'',source:'shape',barTime:T-900000,barIndex:1},
 {scannerId:planScannerId(snap),scannerName:'SOL study',symbol:'SOLUSD',tf:'15m',executionPlan:snap,market:{contractValue:1,tickSize:.01},refPrice:100,at:T,signalId:null,exitMode:'both',atr:1});
 const depth=(offset:number,bid=99.99,ask=100.01,engine=e)=>{now=T+offset;book={receivedAt:now,exchangeAt:now,bids:[{price:bid,size:1000}],asks:[{price:ask,size:1000}]};engine.observeMakerBook('SOLUSD',book,now);};
 const tick=(qty:number,offset:number,id=String(offset),engine=e)=>{now=T+offset;engine.onTrade('SOLUSD',side==='long'?99.8:100.2,qty,now-1,now,id);};
 return {db,cfg,snap,e,enter,depth,tick,set:(n:number)=>now=T+n,get:()=>now,clear:()=>book=null,restore:()=>wire(new PaperEngine(db,()=>cfg,{book:2,now:()=>now}))};
}
for(const side of ['long','short'] as const)test('tick/depth maker '+side+' keeps partial size, fees, first-fill clock, depth and original risk',t=>{
 const f=setup(t,side);const before=JSON.stringify(f.cfg);assert.equal(f.enter().action,'pending');const target=f.e.pendingEntries()[0].reservation!.qty;
 f.depth(50);f.tick(100,60);assert.equal(f.e.openPositions().length,0,'arrival latency');
 f.depth(100);f.tick(1,200);const p=f.e.openPositions()[0];assert.equal(p.qty,1);assert.equal(p.qtyOpen,1);assert.equal(p.entryAt,T+200);
 assert.equal(p.fees,feeFor(p.entryPrice,1,1,f.snap.paper,true));assert.equal(f.e.pendingEntries().length,1);
 f.tick(1,201,'200');assert.equal(p.qty,1,'same print cannot be spent twice');
 f.depth(300);f.tick(100,301);assert.equal(p.qty,target);assert.equal(p.qtyOpen,target);assert.equal(p.entryAt,T+200);
 assert.equal(f.e.pendingEntries().length,0);assert.equal(p.fills.filter(x=>x.reason==='entry').length,2);
 assert.ok(Math.abs(p.fees-feeFor(p.entryPrice,target,1,f.snap.paper,true))<1e-10);
 assert.equal(f.e.exitExecution.state(p.id)!.market_qty,target);
 const rows=f.db.all<any>('SELECT * FROM paper_maker_reports ORDER BY at');assert.deepEqual(rows.map(x=>x.qty),[1,target-1]);
 const detail=new Journal(f.db).detail('shadow',p.id);assert.equal(detail.makerFillReports.length,2);assert.equal(detail.makerFillReports[0].qty,1);
 for(const r of rows){const ev=JSON.parse(r.evidence);assert.equal(ev.source,'limit-tick-depth-model');assert.equal(ev.limit.fillDepth.source,'l2-ws');assert.ok(ev.limit.fillDepth.receivedAt<=r.at);}
 assert.equal(JSON.stringify(f.cfg),before);
});
test('candles cannot fill the candidate; crossing at arrival, missing/stale depth and stale prints cannot create fills',t=>{
 const f=setup(t);f.enter();f.depth(100);
 f.e.onBar('SOLUSD',{time:T+60000,high:102,low:95,close:99,volume:10000},T+61000);assert.equal(f.e.openPositions().length,0);
 f.clear();f.tick(100,200);assert.equal(f.e.openPositions().length,0);
 f.depth(300);f.tick(100,1401);assert.equal(f.e.openPositions().length,0);
 f.depth(1500);f.e.onTrade('SOLUSD',99.8,100,T+100,T+1600);assert.equal(f.e.openPositions().length,0);
 f.tick(1,1601);assert.equal(f.e.openPositions()[0].qty,1);
 const crossed=setup(t);crossed.enter();crossed.depth(100,99.7,99.8);assert.equal(crossed.e.pendingEntries().length,0);assert.equal(crossed.e.openPositions().length,0);
});
test('restarting a partial order retains exposure and fees but cannot fill from downtime',t=>{
 const f=setup(t);f.enter();f.depth(100);f.tick(1,200);const p=f.e.openPositions()[0],fee=p.fees;f.set(5000);
 const e=f.restore();assert.equal(e.openPositions()[0].qty,1);assert.equal(e.openPositions()[0].fees,fee);assert.equal(e.pendingEntries().length,1);
 f.depth(5100,99.99,100.01,e);e.onTrade('SOLUSD',99.8,100,T+4900,T+5200,'old');assert.equal(e.openPositions()[0].qty,1);
 f.tick(100,5300,'new',e);assert.ok(e.openPositions()[0].qty>1);assert.equal(e.openPositions()[0].entryAt,T+200);
});
test('a stop while partially filled cancels only the remainder and protects exactly filled size',t=>{
 const f=setup(t);f.enter();f.depth(100);f.tick(1,200);const p=f.e.openPositions()[0];f.set(300);
 f.e.onTrade('SOLUSD',97,100,T+299,T+300,'stop');assert.equal(p.qty,1);assert.equal(f.e.pendingEntries().length,0);
 const intent=f.e.exitExecution.active(p.id)!;assert.equal(intent.qty,1);assert.equal(intent.market_qty,1);
 f.e.settleExits('SOLUSD',{receivedAt:T+500,exchangeAt:T+500,bids:[{price:96.9,size:100}],asks:[{price:97,size:100}]},T+500);
 assert.equal(p.status,'closed');assert.equal(p.fills.at(-1)!.qty,1);
});
test('expiry and write failure preserve filled exposure and do not double spend a print',t=>{
 const f=setup(t);f.enter();f.depth(100);
 f.db.run("CREATE TRIGGER fail_maker BEFORE INSERT ON paper_maker_reports BEGIN SELECT RAISE(ABORT,'test failure'); END");
 f.tick(1,200);assert.equal(f.e.openPositions().length,0);assert.equal(f.e.pendingEntries().length,1);
 f.db.run('DROP TRIGGER fail_maker');f.tick(1,201,'200');assert.equal(f.e.openPositions()[0].qty,1);
 f.set(300001);f.e.housekeeping(f.get());assert.equal(f.e.pendingEntries().length,0);assert.equal(f.e.openPositions()[0].qty,1);
});
test('old reference remains candle based; candidate identity and candle backtest eligibility stay separate',t=>{
 const f=setup(t,'long',false);f.enter();f.depth(100);f.tick(100,200);assert.equal(f.e.openPositions().length,0);
 f.e.onBar('SOLUSD',{time:T+60000,high:101,low:99.8,close:100,volume:100},T+61000);assert.ok(f.e.openPositions()[0]);
 const g=setup(t);assert.notEqual(g.snap.signature,f.snap.signature);assert.throws(()=>planBacktest(g.snap),/recorded ticks and depth/);
 assert.equal(validateExecutionPlans(g.cfg.executionPlans,TF_SECONDS,g.cfg).length,0);
 assert.ok(validateExecutionPlans([{...g.cfg.executionPlans![0],symbol:'BTCUSD'}],TF_SECONDS,g.cfg).length);
 assert.deepEqual(g.cfg.risk,f.cfg.risk);
});
test('depth evidence refuses future, gapped/missing, crossed or insufficient books',()=>{
 const good={receivedAt:T,exchangeAt:T,bids:[{price:99,size:20}],asks:[{price:100,size:20}]};
 assert.ok(makerDepthEvidence(good,T,11,1));
 for(const book of [null,{...good,receivedAt:T+1},{...good,exchangeAt:T-1001},{...good,bids:[{price:101,size:20}]},{...good,asks:[{price:100,size:1}]}])assert.equal(makerDepthEvidence(book,T,11,1),null);
});

test('tick/depth half-stop stays advisory and quantity changes invalidate the comparison',t=>{
 const f=setup(t);f.enter();f.depth(100);f.tick(100,200);const p=f.e.openPositions()[0];const monitor=new OpenTradeMonitor(f.db,T);
 const cfgBefore=JSON.stringify(f.cfg),before=JSON.stringify(p),at=T+700,price=p.entryPrice-.6*Math.abs(p.entryPrice-p.slOriginal!);
 const input=()=>[{position:p,book:2,scope:'experiment',...f.e.advisoryObservation(p)}];
 monitor.observe(input(),new Map([['SOLUSD',{symbol:'SOLUSD',at,price,priceAt:at,depth:null,depthAt:null,flow:{covered:false,imbalance:null,throughAt:null,availableAt:null,minutes:0}}]]),()=>null,at);
 monitor.settle('SOLUSD',{receivedAt:at+4000,exchangeAt:at+4000,bids:[{price,size:1000}],asks:[{price:price+.01,size:1000}]},at+4000,()=>p);
 assert.equal(f.db.get<any>("SELECT count(*) n FROM advisory_exits WHERE rule LIKE 'scanner-half-stop%' AND status='filled'").n,2);
 assert.equal(JSON.stringify(p),before);assert.equal(JSON.stringify(f.cfg),cfgBefore);assert.equal(f.e.pendingExits().length,0);
 assert.equal(f.db.get<any>(`SELECT count(*) n FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE ${eligibleEvidence}`).n,0);
 f.db.run("UPDATE positions SET status='closed',exit_at=?,exit_reason='sl',realized_pnl=-10,fees=0 WHERE id=?",at+5000,p.id);monitor.resolve(at+6000);
 assert.equal(monitor.view().scannerExitStudy.groups[0].covered,1);
 f.db.run('UPDATE positions SET qty=qty+1 WHERE id=?',p.id);monitor.resolve(at+7000);
 assert.equal(monitor.view().scannerExitStudy.groups[0].covered,0);
});
test('first partial crossing its stop requests a causal exit, not a favorable stop-level fill',t=>{
 const f=setup(t);f.enter();f.depth(100);f.set(200);f.e.onTrade('SOLUSD',97,1,T+199,T+200,'gap');
 const p=f.e.openPositions()[0];assert.equal(p.qty,1);assert.equal(f.e.pendingEntries().length,0);assert.equal(p.status,'open');assert.ok(f.e.exitExecution.active(p.id));
 f.e.settleExits('SOLUSD',{receivedAt:T+500,exchangeAt:T+500,bids:[{price:96.9,size:100}],asks:[{price:97,size:100}]},T+500);
 assert.equal(p.status,'closed');assert.equal(p.exitPrice,96.9);
});
test('candidate cannot run without the causal paper exit adapter',t=>{
 const f=setup(t);f.enter();f.depth(100);f.e.causalExits=false;f.tick(100,200);assert.equal(f.e.openPositions().length,0);assert.equal(f.e.pendingEntries().length,0);
});
test('invalid partial recovery cancels the remainder while preserving held exposure and protection',t=>{
 const f=setup(t);f.enter();f.depth(100);f.tick(1,200);const p=f.e.openPositions()[0],fee=p.fees;
 f.db.run("UPDATE paper_maker_orders SET state='broken JSON' WHERE position_id=?",p.id);f.set(500);
 const e=f.restore();assert.equal(e.openPositions()[0].qty,1);assert.equal(e.openPositions()[0].fees,fee);assert.equal(e.pendingEntries().length,0);
 assert.equal(f.db.get<any>('SELECT status FROM paper_maker_orders WHERE position_id=?',p.id).status,'cancelled');
 f.set(600);e.onTrade('SOLUSD',97,100,T+599,T+600,'stop');assert.equal(e.exitExecution.active(p.id)!.qty,1);
});

test('funding charges held exposure without cancelling or charging the unfilled remainder',t=>{
 const f=setup(t);f.snap.paper.fundingCharges=true;f.enter();f.depth(100);f.tick(1,200);const p=f.e.openPositions()[0];
 f.e.onMarkPrice('SOLUSD',100,T+250);f.set(300);assert.equal(f.e.chargeFunding('SOLUSD',.01,T+300),1);
 assert.equal(p.realizedPnl,-.01);assert.equal(f.e.pendingEntries().length,1);assert.equal(p.qty,1);
 f.depth(400);f.tick(100,401);assert.ok(p.qty>1);assert.equal(p.realizedPnl,-.01);assert.equal(p.fills.filter(f=>f.reason==='funding').length,1);
});

test('failed arrival persistence cannot fill and retries on a later fresh book',t=>{
 const f=setup(t);f.enter();
 f.db.run("CREATE TRIGGER fail_arrival BEFORE UPDATE OF fills ON positions WHEN NEW.status='pending' BEGIN SELECT RAISE(ABORT,'arrival write failed'); END");
 assert.doesNotThrow(()=>f.depth(100));f.tick(100,200);assert.equal(f.e.openPositions().length,0);assert.equal(f.e.pendingEntries()[0].makerArrival,undefined);
 f.db.run('DROP TRIGGER fail_arrival');f.depth(300);f.tick(1,400);assert.equal(f.e.openPositions()[0].qty,1);
});
