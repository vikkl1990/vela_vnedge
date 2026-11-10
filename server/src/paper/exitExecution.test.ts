import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from './engine.ts';
import {PaperExitExecution,priceExit,type ExitBook} from './exitExecution.ts';
import {TapeAudit} from '../execution/tapeAudit.ts';
import {fillExit} from './logic.ts';

const T=1_800_000_000_000;
const book=(at:number,bid=93,ask=94,size=10000):ExitBook=>({receivedAt:at,exchangeAt:at,bids:[{price:bid,size}],asks:[{price:ask,size}]});
function setup(t:any,causal=true,side:'long'|'short'='long',over:Record<string,unknown>={},which=0){
 const db=new Db(':memory:');t.after(()=>db.db.close());let now=T;
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.execution.mode='paper';
 Object.assign(cfg.paper,{initialEquity:1000,sizingMode:'risk',riskPerTradePct:1,maxStopLossPct:0,maxSignalAgeSec:0,minRiskFeeRatio:0,useSpread:false,requireQuote:false,slippageBps:0,feeRatePct:0,makerFeeRatePct:0,liquidation:false,latencyMs:100,trailAfterR:0,floorAtR:0,trendExit:undefined,earlyStall:undefined,limitEntry:undefined,skipScriptStops:false,...over});
 let e=new PaperEngine(db,()=>cfg,{now:()=>now,book:which});e.causalExits=causal;e.sourceHashFor=()=> 'source';
 const d=e.onEntry({kind:'entry',side,price:100,sl:side==='long'?95:105,tp:[],label:'entry',message:'',source:'alert',barTime:0,barIndex:0},{scannerId:'test',scannerName:'test',symbol:'BTCUSD',tf:'15m',market:{tickSize:.01,contractValue:1},refPrice:100,at:now,signalId:null,exitMode:'both'});
 now+=200;e.onBar('BTCUSD',{time:T,high:100,low:100,close:100},now);
 const p=e.position(d.pendingId??d.position!.id)!;assert.ok(p);assert.equal(p.status,'open');
 return {db,cfg,p,get e(){return e;},get now(){return now;},at:(x:number)=>{now=x;},restart:()=>{e=new PaperEngine(db,()=>cfg,{now:()=>now,book:which});e.causalExits=causal;return e.position(p.id)!;}};
}
test('same candle: old engine books the stop; causal engine retains exposure until executable report',t=>{
 const old=setup(t,false),fresh=setup(t);old.at(T+300);fresh.at(T+300);
 for(const x of [old,fresh])x.e.onBar('BTCUSD',{time:T,high:100,low:94,close:94},x.now);
 assert.equal(old.p.exitPrice,95);assert.equal(fresh.p.status,'open');assert.equal(fresh.p.fills.length,1);
 assert.equal(fresh.e.pendingExits()[0].ready_at,T+400);
 assert.equal(fresh.e.settleExits('BTCUSD',book(T+399),T+399),0);
 fresh.at(T+400);assert.equal(fresh.e.settleExits('BTCUSD',book(T+400),T+400),1);
 assert.equal(fresh.p.exitPrice,93);assert.equal(fresh.p.exitAt,T+400);assert.equal(fresh.p.riskAmount,old.p.riskAmount);
 assert.equal(fresh.db.get<any>('SELECT price_source FROM orders WHERE reason=?','sl')!.price_source,'depth');
 assert.equal(fresh.e.settleExits('BTCUSD',book(T+401),T+401),0);
});
test('new candle-mode positions react to live trades and shorts buy executable asks',t=>{
 const x=setup(t,true,'short');x.at(T+300);x.e.onTrade('BTCUSD',106,1,T+299,T+300);
 assert.equal(x.e.pendingExits()[0].trigger_at,T+300);assert.equal(x.p.status,'open');
 x.at(T+400);x.e.settleExits('BTCUSD',book(T+400,106,107),T+400);assert.equal(x.p.exitPrice,107);
});
test('missing, stale, future and pre-arrival depth cannot close an exit or release margin',t=>{
 const x=setup(t);x.at(T+300);x.e.onTrade('BTCUSD',94,1,T+300,T+300);const qty=x.p.qtyOpen,fees=x.p.fees;
 for(const b of [null,book(T+399),book(T+401),{...book(T+400),exchangeAt:T-10000}])x.e.settleExits('BTCUSD',b,T+400);
 assert.equal(x.p.qtyOpen,qty);assert.equal(x.p.fees,fees);assert.equal(x.p.status,'open');assert.equal(x.e.pendingExits().length,1);
 assert.equal(x.db.get<any>('SELECT count(*) n FROM paper_exit_reports')!.n,0);
});
test('partial exit, restart and repeated snapshot preserve residual exposure exactly',t=>{
 const x=setup(t);assert.equal(x.p.qty,2);x.at(T+300);x.e.onTrade('BTCUSD',94,1,T+300,T+300);
 x.at(T+400);x.e.settleExits('BTCUSD',book(T+400,93,94,1),T+400);
 assert.equal(x.p.qtyOpen,1);assert.equal(x.p.status,'open');assert.equal(x.e.pendingExits()[0].status,'partial');
 const p=x.restart();x.at(T+500);x.e.settleExits('BTCUSD',book(T+400,93,94,1),T+500);assert.equal(p.qtyOpen,1);
 x.at(T+600);x.e.settleExits('BTCUSD',book(T+600,92,94,1),T+600);assert.equal(p.status,'closed');
 assert.equal(p.fills.slice(1).reduce((s,f)=>s+f.qty,0),2);assert.equal(p.realizedPnl,-15);assert.equal(x.e.pendingExits().length,0);
});
test('duplicate exit requests do not create duplicate sells, and a rebound does not cancel a sent market exit',t=>{
 const x=setup(t);x.at(T+300);x.e.onTrade('BTCUSD',94,1,T+300,T+300);x.e.closeManual(x.p.id);x.e.closeManual(x.p.id);
 assert.equal(x.db.get<any>('SELECT count(*) n FROM paper_exit_intents')!.n,1);assert.equal(x.p.status,'open');
 x.at(T+400);x.e.settleExits('BTCUSD',book(T+400,97,98),T+400);assert.equal(x.p.exitPrice,97);
});
test('report-write failure rolls back fill, liquidity consumption and emitted closure',t=>{
 const x=setup(t);let closed=0;x.e.on('trade',()=>closed++);x.at(T+300);x.e.onTrade('BTCUSD',94,1,T+300,T+300);
 x.db.db.exec("CREATE TRIGGER fail_report BEFORE INSERT ON paper_exit_reports BEGIN SELECT RAISE(ABORT,'test failure'); END");
 x.at(T+400);x.e.settleExits('BTCUSD',book(T+400),T+400);
 assert.equal(x.p.status,'open');assert.equal(x.p.fills.length,1);assert.equal(closed,0);
 assert.equal(x.db.get<any>('SELECT count(*) n FROM paper_exit_liquidity')!.n,0);
 x.db.db.exec('DROP TRIGGER fail_report');x.e.settleExits('BTCUSD',book(T+400),T+400);assert.equal(x.p.status,'closed');assert.equal(closed,1);
});
test('historical extremes cannot create a backdated exit or a retrospective trail',t=>{
 const x=setup(t);x.at(T+120000);x.e.onBar('BTCUSD',{time:T,high:150,low:80,close:100},x.now,{historical:true});
 assert.equal(x.e.pendingExits().length,0);assert.equal(x.p.sl,95);
 x.e.onTrade('BTCUSD',94,1,x.now,x.now);assert.equal(x.e.pendingExits()[0].trigger_at,x.now);
});
test('desired trail becomes active only after its acknowledgement, including restart',t=>{
 const x=setup(t,true,'long',{trailAfterR:.5,trailGiveBackPct:10,floorAtR:0});
 x.at(T+300);x.e.onTrade('BTCUSD',103,1,x.now,x.now);assert.equal(x.p.sl,95);assert.ok(x.e.view(x.p).execution!.desiredStop!>102);
 const p=x.restart();x.at(T+350);x.e.onTrade('BTCUSD',102.5,1,x.now,x.now);assert.equal(p.sl,95);assert.equal(x.e.pendingExits().length,0);
 x.at(T+400);x.e.onTrade('BTCUSD',102.5,1,x.now,x.now);assert.ok(p.sl!>102.5);assert.equal(x.e.pendingExits()[0].reason,'trail');
});
test('old bound policies retain the legacy model and do not silently acquire new evidence semantics',t=>{
 const x=setup(t,false);x.p.policy!.sim=210;x.e.causalExits=true;x.at(T+300);
 x.e.onBar('BTCUSD',{time:T,high:100,low:94,close:94},x.now);assert.equal(x.p.status,'closed');assert.equal(x.p.exitPrice,95);assert.equal(x.e.pendingExits().length,0);
});
test('depth price is exact and charges taker commission/tax without a second impact or slippage charge',t=>{
 const x=setup(t);const cfg={...x.cfg.paper,slippageBps:100,depthUsdPerBp:1,feeRatePct:.05,feeTaxPct:18};
 const f=fillExit(x.p,93,1,'sl',T+300,cfg,'depth');assert.equal(f.price,93);assert.equal(f.liquidity,'taker');assert.ok(Math.abs(f.fee-93*.0005*1.18)<1e-12);
});
test('book reset cancels outstanding simulated exits without a later phantom fill',t=>{
 const x=setup(t);x.at(T+300);x.e.onTrade('BTCUSD',94,1,x.now,x.now);x.e.reset();assert.equal(x.e.pendingExits().length,0);assert.equal(x.e.settleExits('BTCUSD',book(T+400),T+400),0);
});
test('pure depth walk validates data and uses the correct side and available integer size',()=>{
 const b={...book(T),bids:[{price:93,size:1},{price:92,size:2}]};
 assert.equal(priceExit(b,'long',2,T,1000).price,92.5);assert.equal(priceExit(b,'short',2,T,1000).price,94);
 assert.equal(priceExit(b,'long',10,T,1000).qty,3);
 for(const bad of [book(T+1),{...book(T),asks:[]},{...book(T),bids:[{price:95,size:1}]},{...book(T),bids:[{price:93,size:1.5}]}])assert.ok(priceExit(bad,'long',2,T,1000).error);
});

