import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from '../paper/engine.ts';
import {OpenTradeMonitor,type MarketObservation} from './openTradeMonitor.ts';
import {SCANNER_EARLY_EXIT,SCANNER_EARLY_STRESS,EARLY_EXIT_SCANNERS} from './scannerEarlyExit.ts';
import {advanceConditional,initialConditionalState,conditionalRule,EXIT_ARMS} from './conditionalExit.ts';
const T=1_800_000_000_000;
const depth=(at:number,bid=97,ask=98,size=100000)=>({receivedAt:at,exchangeAt:at,bids:[{price:bid,size}],asks:[{price:ask,size}]});
function fixture(t:any,book=0,side:'long'|'short'='long',scanner:string=EARLY_EXIT_SCANNERS[0],symbol='EVAAUSD'){
 const db=new Db(':memory:');t.after(()=>db.db.close());let now=T;
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.execution.mode='paper';
 Object.assign(cfg.paper,{initialEquity:1000,sizingMode:'risk',riskPerTradePct:1,maxStopLossPct:0,maxSignalAgeSec:0,minRiskFeeRatio:0,useSpread:false,requireQuote:false,slippageBps:0,feeRatePct:0,makerFeeRatePct:0,liquidation:false,latencyMs:100,trailAfterR:0,floorAtR:0,limitEntry:undefined});
 const engine=new PaperEngine(db,()=>cfg,{book,now:()=>now});engine.causalExits=true;engine.sourceHashFor=()=> 'reviewed-source';
 const d=engine.onEntry({kind:'entry',side,price:100,sl:side==='long'?95:105,tp:[],label:'entry',message:'',source:'alert',barTime:T-900000,barIndex:0},{scannerId:scanner,scannerName:scanner,symbol,tf:'15m',market:{tickSize:.01,contractValue:1},refPrice:100,at:T,signalId:null,exitMode:'both',signalBar:{time:T-900000,high:102,low:98,close:100}});
 now=T+200;engine.onBar(symbol,{time:T,high:100,low:100,close:100},now);const p=engine.position(d.pendingId??d.position!.id)!;assert.equal(p.status,'open');
 let monitor=new OpenTradeMonitor(db,T);
 const input=()=>({position:p,book,scope:book===0?'paper':'shadow',...engine.advisoryObservation(p)});
 const observe=(at:number,price:number|null=99,overrides:any={},priceAt:number|null=at)=>{
  const m:MarketObservation={symbol,at,price,priceAt,depth:depth(at,price??99,(price??99)+.01),depthAt:at,flow:{covered:false,imbalance:null,throughAt:null,availableAt:null,minutes:0}};
  monitor.observe([{...input(),...overrides}],new Map([[symbol,m]]),()=>null,at);
 };
 const rows=()=>db.all<any>('SELECT * FROM advisory_exits WHERE rule IN (?,?) ORDER BY rule',SCANNER_EARLY_EXIT,SCANNER_EARLY_STRESS);
 const cohort=()=>db.get<any>('SELECT * FROM advisory_scanner_exit_cohort');
 const close=(net:number,reason='sl',at=T+5000)=>{db.run("UPDATE positions SET status='closed',exit_at=?,exit_reason=?,realized_pnl=?,fees=0 WHERE id=?",at,reason,net,p.id);monitor.resolve(at+1);};
 return {db,cfg,engine,p,input,observe,rows,cohort,close,get monitor(){return monitor},restart:(at:number)=>{monitor=new OpenTradeMonitor(db,at);},settle:(at:number,b=depth(at))=>monitor.settle(symbol,b,at,()=>p)};
}
const trials=(x:ReturnType<typeof fixture>)=>x.db.all<any>("SELECT * FROM advisory_exits WHERE rule LIKE 'conditional-exit-v1-%'");
test('a transient wick breach and a recovered winner do not trigger the invalidation candidate',t=>{
 const x=fixture(t);for(let ms=5000;ms<=70000;ms+=5000)x.observe(T+ms,ms>=60000?97.5:100);
 for(let ms=75000;ms<=120000;ms+=5000)x.observe(T+ms,101);
 x.close(4,'trail',T+120001);assert.equal(trials(x).length,0);
 assert.ok(x.monitor.view().conditionalExitStudy.groups.every(g=>g.covered===1&&g.candidateNet===4&&g.winnersCut===0));
});
test('sustained scanner-specific failure creates independent invalidation and combined arms with realistic fills',t=>{
 const x=fixture(t);const before=JSON.stringify(x.cfg),position=JSON.stringify(x.p),orders=x.db.all('SELECT * FROM orders');
 for(let ms=5000;ms<=125000;ms+=5000)x.observe(T+ms,97.5);
 assert.equal(trials(x).length,4);assert.ok(trials(x).every(r=>!r.rule.includes('protection')));
 x.settle(T+125500,depth(T+125500,97.4,97.5));x.settle(T+128500,depth(T+128500,97.3,97.4));
 assert.ok(trials(x).every(r=>r.status==='filled'));assert.equal(JSON.stringify(x.p),position);assert.equal(JSON.stringify(x.cfg),before);assert.deepEqual(x.db.all('SELECT * FROM orders'),orders);
 x.close(-10,'sl',T+129000);const g=x.monitor.view().conditionalExitStudy.groups.find(g=>g.arm==='invalidation')!;
 assert.ok(g.deltaR>0&&g.stressDeltaR>0);assert.equal(g.stopsBefore,1);assert.equal(g.stopsAfter,0);assert.equal(g.losersAfter,1);
 assert.equal(x.monitor.view().conditionalExitStudy.promotionEligible,false);
});
test('profit alone never triggers: only persistent net giveback and observed range failure do',t=>{
 const x=fixture(t),s=initialConditionalState(x.p,98);
 const sample=(ms:number,price:number,netR:number)=>advanceConditional(x.p,s,{at:T+ms,price,priceAt:T+ms,depthAt:T+ms,netR,exitPending:false});
 for(let ms=5000;ms<=90000;ms+=5000)assert.deepEqual(sample(ms,102,.35),[]);
 assert.deepEqual(sample(95000,100.8,.15),[]);
 assert.deepEqual(sample(100000,102,.35),[]); // immediate recovery clears confirmation
 for(let ms=105000;ms<=120000;ms+=5000)assert.deepEqual(sample(ms,100.8,.15),[]);
 assert.deepEqual(sample(125000,100.8,.15),['protection','combined']);
 assert.equal(s.arms.invalidation.status,'watching');
});
test('short profit protection is symmetric and cannot mistake a gross peak or near-zero net for protected profit',t=>{
 const x=fixture(t,0,'short'),s=initialConditionalState(x.p,102);
 for(let ms=5000;ms<=120000;ms+=5000)advanceConditional(x.p,s,{at:T+ms,price:ms<=90000?98:99.5,priceAt:T+ms,depthAt:T+ms,netR:ms<=90000?.35:.01,exitPending:false});
 assert.equal(s.arms.protection.status,'watching');assert.equal(s.profitSince,null);
 for(let ms=125000;ms<=150000;ms+=5000)advanceConditional(x.p,s,{at:T+ms,price:99.7,priceAt:T+ms,depthAt:T+ms,netR:.12,exitPending:false});
 assert.equal(s.arms.protection.status,'triggered');
});
test('AI Predictive Flow needs one source bar and persistent failure without previous follow-through',t=>{
 const x=fixture(t,0,'long',EARLY_EXIT_SCANNERS[1],'BLESSUSD'),s=initialConditionalState(x.p,98);
 for(let ms=5000;ms<1020000;ms+=5000){const fired=advanceConditional(x.p,s,{at:T+ms,price:97.5,priceAt:T+ms,depthAt:T+ms,netR:-.5,exitPending:false});assert.deepEqual(fired,[]);}
 // Entry was filled 200ms after the clock; the first eligible sample is 905s.
 assert.deepEqual(advanceConditional(x.p,s,{at:T+1020000,price:97.5,priceAt:T+1020000,depthAt:T+1020000,netR:-.5,exitPending:false}),[]);
 assert.deepEqual(advanceConditional(x.p,s,{at:T+1025000,price:97.5,priceAt:T+1025000,depthAt:T+1025000,netR:-.5,exitPending:false}),['invalidation','combined']);
 const recovered=initialConditionalState(x.p,98);recovered.peakPriceR=.15;
 for(let ms=5000;ms<=1100000;ms+=5000)advanceConditional(x.p,recovered,{at:T+ms,price:97.5,priceAt:T+ms,depthAt:T+ms,netR:-.5,exitPending:false});
 assert.equal(recovered.arms.invalidation.status,'watching');
});
test('missing depth, repeated quotes, stale/future samples and restart gaps cannot create success',t=>{
 const x=fixture(t);x.observe(T+5000,100);x.restart(T+6000);assert.equal(x.monitor.conditionalExits.startedAt,T);
 x.observe(T+21000,97.5);x.close(4,'trail',T+22000);
 assert.ok(x.monitor.view().conditionalExitStudy.groups.every(g=>g.unavailable===1&&g.covered===0));
 const s=initialConditionalState(x.p,98);
 advanceConditional(x.p,s,{at:T+5000,price:97,priceAt:T+5000,depthAt:T+5000,netR:-.6,exitPending:false});
 for(const a of [6000,10000])advanceConditional(x.p,s,{at:T+a,price:97,priceAt:T+5000,depthAt:T+5000,netR:-.6,exitPending:false});
 assert.equal(s.lastAt,T+5000);
 assert.deepEqual(advanceConditional(x.p,s,{at:T+11000,price:97,priceAt:T+12000,depthAt:T+11000,netR:-.6,exitPending:false}),[]);
});
test('actual stop priority, partial exit, missing entry wick and prior positions do not invent invalidations',t=>{
 const x=fixture(t);for(let ms=5000;ms<=130000;ms+=5000)x.observe(T+ms,97.5,{exitPending:true});assert.equal(trials(x).length,0);
 x.p.qtyOpen--;x.observe(T+135000,97.5);x.close(-4,'sl',T+136000);assert.ok(x.monitor.view().conditionalExitStudy.groups.every(g=>g.unavailable===1));
 const missing=fixture(t);missing.db.run('DELETE FROM decision_trace');for(let ms=5000;ms<=130000;ms+=5000)missing.observe(T+ms,97.5);assert.equal(trials(missing).length,0);
 const old=fixture(t);old.observe(T+5000,97.5,{position:{...old.p,entryAt:T-1}});assert.equal(old.monitor.view().conditionalExitStudy.groups.length,0);
});
test('candidate loss on a recovering winner is recorded, including stress winner damage',t=>{
 const x=fixture(t);for(let ms=5000;ms<=125000;ms+=5000)x.observe(T+ms,97.5);
 x.settle(T+129000);x.close(4,'trail',T+130000);
 const g=x.monitor.view().conditionalExitStudy.groups.find(g=>g.arm==='invalidation')!;
 assert.equal(g.winnersCut,1);assert.equal(g.winnersLost,1);assert.equal(g.stressWinnersCut,1);assert.ok(g.deltaR<0);
});
test('atomic multi-arm insert rollback, restart and shadow books retain isolation',t=>{
 const x=fixture(t,2,'short',EARLY_EXIT_SCANNERS[2],'SOLUSD');
 for(let ms=5000;ms<65000;ms+=5000)x.observe(T+ms,102.5);
 x.db.db.exec(`CREATE TRIGGER refuse BEFORE INSERT ON advisory_exits WHEN NEW.rule='${conditionalRule('combined',true)}' BEGIN SELECT RAISE(ABORT,'test');END`);
 assert.throws(()=>x.observe(T+65000,102.5));assert.equal(trials(x).length,0);assert.equal(x.monitor.due(T+100000).filter(r=>r.rule.startsWith('conditional')).length,0);
 x.db.db.exec('DROP TRIGGER refuse');x.observe(T+65000,102.5);x.settle(T+65100,depth(T+65100,102,103,1));x.restart(T+66000);
 x.settle(T+69000,depth(T+69000,102,103,1));x.settle(T+70000,depth(T+70000,102,103,1));x.close(-10,'sl',T+71000);
 const g=x.monitor.view().conditionalExitStudy.groups.find(g=>g.arm==='invalidation')!;assert.equal(g.covered,1);assert.equal(g.candidateNet,null);
});
test('unobserved closed trades remain unavailable in all three arms',t=>{
 const x=fixture(t);x.close(4,'trail');const gs=x.monitor.view().conditionalExitStudy.groups;
 assert.equal(gs.length,EXIT_ARMS.length);assert.ok(gs.every(g=>g.closed===1&&g.covered===0&&g.unavailable===1));
});
test('fresh quotes keep invalidation observable during depth gaps; absent depth never confirms profit',t=>{
 const x=fixture(t),s=initialConditionalState(x.p,98);
 for(let ms=5000;ms<=125000;ms+=5000)advanceConditional(x.p,s,{at:T+ms,price:97.5,priceAt:T+ms,depthAt:null,netR:null,exitPending:false});
 assert.equal(s.arms.invalidation.status,'triggered');assert.equal(s.arms.protection.status,'watching');assert.equal(s.netSamples,0);assert.equal(s.priceSamples,25);
 const profit=initialConditionalState(x.p,98);profit.peakNetR=.4;
 for(let ms=5000;ms<=125000;ms+=5000)advanceConditional(x.p,profit,{at:T+ms,price:101,priceAt:T+ms,depthAt:T,netR:.1,exitPending:false});
 assert.equal(profit.arms.protection.status,'watching');assert.equal(profit.profitSince,null);
});
test('fees and tax are charged at the observed delayed fill, and expired depth cannot become a profit',t=>{
 const x=fixture(t),config={...x.input().config,feeRatePct:.02,feeTaxPct:18,scalperOffer:undefined};
 for(let ms=5000;ms<=125000;ms+=5000)x.observe(T+ms,97.5,{config});
 x.settle(T+126000,depth(T+126000,97,98));x.settle(T+129000,depth(T+129000,96.9,97.9));
 const base=trials(x).find(r=>r.rule===conditionalRule('invalidation')),report=JSON.parse(base.payload).reports[0];
 assert.ok(Math.abs(report.grossFee-97*2*.0002*1.18)<1e-10);assert.equal(report.cashFee,report.grossFee);assert.ok(base.net < -6);
 const gap=fixture(t);for(let ms=5000;ms<=125000;ms+=5000)gap.observe(T+ms,97.5);
 gap.monitor.resolve(T+160000);gap.close(-10,'sl',T+161000);
 assert.equal(gap.monitor.view().conditionalExitStudy.groups.find(g=>g.arm==='invalidation')!.covered,0);
});
