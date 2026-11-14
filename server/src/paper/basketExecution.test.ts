import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG,type ScannerConfig,type PaperConfig} from '../config.ts';
import {PaperEngine} from './engine.ts';
import {planSnapshot,planScannerId,validateExecutionPlans,type ExecutionPlan} from './executionPlans.ts';
import {BASKET_SCANNER,BASKET_MARKER} from './basket.ts';
import {eligibleEvidence} from '../evidence/trades.ts';
import {applyFundingSettlement,feeFor,slip,impactOnly,rMultiple,sizeContracts} from './logic.ts';
import {basketStopRisk,basketSizing,basketLevels,sizeBasketEntry} from './basket.ts';
import {Journal} from '../analytics/journal.ts';
import {EntryDepthGate,wireEntryDepth} from '../risk/entryDepth.ts';
const T=1800000000000,H=900000;
const specs=JSON.parse(fs.readFileSync(new URL('../../../scripts/specs.json',import.meta.url),'utf8'));
function fixture(t:any,paper:Partial<PaperConfig>={},legacy=false){
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.execution.mode='paper';
 Object.assign(cfg.paper,{sizingMode:'margin',marginPerTrade:150,maxStopLossPct:3,initialEquity:1000,maxSignalAgeSec:60,minRiskFeeRatio:6,liquidation:true,latencyMs:100,fillSource:'tape',slippageBps:0,quotedSlippageBps:0,depthUsdPerBp:0,useSpread:false,requireQuote:false,marginLeverage:{base:5,weak:5,strong:5,minTrades:30,lookback:100,strongAboveR:.1,weakBelowR:0},limitEntry:undefined});
 Object.assign(cfg.paper,paper);
 cfg.scanners[BASKET_SCANNER]={symbols:null,timeframes:null,...specs[BASKET_SCANNER]} as ScannerConfig;
 const plan:ExecutionPlan={id:'basket-test',revision:1,enabled:true,scannerId:BASKET_SCANNER,symbol:'ETHUSD',tf:'15m',variant:'current',referenceEquity:1000,basket:'rsi-volume-ladder-v1',readingOverride:{version:1}};
 cfg.executionPlans=[plan];const snapshot=planSnapshot(cfg,plan,'source');if(legacy)delete snapshot.basketAccountingVersion;const id=planScannerId(snapshot);
 const db=new Db(':memory:');t.after(()=>db.db.close());let now=T;
 let e=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});e.causalExits=true;
 const enter=(price:number,bar=T-H)=>e.onEntry({kind:'entry',side:'long',price,tp:[],source:'shape',label:BASKET_MARKER,message:'',barTime:bar,barIndex:0},{scannerId:id,scannerName:'Basket',symbol:'ETHUSD',tf:'15m',market:{contractValue:.1,tickSize:.01},refPrice:price,at:now,signalId:null,exitMode:'levels',executionPlan:snapshot});
 const fill=(price:number,at=now+100)=>{now=at;e.onTrade('ETHUSD',price,1e6,now,now);};
 return {cfg,db,plan,snapshot,id,getNow:()=>now,get e(){return e;},enter,fill,at:(x:number)=>{now=x;},restart:()=>{e=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});e.causalExits=true;}};
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
 assert.ok(p.riskAmount<=30);assert.equal(p.fees,entries.reduce((n,f)=>n+f.fee,0));
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