test('account exits share observed liquidity; independent shadow trials use frozen deployable size',t=>{
 const x=setup(t);const a=x.e.exitExecution,b=new PaperExitExecution(x.db,2);
 const p1=structuredClone(x.p),p2={...structuredClone(x.p),id:1001},p3={...structuredClone(x.p),id:1002,qty:1000,qtyOpen:1000},p4={...structuredClone(x.p),id:1003,qty:1000,qtyOpen:1000};
 a.register(p2,2);b.register(p3,2);b.register(p4,2);
 for(const [store,p] of [[a,p1],[a,p2],[b,p3],[b,p4]] as const)store.request(p,'sl',p.qtyOpen,94,T+300,100);
 const snap=book(T+400,93,94,1);
 const settle=(store:PaperExitExecution,p:typeof p1)=>store.settle(p,snap,T+400,1000,q=>{p.qtyOpen-=q;});
 assert.equal(settle(a,p1),true);assert.equal(p1.qtyOpen,1);assert.equal(settle(a,p2),false);assert.equal(p2.qtyOpen,2);
 assert.equal(settle(b,p3),true);assert.equal(settle(b,p4),true);assert.equal(p3.qtyOpen,500);assert.equal(p4.qtyOpen,500);
});
test('funding avoidance starts its re-entry block on accepted exit while keeping exposure held',t=>{
 const x=setup(t);x.at(T+300);assert.equal(x.e.closeForFunding(x.p.id,x.now),true);
 assert.equal(x.p.status,'open');assert.equal(x.p.qtyOpen,2);assert.equal(x.e.pendingExits()[0].reason,'funding-avoid');
 x.at(T+400);x.e.settleExits('BTCUSD',book(x.now),x.now);assert.equal(x.p.status,'closed');
});
test('missing execution registration cannot silently downgrade a new position to optimistic fills',t=>{
 const x=setup(t);x.db.run('DELETE FROM paper_execution_positions WHERE position_id=?',x.p.id);
 x.at(T+300);x.e.onTrade('BTCUSD',94,1,x.now,x.now);
 assert.equal(x.p.status,'open');assert.equal(x.p.fills.length,1);
});

