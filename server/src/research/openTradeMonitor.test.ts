import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from '../paper/engine.ts';
import {fillExit} from '../paper/logic.ts';
import {OpenTradeMonitor,type MarketObservation} from './openTradeMonitor.ts';
const T=1_800_000_000_000;
const depth=(at:number,bid=97,ask=98,size=10000)=>({receivedAt:at,exchangeAt:at,bids:[{price:bid,size}],asks:[{price:ask,size}]});
function setup(t:any,side:'long'|'short'='long'){
 const db=new Db(':memory:');t.after(()=>db.db.close());let now=T;
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.execution.mode='paper';
 Object.assign(cfg.paper,{initialEquity:1000,sizingMode:'risk',riskPerTradePct:1,maxStopLossPct:0,maxSignalAgeSec:0,minRiskFeeRatio:0,useSpread:false,requireQuote:false,slippageBps:0,feeRatePct:0,makerFeeRatePct:0,liquidation:false,latencyMs:100,trailAfterR:0,floorAtR:0,limitEntry:undefined});
 const engine=new PaperEngine(db,()=>cfg,{now:()=>now});engine.causalExits=true;engine.sourceHashFor=()=> 'source';
 const d=engine.onEntry({kind:'entry',side,price:100,sl:side==='long'?95:105,tp:[],label:'entry',message:'',source:'alert',barTime:0,barIndex:0},{scannerId:'test',scannerName:'Test',symbol:'INITUSD',tf:'15m',market:{tickSize:.01,contractValue:1},refPrice:100,at:now,signalId:null,exitMode:'both'});
 now+=200;engine.onBar('INITUSD',{time:T,high:100,low:100,close:100},now);const p=engine.position(d.pendingId??d.position!.id)!;
 let monitor=new OpenTradeMonitor(db);
 const input=()=>({position:p,book:0,scope:'paper',...engine.advisoryObservation(p)});
 const observe=(at:number,price=97.4,exitPending=false)=>{now=at;const m:MarketObservation={symbol:p.symbol,at,price,priceAt:at,depth:depth(at),depthAt:at,flow:{covered:false,imbalance:null,throughAt:null,availableAt:null,minutes:0}};monitor.observe([{...input(),exitPending}],new Map([[p.symbol,m]]),()=>({known:true}),at);};
 return {db,cfg,engine,p,input,observe,get monitor(){return monitor},restart:()=>{monitor=new OpenTradeMonitor(db);},settle:(at:number,b=depth(at))=>monitor.settle(p.symbol,b,at,()=>p)};
}
test('advisory observations and fills cannot alter the actual position, orders, policy or risk',t=>{
 const x=setup(t);const before=JSON.stringify(x.p),cfg=JSON.stringify(x.cfg),orders=x.db.all('SELECT * FROM orders');
 x.observe(T+300);x.settle(T+400);assert.equal(JSON.stringify(x.p),before);assert.equal(JSON.stringify(x.cfg),cfg);assert.deepEqual(x.db.all('SELECT * FROM orders'),orders);assert.equal(x.engine.pendingExits().length,0);
 assert.equal(x.monitor.view().trials[0].status,'filled');assert.equal(x.monitor.view().trials[0].actual_net,null);assert.equal(x.monitor.view().trials[0].delta,null);
 assert.equal(x.db.get<any>('SELECT sum(promotion_eligible) n FROM advisory_checkpoints')!.n,0);
});
test('latency and fresh causal depth are mandatory; exit uses bid, not trigger',t=>{
 const x=setup(t);x.observe(T+300);
 for(const b of [depth(T+399),depth(T+401),{...depth(T+400),exchangeAt:T-10000}])x.settle(T+400,b);
 assert.equal(x.monitor.view().trials[0].status,'waiting');x.settle(T+400,depth(T+400,96,98));
 const row=x.db.get<any>('SELECT * FROM advisory_exits')!;const payload=JSON.parse(row.payload);assert.equal(payload.reports[0].price,96);assert.equal(row.net,-8);
});
test('short hypothetical exit pays the ask',t=>{const x=setup(t,'short');x.observe(T+300,102.6);x.settle(T+400,depth(T+400,102,103));assert.equal(x.monitor.view().trials[0].net,-6);});
test('existing stop or pending real exit takes precedence over a new hypothetical decision',t=>{
 const x=setup(t);x.observe(T+300,94);x.observe(T+400,97.4,true);assert.equal(x.monitor.view().trials.length,0);
});
test('partial fills restart without double consuming the same book',t=>{
 const x=setup(t);x.observe(T+300);x.settle(T+400,depth(T+400,97,98,1));assert.equal(x.monitor.view().trials[0].status,'partial');x.restart();
 x.settle(T+500,depth(T+400,97,98,1));assert.equal(x.monitor.view().trials[0].market_filled,1);x.settle(T+600,depth(T+600,96,98,1));assert.equal(x.monitor.view().trials[0].status,'filled');assert.equal(x.monitor.view().trials[0].net,-7);
});
test('write failure rolls back hypothetical state and consumption',t=>{
 const x=setup(t);x.observe(T+300);x.db.db.exec("CREATE TRIGGER fail_advisory BEFORE INSERT ON advisory_exit_liquidity BEGIN SELECT RAISE(ABORT,'test');END");
 assert.throws(()=>x.settle(T+400));assert.equal(x.monitor.view().trials[0].market_filled,0);x.db.db.exec('DROP TRIGGER fail_advisory');x.settle(T+500);assert.equal(x.monitor.view().trials[0].net,-6);
});
test('actual exit before hypothetical completion is censored, not backdated',t=>{
 const x=setup(t);x.observe(T+300);fillExit(x.p,95,x.p.qtyOpen,'sl',T+350,x.cfg.paper,'depth');x.settle(T+400);assert.equal(x.monitor.view().trials[0].status,'censored');assert.equal(x.monitor.view().trials[0].net,null);
});
test('actual outcome resolves only after closure, and funding reconciliation refreshes the comparison',t=>{
 const x=setup(t);x.observe(T+300);x.settle(T+400);x.monitor.resolve(T+500);assert.equal(x.monitor.view().trials[0].delta,null);
 x.db.run("UPDATE positions SET status='closed',realized_pnl=-10,fees=1 WHERE id=?",x.p.id);x.monitor.resolve(T+600);assert.equal(x.monitor.view().trials[0].delta,5);
 x.db.run('UPDATE positions SET realized_pnl=-12 WHERE id=?',x.p.id);x.monitor.resolve(T+700);assert.equal(x.monitor.view().trials[0].delta,7);
});
test('paid fees and funding before hypothetical exit remain; later funding cannot leak in',t=>{
 const x=setup(t);x.p.fees=1;x.p.realizedPnl=-2;x.p.fills.push({at:T+250,price:100,qty:0,fee:0,pnl:-2,reason:'funding'});
 x.observe(T+300);x.p.fills.push({at:T+350,price:100,qty:0,fee:0,pnl:-1,reason:'funding'},{at:T+5000,price:100,qty:0,fee:0,pnl:-99,reason:'funding'});
 x.settle(T+400);assert.equal(x.monitor.view().trials[0].net,-10);
});
test('duplicate checkpoints and trials are idempotent across restart',t=>{
 const x=setup(t);x.observe(T+300);x.restart();x.observe(T+350);assert.equal(x.monitor.view().trials.length,1);assert.equal(x.db.get<any>('SELECT count(*) n FROM advisory_checkpoints')!.n,2);
});
test('missing depth expires as unpriced and never receives an invented result',t=>{
 const x=setup(t);x.observe(T+300);x.monitor.resolve(T+70000);assert.equal(x.monitor.view().trials[0].status,'unpriced');assert.equal(x.monitor.view().trials[0].net,null);
});
test('reused position IDs cannot match the previous entry outcome',t=>{
 const x=setup(t);x.observe(T+300);x.settle(T+400);x.db.run("UPDATE positions SET entry_at=?,status='closed',realized_pnl=100 WHERE id=?",T+10000,x.p.id);x.monitor.resolve(T+20000);assert.equal(x.monitor.view().trials[0].status,'censored');assert.equal(x.monitor.view().trials[0].delta,null);
});
test('late funding is reconciled by settlement time and remaining hypothetical exposure',t=>{
 const x=setup(t);x.observe(T+300);x.settle(T+400,depth(T+400,97,98,1));x.settle(T+600,depth(T+600,97,98,1));
 const funding=(at:number,pnl:number)=>({at,price:100,qty:0,fee:0,pnl,reason:'funding'});
 x.db.run("UPDATE positions SET status='closed',realized_pnl=-10,fees=0 WHERE id=?",x.p.id);x.monitor.resolve(T+700);assert.equal(x.monitor.view().trials[0].net,-6);
 x.db.run('UPDATE positions SET fills=?,realized_pnl=-25 WHERE id=?',JSON.stringify({fills:[...x.p.fills,funding(T+350,-1),funding(T+500,-4),funding(T+800,-10)]}),x.p.id);
 x.monitor.resolve(T+900);assert.equal(x.monitor.view().trials[0].net,-9);assert.equal(x.monitor.view().trials[0].delta,16);
 x.monitor.resolve(T+1000);assert.equal(x.monitor.view().trials[0].net,-9,'reconciliation is idempotent');
});
test('persistent-loss control requires continuous prospective observations and known early peak',t=>{
 const x=setup(t);x.observe(T+300,99);
 for(let at=T+5000;at<=T+965000;at+=5000)x.observe(at,98);
 assert.ok(x.monitor.view().trials.some(r=>r.rule==='persistent-loss-v1'));
 assert.equal(x.monitor.view().positions[0].complete,true);
});
test('late startup and observation gaps cannot manufacture persistent-loss history',t=>{
 const x=setup(t);x.observe(T+900000,98);
 for(let at=T+905000;at<=T+980000;at+=5000)x.observe(at,98);
 assert.equal(x.monitor.view().trials.length,0);assert.equal(x.monitor.view().positions[0].complete,false);
});
test('observed positive excursion prevents persistent-loss control from cutting a recovering trade',t=>{
 const x=setup(t);x.observe(T+300,101);
 for(let at=T+5000;at<=T+965000;at+=5000)x.observe(at,98);
 assert.equal(x.monitor.view().trials.length,0);assert.equal(x.monitor.view().positions[0].peak,.2);
});
