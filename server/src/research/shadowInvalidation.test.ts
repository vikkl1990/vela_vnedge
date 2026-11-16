import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from '../paper/engine.ts';
import {OpenTradeMonitor,type MarketObservation} from './openTradeMonitor.ts';
import {ARIA_RULE,ARIA_STRESS_RULE,signalWick} from './shadowInvalidation.ts';
const T=1800000000000,M=60000;
const depth=(at:number,price=97,size=100000)=>({receivedAt:at,exchangeAt:at,bids:[{price,size}],asks:[{price:price+1,size}]});
function fixture(t:any,side:'long'|'short'='long'){
 const db=new Db(':memory:');t.after(()=>db.db.close());let now=T;
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.execution.mode='paper';
 Object.assign(cfg.paper,{initialEquity:1000,sizingMode:'risk',riskPerTradePct:1,maxStopLossPct:0,maxSignalAgeSec:0,minRiskFeeRatio:0,useSpread:false,requireQuote:false,slippageBps:0,feeRatePct:0,makerFeeRatePct:0,liquidation:false,latencyMs:100,trailAfterR:0,floorAtR:0,limitEntry:undefined});
 const engine=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});engine.causalExits=true;engine.sourceHashFor=()=> 'reviewed-source';
 const b={time:T-900000,high:102,low:98,close:100};
 const d=engine.onEntry({kind:'entry',side,price:100,sl:side==='long'?95:105,tp:[],label:'entry',message:'',source:'alert',barTime:b.time,barIndex:0},{scannerId:'elliott-wave',scannerName:'Elliott Wave',symbol:'ARIAUSD',tf:'15m',market:{tickSize:.01,contractValue:1},refPrice:100,at:now,signalId:null,exitMode:'both',signalBar:b});
 now+=200;engine.onBar('ARIAUSD',{time:T,high:100,low:100,close:100},now);const p=engine.position(d.pendingId??d.position!.id)!;assert.equal(p.status,'open');
 let monitor=new OpenTradeMonitor(db,T);
 const input=()=>({position:p,book:2,scope:'shadow',config:cfg.paper,marketQty:p.qtyOpen,exitPending:false});
 const observe=(at:number,price=97.5,overrides:any={})=>{
  const m:MarketObservation={symbol:'ARIAUSD',at,price,priceAt:at,depth:depth(at),depthAt:at,flow:{covered:false,imbalance:null,throughAt:null,availableAt:null,minutes:0}};
  monitor.observe([{...input(),...overrides}],new Map([['ARIAUSD',m]]),()=>null,at);
 };
 const row=()=>db.get<any>('SELECT * FROM advisory_invalidation_cohort');
 const trials=()=>monitor.view().trials.filter(x=>[ARIA_RULE,ARIA_STRESS_RULE].includes(x.rule));
 return {db,cfg,p,engine,b,input,observe,row,trials,get monitor(){return monitor},restart:(at=T+70000)=>{monitor=new OpenTradeMonitor(db,at);},settle:(at:number,b=depth(at))=>monitor.settle('ARIAUSD',b,at,()=>p)};
}
test('ARIA shadow starts prospectively, preserves the real trade and uses delayed fresh depth for base and stress',t=>{
 const x=fixture(t),p=JSON.stringify(x.p),cfg=JSON.stringify(x.cfg),orders=x.db.all('SELECT * FROM orders');
 x.observe(T+300,99);x.observe(T+M+300);assert.equal(x.trials().length,0);
 x.observe(T+M+31000);assert.equal(x.trials().length,0,'sample cadence is one minute, not a new tick rule');
 x.observe(T+2*M+300);assert.equal(x.trials().length,2);
 x.settle(T+2*M+1300);assert.ok(x.trials().every(t=>t.status==='waiting'));
 x.settle(T+2*M+1400);assert.equal(x.trials().find(t=>t.rule===ARIA_RULE)!.status,'filled');
 x.settle(T+2*M+3400);assert.equal(x.trials().find(t=>t.rule===ARIA_STRESS_RULE)!.status,'filled');
 const reports=x.db.all<any>('SELECT payload FROM advisory_exits WHERE rule LIKE ?','aria-%').map(r=>JSON.parse(r.payload).reports[0]);
 assert.equal(reports[0].price,97);assert.ok(Math.abs(reports[1].price-97*(1-.0005))<1e-10);
 assert.equal(JSON.stringify(x.p),p);assert.equal(JSON.stringify(x.cfg),cfg);assert.deepEqual(x.db.all('SELECT * FROM orders'),orders);assert.equal(x.engine.pendingExits().length,0);
 assert.equal(x.db.get<any>('SELECT sum(promotion_eligible) n FROM advisory_invalidation_cohort')!.n,0);
});
test('the ARIA trial cannot enroll paper, experiments, other scanners, adopted history or pre-activation entries',t=>{
 const x=fixture(t);
 for(const overrides of [{book:0,scope:'paper'},{scope:'experiment'},{position:{...x.p,scannerId:'other'}},{position:{...x.p,policy:{...x.p.policy!,adoptedAt:T}}},{position:{...x.p,entryAt:T-1}}])x.observe(T+300,97.5,overrides);
 assert.equal(x.row(),undefined);assert.equal(x.trials().length,0);
});
test('source candle must be closed, bound to the original policy and inside the original stop',t=>{
 const x=fixture(t);assert.equal(signalWick(x.p,{...x.b,time:T}),null);assert.equal(signalWick(x.p,{...x.b,low:94}),null);
 x.db.run("UPDATE decision_trace SET snapshot=json_set(snapshot,'$.policyId','different') WHERE position_id=?",x.p.id);
 x.observe(T+300);assert.equal(x.row().status,'unverified');assert.equal(x.trials().length,0);
});
test('restart preserves confirmation without resetting the study clock or creating a downtime fill',t=>{
 const x=fixture(t);x.observe(T+300,99);x.observe(T+M+300);x.restart();assert.equal(x.monitor.invalidation.startedAt,T);
 x.observe(T+2*M+300);assert.equal(x.trials().length,2);x.restart(T+2*M+500);x.observe(T+2*M+600);assert.equal(x.trials().length,2);
});
test('recovery resets the confirmation; long gaps fail closed',t=>{
 const x=fixture(t);x.observe(T+300,99);x.observe(T+M+300);x.observe(T+2*M+300,99);x.observe(T+3*M+300);
 assert.equal(x.trials().length,0);x.restart(T+7*M);x.observe(T+7*M);assert.equal(x.row().status,'unverified');assert.equal(x.trials().length,0);
});
test('short invalidation is symmetric and the actual protective stop has priority',t=>{
 const x=fixture(t,'short');x.observe(T+300,101);x.observe(T+M+300,102.5);x.observe(T+2*M+300,106);
 assert.equal(x.trials().length,0);x.observe(T+3*M+300,103);assert.equal(x.trials().length,2);x.settle(T+3*M+3400,depth(T+3*M+3400,103));
 const payload=JSON.parse(x.db.get<any>('SELECT payload FROM advisory_exits WHERE rule=?',ARIA_STRESS_RULE)!.payload);
 assert.ok(Math.abs(payload.reports[0].price-104*1.0005)<1e-10);
});
test('expired or stale hypothetical depth never produces an optimistic ARIA result',t=>{
 const x=fixture(t);x.observe(T+300,99);x.observe(T+M+300);x.observe(T+2*M+300);
 x.settle(T+2*M+4000,{...depth(T+2*M+4000),exchangeAt:T});assert.ok(x.trials().every(t=>t.status==='waiting'));
 x.monitor.resolve(T+2*M+30301);assert.ok(x.trials().every(t=>t.status==='unpriced'&&t.net===null));
});
test('cohort includes unchanged trades and shows smaller losing exits separately from avoided stops',t=>{
 const x=fixture(t);x.observe(T+300,99);x.observe(T+M+300);x.observe(T+2*M+300);x.settle(T+2*M+3400);
 x.db.run("UPDATE positions SET status='closed',exit_reason='sl',exit_at=?,realized_pnl=-10,fees=0 WHERE id=?",T+3*M,x.p.id);
 x.monitor.resolve(T+3*M+1);const g=x.monitor.invalidation.view().groups[0];
 assert.equal(g.covered,1);assert.equal(g.stopsBefore,1);assert.equal(g.stopsAfter,0);assert.equal(g.losersBefore,1);assert.equal(g.losersAfter,1);assert.ok(g.deltaR>0);assert.ok(g.stressDeltaR>0);
});
test('no-trigger winners count in the paired denominator; missing observations are excluded',t=>{
 const x=fixture(t);x.observe(T+300,101);x.observe(T+M+300,101);
 x.db.run("UPDATE positions SET status='closed',exit_reason='trail',exit_at=?,realized_pnl=5,fees=0 WHERE id=?",T+M+500,x.p.id);
 x.monitor.resolve(T+M+600);let g=x.monitor.invalidation.view().groups[0];assert.equal(g.covered,1);assert.equal(g.deltaR,0);assert.equal(g.winnersCut,0);
 x.db.run("UPDATE advisory_invalidation_cohort SET status='watching',last_at=?",T-3*M);x.monitor.resolve(T+M+700);g=x.monitor.invalidation.view().groups[0];assert.equal(g.covered,0);assert.equal(g.unavailable,1);
});
test('additional entry fills cannot silently change the frozen comparison exposure',t=>{
 const x=fixture(t);x.observe(T+300,99);x.observe(T+M+300);x.p.fills.push({...x.p.fills[0],at:T+M+500});
 x.observe(T+2*M+300);assert.equal(x.row().status,'unverified');assert.equal(x.trials().length,0);
});
test('already partial-exited positions do not enter the reviewed single-entry invalidation cohort',t=>{
 const x=fixture(t);x.p.qtyOpen=x.p.qty-1;x.observe(T+300,99);assert.equal(x.row().status,'unverified');assert.equal(x.trials().length,0);
});
