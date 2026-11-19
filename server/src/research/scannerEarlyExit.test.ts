import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from '../paper/engine.ts';
import {OpenTradeMonitor,type MarketObservation} from './openTradeMonitor.ts';
import {SCANNER_EARLY_EXIT,SCANNER_EARLY_STRESS,EARLY_EXIT_SCANNERS,earlyExitCell} from './scannerEarlyExit.ts';
const T=1_800_000_000_000;
const depth=(at:number,bid=97,ask=98,size=100000)=>({receivedAt:at,exchangeAt:at,bids:[{price:bid,size}],asks:[{price:ask,size}]});
function fixture(t:any,book=0,side:'long'|'short'='long',scanner:string=EARLY_EXIT_SCANNERS[0],symbol='EVAAUSD'){
 const db=new Db(':memory:');t.after(()=>db.db.close());let now=T;
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.execution.mode='paper';
 Object.assign(cfg.paper,{initialEquity:1000,sizingMode:'risk',riskPerTradePct:1,maxStopLossPct:0,maxSignalAgeSec:0,minRiskFeeRatio:0,useSpread:false,requireQuote:false,slippageBps:0,feeRatePct:0,makerFeeRatePct:0,liquidation:false,latencyMs:100,trailAfterR:0,floorAtR:0,limitEntry:undefined});
 const engine=new PaperEngine(db,()=>cfg,{book,now:()=>now});engine.causalExits=true;engine.sourceHashFor=()=> 'reviewed-source';
 const d=engine.onEntry({kind:'entry',side,price:100,sl:side==='long'?95:105,tp:[],label:'entry',message:'',source:'alert',barTime:T-900000,barIndex:0},{scannerId:scanner,scannerName:scanner,symbol,tf:'15m',market:{tickSize:.01,contractValue:1},refPrice:100,at:T,signalId:null,exitMode:'both'});
 now=T+200;engine.onBar(symbol,{time:T,high:100,low:100,close:100},now);const p=engine.position(d.pendingId??d.position!.id)!;assert.equal(p.status,'open');
 let monitor=new OpenTradeMonitor(db,T);
 const input=()=>({position:p,book,scope:book===0?'paper':'shadow',...engine.advisoryObservation(p)});
 const observe=(at:number,price:number|null=99,overrides:any={},priceAt:number|null=at)=>{
  const m:MarketObservation={symbol,at,price,priceAt,depth:depth(at),depthAt:at,flow:{covered:false,imbalance:null,throughAt:null,availableAt:null,minutes:0}};
  monitor.observe([{...input(),...overrides}],new Map([[symbol,m]]),()=>null,at);
 };
 const rows=()=>db.all<any>('SELECT * FROM advisory_exits WHERE rule IN (?,?) ORDER BY rule',SCANNER_EARLY_EXIT,SCANNER_EARLY_STRESS);
 const cohort=()=>db.get<any>('SELECT * FROM advisory_scanner_exit_cohort');
 const close=(net:number,reason='sl',at=T+5000)=>{db.run("UPDATE positions SET status='closed',exit_at=?,exit_reason=?,realized_pnl=?,fees=0 WHERE id=?",at,reason,net,p.id);monitor.resolve(at+1);};
 return {db,cfg,engine,p,input,observe,rows,cohort,close,get monitor(){return monitor},restart:(at:number)=>{monitor=new OpenTradeMonitor(db,at);},settle:(at:number,b=depth(at))=>monitor.settle(symbol,b,at,()=>p)};
}
test('prospective shadow study compares the same filled paper entry without modifying execution, policies or settings',t=>{
 const x=fixture(t);const before=JSON.stringify(x.p),cfg=JSON.stringify(x.cfg),orders=x.db.all('SELECT * FROM orders');
 x.observe(T+300,97.4);assert.equal(x.rows().length,2);x.settle(T+399);assert.ok(x.rows().every(r=>r.status==='waiting'));
 x.settle(T+400,depth(T+400,96,98));assert.equal(x.rows().find(r=>r.rule===SCANNER_EARLY_EXIT).net,-8);
 x.settle(T+3400,depth(T+3400,96,98));const stress=x.rows().find(r=>r.rule===SCANNER_EARLY_STRESS);assert.ok(stress.net < -8);
 assert.equal(JSON.stringify(x.p),before);assert.equal(JSON.stringify(x.cfg),cfg);assert.deepEqual(x.db.all('SELECT * FROM orders'),orders);assert.equal(x.engine.pendingExits().length,0);
 assert.equal(x.monitor.view().scannerExitStudy.groups[0].covered,0);x.close(-10);
 const g=x.monitor.view().scannerExitStudy.groups[0];assert.equal(g.baselineNet,-10);assert.equal(g.candidateNet,-8);assert.equal(g.stopsBefore,1);assert.equal(g.stopsAfter,0);assert.equal(g.losersAfter,1);
 assert.equal(x.monitor.view().scannerExitStudy.promotionEligible,false);
 assert.equal(x.db.get<any>('SELECT sum(promotion_eligible) n FROM advisory_scanner_exit_cohort').n,0);
});
test('selection includes all requested scanners, restricts the maker to SOL 15m, and separates source books',t=>{
 assert.ok(earlyExitCell(EARLY_EXIT_SCANNERS[0],'AAVEUSD','1h'));assert.ok(earlyExitCell(EARLY_EXIT_SCANNERS[1],'BLESSUSD','1h'));
 assert.ok(earlyExitCell(EARLY_EXIT_SCANNERS[2],'SOLUSD','15m'));assert.equal(earlyExitCell(EARLY_EXIT_SCANNERS[2],'ETHUSD','15m'),false);assert.equal(earlyExitCell(EARLY_EXIT_SCANNERS[2],'SOLUSD','1h'),false);
 const x=fixture(t,2,'short',EARLY_EXIT_SCANNERS[2],'SOLUSD');x.observe(T+300,102.6);x.settle(T+3400,depth(T+3400,102,103));x.close(-x.p.riskAmount);
 const g=x.monitor.view().scannerExitStudy.groups[0];assert.equal(g.book,2);assert.equal(g.baselineNet,null);assert.equal(g.candidateNet,null);assert.equal(g.covered,1);
 const base=JSON.parse(x.rows().find(r=>r.rule===SCANNER_EARLY_EXIT).payload);assert.equal(base.reports[0].price,103);
});
test('pre-activation positions, experiments, trackers and unrelated scanners are excluded',t=>{
 const x=fixture(t);
 for(const overrides of [{scope:'tracker',book:2},{scope:'experiment',book:2},{position:{...x.p,scannerId:'other'}},{position:{...x.p,entryAt:T-1}}])x.observe(T+300,97.4,overrides);
 assert.equal(x.cohort(),undefined);assert.equal(x.rows().length,0);
});
test('adopted, modified and old policies and late initial observation remain unavailable',t=>{
 for(const change of [(p:any)=>{p.policy.adoptedAt=T;},(p:any)=>{p.policy.paper.latencyMs++;},(p:any)=>{p.policy.sourceHash=null;}]){
  const x=fixture(t);change(x.p);x.observe(T+300,97.4);assert.equal(x.cohort().status,'unverified');assert.equal(x.rows().length,0);
 }
 const x=fixture(t);x.observe(T+20000,97.4);assert.equal(x.cohort().status,'unverified');
});
test('unchanged profitable trades count, and winners cut short remain a cost',t=>{
 const held=fixture(t);held.observe(T+300,101);held.close(4,'trail');let g=held.monitor.view().scannerExitStudy.groups[0];assert.equal(g.covered,1);assert.equal(g.candidateNet,4);assert.equal(g.winnersCut,0);
 const cut=fixture(t);cut.observe(T+300,97.4);cut.settle(T+3400);cut.close(4,'trail');g=cut.monitor.view().scannerExitStudy.groups[0];assert.equal(g.winnersCut,1);assert.equal(g.winnersLost,1);assert.ok(g.deltaR<0);assert.equal(g.stopsBefore,0);assert.equal(g.losersAfter,1);
});
test('freshness gaps, missing observations and closures during downtime cannot become unchanged successes',t=>{
 const x=fixture(t);x.observe(T+300,99);x.observe(T+6000,null);x.observe(T+18000,97.4);assert.equal(x.cohort().status,'unverified');x.close(-10,'sl',T+20000);assert.equal(x.monitor.view().scannerExitStudy.groups[0].unavailable,1);
 const unseen=fixture(t);unseen.close(4,'trail');assert.equal(unseen.cohort().status,'unverified');assert.equal(unseen.monitor.view().scannerExitStudy.groups[0].covered,0);
 const gap=fixture(t);gap.observe(T+300,99);gap.close(4,'trail',T+30000);assert.equal(gap.cohort().status,'unverified');
});
test('stale/future prices, protective exits and liquidation have priority over the candidate',t=>{
 const x=fixture(t);x.observe(T+300,97.4,{},T-20000);x.observe(T+400,97.4,{},T+500);assert.equal(x.rows().length,0);
 x.observe(T+500,97.4,{exitPending:true});x.observe(T+600,94);assert.equal(x.rows().length,0);
 x.p.liqPrice=98;x.observe(T+700,97.4);assert.equal(x.rows().length,0);
});
test('restart preserves the start date and pending partial depth; stale books and expired fills stay unavailable',t=>{
 const x=fixture(t);x.observe(T+300,97.4);x.settle(T+400,depth(T+400,97,98,1));x.restart(T+500);assert.equal(x.monitor.scannerExits.startedAt,T);
 x.settle(T+600,depth(T+400,97,98,1));assert.equal(x.rows().find(r=>r.rule===SCANNER_EARLY_EXIT).market_filled,1);
 x.settle(T+3400,depth(T+3400,96,98,1));x.settle(T+3500,depth(T+3500,96,98,1));assert.ok(x.rows().every(r=>r.status==='filled'));
 const missing=fixture(t);missing.observe(T+300,97.4);missing.settle(T+4000,{...depth(T+4000),exchangeAt:T});missing.monitor.resolve(T+31000);assert.ok(missing.rows().every(r=>r.status==='unpriced'));missing.close(-10,'sl',T+32000);assert.equal(missing.monitor.view().scannerExitStudy.groups[0].covered,0);
});
test('cohort and two trial inserts are atomic, including the in-memory settlement queue',t=>{
 const x=fixture(t);x.db.db.exec(`CREATE TRIGGER reject_stress BEFORE INSERT ON advisory_exits WHEN NEW.rule='${SCANNER_EARLY_STRESS}' BEGIN SELECT RAISE(ABORT,'test');END`);
 assert.throws(()=>x.observe(T+300,97.4));assert.equal(x.cohort(),undefined);assert.equal(x.rows().length,0);assert.equal(x.monitor.due(T+5000).length,0);
 x.db.db.exec('DROP TRIGGER reject_stress');x.observe(T+400,97.4);assert.equal(x.rows().length,2);
});
test('changed size and replaced actual identity cannot produce comparable profit',t=>{
 const x=fixture(t);x.observe(T+300,97.4);x.settle(T+3400);x.db.run('UPDATE positions SET qty=qty+1 WHERE id=?',x.p.id);x.close(-10);assert.equal(x.monitor.view().scannerExitStudy.groups[0].unavailable,1);
 const reset=fixture(t);reset.observe(T+300,97.4);reset.db.run('UPDATE positions SET entry_at=? WHERE id=?',T+10000,reset.p.id);reset.monitor.resolve(T+5000);assert.equal(reset.monitor.view().scannerExitStudy.groups[0].missingActual,1);
});
test('late funding and costs reconcile in the paired metrics, without counting the exit as a winner',t=>{
 const x=fixture(t);x.p.fees=1;x.observe(T+300,97.4);x.settle(T+3400);x.close(-10);let g=x.monitor.view().scannerExitStudy.groups[0];assert.equal(g.candidateNet,-7);
 x.db.run('UPDATE positions SET fills=?,realized_pnl=-12 WHERE id=?',JSON.stringify({fills:[...x.p.fills,{at:T+350,price:100,qty:0,fee:0,pnl:-2,reason:'funding'}]}),x.p.id);
 x.monitor.resolve(T+6000);g=x.monitor.view().scannerExitStudy.groups[0];assert.equal(g.candidateNet,-9);assert.equal(g.baselineNet,-12);assert.equal(g.losersAfter,1);
});
