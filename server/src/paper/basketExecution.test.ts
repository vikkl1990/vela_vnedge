import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG,type ScannerConfig} from '../config.ts';
import {PaperEngine} from './engine.ts';
import {planSnapshot,planScannerId,validateExecutionPlans,type ExecutionPlan} from './executionPlans.ts';
import {BASKET_SCANNER,BASKET_MARKER} from './basket.ts';
import {eligibleEvidence} from '../evidence/trades.ts';
import {applyFundingSettlement} from './logic.ts';
const T=1800000000000,H=900000;
const specs=JSON.parse(fs.readFileSync(new URL('../../../scripts/specs.json',import.meta.url),'utf8'));
function fixture(t:any){
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.execution.mode='paper';
 Object.assign(cfg.paper,{sizingMode:'margin',marginPerTrade:150,maxStopLossPct:3,initialEquity:1000,maxSignalAgeSec:60,minRiskFeeRatio:6,liquidation:true,latencyMs:100,fillSource:'tape',slippageBps:0,quotedSlippageBps:0,depthUsdPerBp:0,useSpread:false,requireQuote:false,marginLeverage:{base:5,weak:5,strong:5,minTrades:30,lookback:100,strongAboveR:.1,weakBelowR:0},limitEntry:undefined});
 cfg.scanners[BASKET_SCANNER]={symbols:null,timeframes:null,...specs[BASKET_SCANNER]} as ScannerConfig;
 const plan:ExecutionPlan={id:'basket-test',revision:1,enabled:true,scannerId:BASKET_SCANNER,symbol:'ETHUSD',tf:'15m',variant:'current',referenceEquity:1000,basket:'rsi-volume-ladder-v1',readingOverride:{version:1}};
 cfg.executionPlans=[plan];const snapshot=planSnapshot(cfg,plan,'source'),id=planScannerId(snapshot);
 const db=new Db(':memory:');t.after(()=>db.db.close());let now=T;
 let e=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});e.causalExits=true;
 const enter=(price:number,bar=T-H)=>e.onEntry({kind:'entry',side:'long',price,tp:[],source:'shape',label:BASKET_MARKER,message:'',barTime:bar,barIndex:0},{scannerId:id,scannerName:'Basket',symbol:'ETHUSD',tf:'15m',market:{contractValue:.1,tickSize:.01},refPrice:price,at:now,signalId:null,exitMode:'levels',executionPlan:snapshot});
 const fill=(price:number,at=now+100)=>{now=at;e.onTrade('ETHUSD',price,1e6,now,now);};
 return {cfg,db,plan,snapshot,id,get e(){return e;},enter,fill,at:(x:number)=>{now=x;},restart:()=>{e=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});e.causalExits=true;}};
}
test('basket fills three entries as ONE trade with a shared $150 budget, actual weighted basis, fees and stop-risk ceiling',t=>{
 const x=fixture(t);assert.deepEqual(validateExecutionPlans(x.cfg.executionPlans,{'15m':900}),[]);
 assert.equal(x.enter(100).action,'pending');x.fill(100);let p=x.e.openPositions()[0];assert.ok(p.basket);
 const firstQty=p.qty;assert.equal(p.basket!.entries,1);assert.ok(p.basket!.marginUsed<=50);assert.equal(p.sl,97);assert.equal(p.tp[0],104);
 x.at(T+H);assert.equal(x.enter(98.4,T).action,'pending');assert.equal(p.qty,firstQty);x.fill(98.4);
 assert.equal(x.e.openPositions().length,1);assert.equal(p.basket!.entries,2);assert.ok(p.entryPrice<100&&p.entryPrice>98.4);
 x.at(T+2*H);assert.equal(x.enter(96.8,T+H).action,'pending');x.fill(96.8);
 assert.equal(p.basket!.entries,3);assert.ok(p.basket!.marginUsed<=150);assert.equal(p.fills.length,3);
 assert.equal(x.db.get<any>('SELECT count(*) n FROM positions WHERE status=\'open\'')!.n,1);
 assert.equal(x.db.get<any>('SELECT count(*) n FROM paper_basket_entries')!.n,3);
 const entries=p.fills.filter(f=>f.reason==='entry'),qty=entries.reduce((n,f)=>n+f.qty,0);
 assert.equal(p.qty,qty);assert.equal(p.qtyOpen,qty);assert.ok(Math.abs(p.entryPrice-entries.reduce((n,f)=>n+f.qty*f.price,0)/qty)<1e-10);
 assert.ok(p.riskAmount+p.fees<30);assert.equal(p.fees,entries.reduce((n,f)=>n+f.fee,0));
 assert.equal(p.tp[0],Math.round(p.entryPrice*1.04*100)/100);
 x.at(T+3*H);assert.match(x.enter(95.3,T+2*H).reason!,/three entries/);
 const stop=p.sl!,stopAt=T+3*H+200;x.fill(stop-.1,stopAt);assert.equal(p.status,'open');
 const fees=p.fees;x.e.settleExits('ETHUSD',{receivedAt:stopAt+100,exchangeAt:stopAt+100,bids:[{price:stop-.2,size:qty}],asks:[{price:stop-.1,size:qty}]},stopAt+100);
 assert.equal(p.status,'closed');assert.ok(p.fees>fees);assert.equal(p.fills.at(-1)!.qty,qty);
 assert.equal(x.db.get<any>(`SELECT count(*) n FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE ${eligibleEvidence}`)!.n,0);
 assert.equal(x.cfg.paper.marginPerTrade,150);assert.equal(x.cfg.paper.maxStopLossPct,3);
});
test('basket rejects duplicate bars, too-small drops, fourth legs, unclosed bars, and any account use',t=>{
 const x=fixture(t);assert.match(x.enter(100,T).reason!,/closed/);x.enter(100);x.fill(100);
 assert.match(x.enter(98.4).reason!,/consumed/);x.at(T+H);assert.match(x.enter(99,T).reason!,/1.5%/);
 const account=new PaperEngine(x.db,()=>x.cfg,{book:0});account.causalExits=true;
 assert.equal(account.onEntry({kind:'entry',side:'long',price:100,tp:[],source:'shape',label:BASKET_MARKER,message:'',barTime:T-H,barIndex:0},{scannerId:x.id,scannerName:'x',symbol:'ETHUSD',tf:'15m',market:{contractValue:.1,tickSize:.01},refPrice:100,at:T,signalId:null,exitMode:'levels',executionPlan:x.snapshot}).action,'rejected');
});
test('restart keeps confirmed basket legs but cancels an unfilled add; funding uses quantity at settlement time',t=>{
 const x=fixture(t);x.enter(100);x.fill(100);const before=x.e.openPositions()[0].qty;
 x.at(T+H);x.enter(98.4,T);x.restart();assert.equal(x.e.pendingEntries().length,0);assert.equal(x.e.openPositions()[0].qty,before);
 x.at(T+2*H);x.enter(98.4,T+H);x.fill(98.4);const p=x.e.openPositions()[0];
 assert.equal(p.basket!.entries,2);const f=applyFundingSettlement(p,.1,100,T+1000)!;
 assert.ok(Math.abs(f.pnl-(-.001*before*.1*100))<1e-10);assert.equal(applyFundingSettlement(p,.1,100,T+1000),null);
});
test('price rebound or a stop crossed during pending add cannot fill; rejection leaves the basket unchanged',t=>{
 for(const price of [99,96]){
  const x=fixture(t);x.enter(100);x.fill(100);const p=x.e.openPositions()[0],qty=p.qty,fee=p.fees;
  x.at(T+H);x.enter(98.4,T);x.fill(price);
  assert.equal(p.qty,qty);assert.equal(p.fees,fee);assert.equal(p.basket!.entries,1);assert.equal(x.e.pendingEntries().length,0);
 }
});
test('a failed basket ledger write rolls back weighted basis, quantity, fees and placeholder removal',t=>{
 const x=fixture(t);x.enter(100);x.fill(100);const p=x.e.openPositions()[0],before=structuredClone(p);
 x.at(T+H);x.enter(98.4,T);x.db.db.exec("CREATE TRIGGER fail_basket BEFORE INSERT ON paper_basket_entries BEGIN SELECT RAISE(ABORT,'basket failure'); END");
 x.fill(98.4);for(const field of ['qty','qtyOpen','entryPrice','sl','tp','fees','fills','basket','riskAmount'] as const)assert.deepEqual(p[field],before[field]);assert.equal(x.e.pendingEntries().length,1);assert.equal(x.db.get<any>('SELECT count(*) n FROM orders')!.n,1);
 x.db.db.exec('DROP TRIGGER fail_basket');x.fill(98.4,T+H+200);assert.equal(p.basket!.entries,2);
});
