import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from './engine.ts';
import {planSnapshot,planScannerId} from './executionPlans.ts';
const T=1800000000000;
function fixture(t:any,corrected=true){
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.execution.mode='paper';
 Object.assign(cfg.paper,{sizingMode:'margin',marginPerTrade:150,initialEquity:1000,maxStopLossPct:3,latencyMs:100,fillSource:'tape',slippageBps:0,quotedSlippageBps:0,depthUsdPerBp:0,requireQuote:false,useSpread:false,skipScriptStops:false,maxSignalAgeSec:0,minRiskFeeRatio:0,liquidation:false,trailAfterR:0,floorAtR:0,breakEvenAfterTp1:true});
 const plan={id:'partial-test',revision:1,enabled:true,scannerId:'test',symbol:'ETHUSD',tf:'15m',variant:'current' as const,referenceEquity:1000};cfg.executionPlans=[plan];
 const snapshot=planSnapshot(cfg,plan,'source');if(corrected)snapshot.partialExitVersion=1;
 const id=planScannerId(snapshot),db=new Db(':memory:');t.after(()=>db.db.close());let now=T;
 let e=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});e.causalExits=true;
 e.onEntry({kind:'entry',side:'long',price:100,sl:98,tp:[102,104,106],source:'alert',label:'LONG',message:'',barTime:T-900000,barIndex:0},{scannerId:id,scannerName:'partial',symbol:'ETHUSD',tf:'15m',market:{contractValue:1,tickSize:.01},refPrice:100,at:now,signalId:null,exitMode:'both',executionPlan:snapshot});
 now=T+100;e.onTrade('ETHUSD',100,1e6,now,now);const p=e.openPositions()[0];assert.ok(p.qty>=3);
 const settle=(at:number,size=1000,price=103)=>{now=at;return e.settleExits('ETHUSD',{receivedAt:at,exchangeAt:at,bids:[{price,size}],asks:[{price:price+.1,size}]},at);};
 return {get e(){return e;},get p(){return e.position(p.id)!;},db,id,settle,at:(at:number)=>{now=at;},request:(type:'tp1'|'tp2'|'tp3'|'sl',at:number)=>{now=at;e.onScriptExit(id,'ETHUSD','15m',type,999,at,'both','long');},restart:()=>{e=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});e.causalExits=true;}};
}
test('baseline loses later simultaneous target requests; corrected shadow completes every requested leg once at real depth',t=>{
 const old=fixture(t,false),x=fixture(t);old.request('tp3',T+200);x.request('tp3',T+200);
 assert.equal(x.p.fills.length,1);const original=x.p.qty;
 for(const at of [T+300,T+400,T+500]){old.settle(at);x.settle(at);}
 assert.equal(old.p.status,'open');assert.equal(old.p.tpHit[0],false);
 assert.equal(x.p.status,'closed');assert.equal(x.p.qtyOpen,0);assert.equal(x.p.fills.slice(1).reduce((n,f)=>n+f.qty,0),original);
 assert.deepEqual(x.p.fills.slice(1).map(f=>f.reason),['tp1','tp2','tp3']);
 assert.ok(x.p.fills.slice(1).every(f=>f.price===103&&f.liquidity==='taker'));
});
test('partial target does not mark completion or break even early; duplicates and restart cannot sell it twice',t=>{
 const x=fixture(t);x.p.legs=[2,2,x.p.qty-4]; // persist through an ordinary stop amendment
 x.e.onScriptExit(x.id,'ETHUSD','15m','stop_update',98,T+150,'both');
 const qty=x.p.qty,fee=x.p.fees;x.request('tp1',T+200);assert.equal(x.settle(T+299,1),0);assert.equal(x.p.fees,fee);
 x.settle(T+300,1);assert.equal(x.p.qtyOpen,qty-1);assert.equal(x.p.tpHit[0],false);assert.equal(x.e.view(x.p).execution!.desiredStop,null);
 x.restart();x.request('tp1',T+320);x.settle(T+400,1);assert.equal(x.p.qtyOpen,qty-2);assert.equal(x.p.tpHit[0],true);assert.equal(x.e.view(x.p).execution!.desiredStop,100);
 x.request('tp1',T+500);x.settle(T+600);assert.equal(x.p.qtyOpen,qty-2);
});
test('stop arriving during a partial target stays durable and closes the residual despite a later rebound',t=>{
 const x=fixture(t),qty=x.p.qty;x.request('tp2',T+200);x.settle(T+300,1);
 x.at(T+350);x.e.onTrade('ETHUSD',97,1,T+350,T+350);x.restart();
 for(const at of [T+400,T+500,T+600])x.settle(at,1000,101);
 assert.equal(x.p.status,'closed');assert.equal(x.p.fills.at(-1)!.reason,'sl');assert.equal(x.p.fills.slice(1).reduce((n,f)=>n+f.qty,0),qty);
 assert.ok(!x.p.fills.some(f=>f.reason==='tp2'));
});
test('a later TP notification keeps its own arrival clock',t=>{
 const x=fixture(t);x.request('tp1',T+200);x.settle(T+300);x.request('tp2',T+900);
 assert.equal(x.settle(T+999),0);assert.equal(x.e.pendingExits()[0].ready_at,T+1000);assert.equal(x.settle(T+1000),1);
});
test('resting targets fill only observed contracts; a repeated trade ID after restart cannot refill them',t=>{
 const x=fixture(t),qty=x.p.qty;x.at(T+300);x.e.onTrade('ETHUSD',107,1,T+300,T+300,'print-1');
 assert.equal(x.p.qtyOpen,qty-1);assert.equal(x.p.fills.at(-1)!.liquidity,'maker');assert.equal(x.p.tpHit[0],false);
 x.restart();x.at(T+350);x.e.onTrade('ETHUSD',107,1,T+300,T+350,'print-1');assert.equal(x.p.qtyOpen,qty-1);
 x.at(T+400);x.e.onTrade('ETHUSD',107,1,T+400,T+400,'print-2');assert.equal(x.p.qtyOpen,qty-2);
 assert.equal(x.db.get<any>('SELECT count(*) n FROM paper_target_prints')!.n,2);
});
test('partial execution version is scoped to new native author shadow snapshots',()=>{
 const cfg=structuredClone(DEFAULT_CONFIG);
 const ordinary={id:'normal',revision:1,enabled:true,scannerId:'normal',symbol:'ETHUSD',tf:'15m',variant:'current' as const,referenceEquity:1000};
 const before=planSnapshot(cfg,ordinary,'source');assert.equal(before.partialExitVersion,undefined);
 cfg.scanners['normal']={enabled:false,symbols:null,timeframes:null,reader:3,exitMode:'both'};
 const changed=planSnapshot(cfg,ordinary,'source');assert.equal(changed.partialExitVersion,1);assert.notEqual(before.signature,changed.signature);
});
test('a failed target report restores quantity, TP flags, pending request and fees together',t=>{
 const x=fixture(t);x.request('tp1',T+200);const qty=x.p.qtyOpen,fee=x.p.fees;
 x.db.db.exec("CREATE TRIGGER fail_target BEFORE INSERT ON paper_exit_reports BEGIN SELECT RAISE(ABORT,'target report failure'); END");
 assert.equal(x.settle(T+300),0);assert.equal(x.p.qtyOpen,qty);assert.equal(x.p.fees,fee);assert.equal(x.p.tpHit[0],false);
 assert.equal(x.e.view(x.p).execution!.desiredStop,null);
 x.db.db.exec('DROP TRIGGER fail_target');assert.equal(x.settle(T+400),1);assert.equal(x.p.tpHit[0],true);
});