function threeLegs(x:ReturnType<typeof fixture>){
 for(const [i,price] of [100,98.4,96.8].entries()){x.at(T+i*H);assert.equal(x.enter(price,T+(i-1)*H).action,'pending');x.fill(price);}
 const p=x.e.openPositions()[0];assert.equal(p.basket!.entries,3);return p;
}
function stopAtModel(x:ReturnType<typeof fixture>){
 const p=x.e.openPositions()[0],at=T+3*H,price=slip(p.sl!,'sell',x.snapshot.paper,p.sl!*p.qty*p.contractValue);
 x.fill(p.sl!,at);x.e.settleExits(p.symbol,{receivedAt:at+100,exchangeAt:at+100,bids:[{price,size:p.qty}],asks:[{price:price+.01,size:p.qty}]},at+100);
 assert.equal(p.status,'closed');return p;
}
test('one shared stop includes all entry commissions, GST and modeled exit costs exactly once',t=>{
 for(const count of [1,3]){
  const x=fixture(t,{feeRatePct:.05,makerFeeRatePct:.02,feeTaxPct:18,slippageBps:2});
  let p;if(count===3)p=threeLegs(x);else{x.enter(100);x.fill(100);p=x.e.openPositions()[0];}
  const risk=p.riskAmount,entryFees=p.fees;
  assert.ok(risk<=30);assert.ok(p.basket!.marginUsed<=150);
  stopAtModel(x);
  const expectedFees=p.fills.filter(f=>f.reason==='entry').reduce((n,f)=>n+f.price*f.qty*p.contractValue*.0005*1.18,0);
  assert.ok(Math.abs(entryFees-expectedFees)<1e-10);
  assert.ok(Math.abs(p.fees-entryFees-feeFor(p.exitPrice!,p.qty,p.contractValue,x.snapshot.paper))<1e-10);
  assert.ok(Math.abs(rMultiple(p)!+1)<1e-10,`net R ${rMultiple(p)}`);
  assert.equal(p.riskAmount,risk,'exit does not normalize the recorded risk');
 }
});
test('combined basket stop impact shrinks a leg when separate-leg sizing would breach the unchanged cap',t=>{
 const x=fixture(t);x.enter(100);x.fill(100);const held=x.e.openPositions()[0];
 // Small measured depth amplifies the shared-order cost; ordinary sizing prices the two exits separately.
 const cfg={...x.snapshot.paper,depthUsdPerBp:1},price=98.4,sl=basketLevels(price,.01,held).sl;
 const budget=basketSizing(cfg,1000,sl,held)!;
 const inputs={cfg,equity:1000,availableMargin:1000,contractValue:.1,tickSize:.01,wantedLeverage:5,entryExecution:{quoted:true}};
 const old=sizeContracts(price,sl,{...inputs,cfg:budget}),fixed=sizeBasketEntry(price,sl,inputs,held);
 const combined=(n:number)=>{const entry=impactOnly(price,'buy',cfg,price*n*.1);return basketStopRisk(cfg,sl,held.qty+n,.1,held.entryPrice*held.qty*.1+entry*n*.1,held.fees+feeFor(entry,n,.1,cfg));};
 assert.ok(combined(old.qty)>30,`old ${old.qty}, risk ${combined(old.qty)}`);
 assert.ok(fixed.qty>0&&fixed.qty<old.qty);assert.ok(combined(fixed.qty)<=30);
 assert.equal(cfg.marginPerTrade,150);assert.equal(cfg.maxStopLossPct,3);
});
test('later funding and gaps remain real losses; past positions retain their frozen accounting version',t=>{
 const x=fixture(t);const p=threeLegs(x),risk=p.riskAmount;
 applyFundingSettlement(p,.2,100,T+2*H+200);stopAtModel(x);
 assert.equal(p.riskAmount,risk);assert.ok(rMultiple(p)! < -1);
 const y=fixture(t,{},true),legacy=threeLegs(y);
 assert.ok(Math.abs(legacy.riskAmount-(legacy.entryPrice-legacy.sl!)*legacy.qty*legacy.contractValue)<1e-10);
 y.restart();assert.equal(y.e.openPositions()[0].executionPlan?.basketAccountingVersion,undefined);
 const closed=stopAtModel(y);assert.ok(rMultiple(closed)! < -1);
});
test('all basket legs retain exact pricing, order identity and budgets without overwriting the first entry audit',async t=>{
 const x=fixture(t);let price=100;
 x.cfg.risk.marketGate={...x.cfg.risk.marketGate!,enabled:true,freshDepth:true,maxBookCostPct:.25,exempt:[]};
 const gate=new EntryDepthGate({cfg:()=>x.cfg,now:x.getNow,book:async()=>({timestamp:(x.getNow()-10)*1000,buy:[{price:price-.01,size:1e6}],sell:[{price,size:1e6}]})});
 wireEntryDepth(new PaperEngine(x.db,()=>x.cfg),x.e,gate);
 for(const [i,v] of [100,98.4,96.8].entries()){
  price=v;x.at(T+i*H);await gate.prepare('ETHUSD');assert.equal(x.enter(price,T+(i-1)*H).action,'pending');x.fill(price);
 }
 const p=x.e.openPositions()[0],detail=new Journal(x.db).detail('shadow',p.id),rows=detail.basketEntries as any[];
 assert.equal(rows.length,3);assert.equal(p.fills.length,3);
 for(const [i,row] of rows.entries()){
  const a=row.context.audit,b=row.context.budget,f=p.fills[i];
  assert.equal(a.orderId,f.orderId);assert.equal(a.qty,f.qty);assert.equal(a.price,f.price);assert.equal(a.entryFee,f.fee);assert.equal(a.at,f.at);
  assert.equal(a.role,'taker');assert.equal(a.source,'depth');assert.equal(a.depth.requestedQty,f.qty);assert.equal(a.depth.vwap,f.price);
  assert.equal(a.admissionDepth.checkedQty,f.qty);assert.equal(a.depth.receivedAt,T+i*H);assert.equal(a.depth.exchangeAt,T+i*H-10);
  assert.equal(b.basketEntries,i+1);assert.equal(b.basketAccountingVersion,2);
  assert.equal(b.entryFee,p.fills.slice(0,i+1).reduce((n,f)=>n+f.fee,0));assert.ok(b.risk<=30);
 }
 assert.equal((detail.entryExecution as any).notional,p.fills[0].qty*p.fills[0].price*p.contractValue);
 assert.equal((detail.entryFillEvidence as any).order_id,p.fills[0].orderId);
 assert.equal(new Set(rows.map(r=>r.context.audit.orderId)).size,3);
 assert.equal(x.db.get<any>("SELECT count(*) n FROM decision_trace WHERE stage='basket-add'")!.n,2);
 assert.equal(x.db.get<any>(`SELECT count(*) n FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE ${eligibleEvidence}`)!.n,0);
 x.restart();assert.deepEqual(new Journal(x.db).detail('shadow',p.id).basketEntries,rows);
});
test('add-on budget audit failure rolls back the fill and evidence, and a fresh retry records exactly one leg',t=>{
 const x=fixture(t);x.enter(100);x.fill(100);const p=x.e.openPositions()[0],before=structuredClone(p);
 x.at(T+H);x.enter(98.4,T);
 x.db.db.exec("CREATE TRIGGER fail_add_audit BEFORE INSERT ON decision_trace WHEN NEW.stage='basket-add' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
 x.fill(98.4);assert.equal(p.qty,before.qty);assert.equal(p.fees,before.fees);assert.equal(p.riskAmount,before.riskAmount);
 assert.equal(x.db.get<any>('SELECT count(*) n FROM paper_basket_entries')!.n,1);assert.equal(x.db.get<any>('SELECT count(*) n FROM orders')!.n,1);assert.equal(x.e.pendingEntries().length,1);
 x.db.db.exec('DROP TRIGGER fail_add_audit');x.fill(98.4,T+H+200);
 assert.equal(p.basket!.entries,2);assert.equal(x.db.get<any>('SELECT count(*) n FROM paper_basket_entries')!.n,2);
 assert.equal(x.db.get<any>("SELECT count(*) n FROM decision_trace WHERE stage='basket-add'")!.n,1);
});

test('accounting-only correction preserves cash P&L for an identical tape without adding a version to ordinary plans',t=>{
 const fixed=fixture(t),legacy=fixture(t,{},true),p=threeLegs(fixed),old=threeLegs(legacy);
 assert.equal(p.qty,old.qty);assert.equal(p.entryPrice,old.entryPrice);assert.equal(p.sl,old.sl);
 assert.ok(p.riskAmount>old.riskAmount);
 stopAtModel(fixed);stopAtModel(legacy);
 assert.equal(p.realizedPnl-p.fees,old.realizedPnl-old.fees);
 assert.ok(Math.abs(rMultiple(p)!+1)<1e-10);assert.ok(rMultiple(old)! < -1);
 const ordinary={...fixed.plan,id:'ordinary-test',scannerId:'rsi-volume-ladder',basket:undefined};
 const prior=planSnapshot(fixed.cfg,ordinary,'source');assert.equal(prior.basketAccountingVersion,undefined);
 assert.equal(fixed.snapshot.basketAccountingVersion,2);
 assert.equal(planSnapshot(fixed.cfg,ordinary,'source').signature,prior.signature);
});

test('funding debits already paid consume add-on capacity; credits never expand its risk budget',t=>{
 const x=fixture(t);x.enter(100);x.fill(100);const p=x.e.openPositions()[0],cfg=x.snapshot.paper;
 const sl=basketLevels(98.4,.01,p).sl,inputs={cfg,equity:1000,availableMargin:1000,contractValue:.1,tickSize:.01,wantedLeverage:5};
 const base=sizeBasketEntry(98.4,sl,inputs,p);
 const debit=structuredClone(p);debit.realizedPnl=-15;
 assert.ok(sizeBasketEntry(98.4,sl,inputs,debit).qty<base.qty);
 const credit=structuredClone(p);credit.realizedPnl=15;
 assert.equal(sizeBasketEntry(98.4,sl,inputs,credit).qty,base.qty);
});