test('depth exits audit only subsequent prints and retain trigger/arrival provenance',t=>{
 const x=setup(t);const audit=new TapeAudit(x.db,[{engine:x.e,book:0}]);
 const print=(price:number,timeMs:number)=>audit.onTrade({symbol:'BTCUSD',price,qty:1,timeMs,aggressor:null});
 x.at(T+300);print(90,T+299);x.e.onTrade('BTCUSD',94,1,x.now,x.now);
 x.at(T+400);x.e.settleExits('BTCUSD',book(x.now),x.now);print(92,T+500);
 (audit as any).tick(T+5000);const r=x.db.get<any>('SELECT * FROM tape_audit')!;
 assert.equal(r.kind,'depth exit (sl)');assert.equal(r.first_print,92);assert.equal(JSON.parse(r.extra).execution.triggerAt,T+300);
});

test('a failed scoped exit restores its position and leaves another held position untouched',t=>{
 const x=setup(t),other={...structuredClone(x.p),id:1001,symbol:'ETHUSD'};(x.e as any).open.set(other.id,other);
 x.at(T+300);x.e.onTrade('BTCUSD',94,1,x.now,x.now);
 x.db.db.exec("CREATE TRIGGER fail_scoped BEFORE INSERT ON paper_exit_reports BEGIN SELECT RAISE(ABORT,'scoped failure'); END");
 assert.equal(x.e.settleExits('BTCUSD',book(T+400),T+400),0);assert.equal(x.p.qtyOpen,2);assert.equal(x.e.openPositions().length,2);assert.equal(x.e.position(other.id),other);assert.equal(other.qtyOpen,2);
});
