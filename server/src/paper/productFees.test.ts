import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_CONFIG} from '../config.ts';
import {Db} from '../db.ts';
import {marketSpec, type DeltaProduct} from '../delta/rest.ts';
import {productFees,withProductFees} from './productFees.ts';
import {PaperEngine} from './engine.ts';
import {admissionCostPct} from './costs.ts';
import {feeFor} from './logic.ts';
import {runBacktest} from './backtest.ts';
import {planSnapshot} from './executionPlans.ts';
import {EntryDepthGate} from '../risk/entryDepth.ts';
import {MarketGate} from '../risk/marketGate.ts';

const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const oil=productFees({symbol:'OILUSD',taker_commission_rate:'0.0002',maker_commission_rate:'0.0002'})!;
const market={contractValue:1,tickSize:0.01,productFees:oil};
const at=Math.floor(Date.now()/60000)*60000+1000;
function config(){
 const c=structuredClone(DEFAULT_CONFIG);
 Object.assign(c.paper,{initialEquity:1000,sizingMode:'margin',marginPerTrade:150,feeRatePct:.05,makerFeeRatePct:.02,feeTaxPct:18,
  latencyMs:0,slippageBps:0,depthUsdPerBp:0,requireQuote:false,useSpread:false,fillSource:'candles',maxSignalAgeSec:0,
  skipScriptStops:false,minRiskFeeRatio:6,liquidation:false,trendGate:{enabled:false},trailAfterR:0,floorAtR:0,
  limitEntry:{enabled:true,tfs:['1h'],books:['account','shadow'],atr:0,bars:2}});
 c.scanners.s={enabled:true,symbols:['OILUSD'],timeframes:['1h'],exitMode:'both'};
 return c;
}
const event={kind:'entry' as const,side:'long' as const,price:100,sl:99.6,tp:[110],label:'',message:'',source:'alert' as const,barTime:at-3600000,barIndex:0};
const context={scannerId:'s',scannerName:'s',symbol:'OILUSD',tf:'1h',market,refPrice:100,at,signalId:null,exitMode:'both' as const,atr:1};

test('product fractions convert once, missing/invalid rates do not mean free trading, and GST stays separate',()=>{
 const p={symbol:'OILUSD',contract_value:'1',tick_size:'.01',taker_commission_rate:'.0002',maker_commission_rate:'.0002'} as DeltaProduct;
 assert.deepEqual(marketSpec(p).productFees,oil);
 for(const v of [undefined,null,'', ' ', 'broken',NaN,Infinity,-.001,.01])assert.equal(productFees({...p,taker_commission_rate:v}),undefined);
 assert.equal(productFees({...p,maker_commission_rate:undefined}),undefined);
 assert.equal(productFees({...p,taker_commission_rate:'0',maker_commission_rate:'0'})!.feeRatePct,0);
 const c=config().paper, snapshot=structuredClone(c), bound=withProductFees(c,oil,'OILUSD');
 near(feeFor(100,10,1,c),.59); near(feeFor(100,10,1,bound),.236);
 near(feeFor(100,10,1,bound,true),.236); assert.deepEqual(c,snapshot);
 assert.equal(withProductFees(c,undefined,'OILUSD'),c);
 assert.throws(()=>withProductFees(c,oil,'BTCUSD'),/invalid product/);
});

for(const book of [0,2])test(`book ${book}: OIL admission, pending fill, restart and close share immutable product fees`,()=>{
 const db=new Db(':memory:'),c=config();let now=at;
 const e=new PaperEngine(db,()=>c,{book,now:()=>now});
 // This 0.4% stop fails the crypto 6x cost gate but clears the OIL maker budget.
 const generic=new PaperEngine(new Db(':memory:'),()=>c,{book,now:()=>now});
 assert.equal(generic.onEntry(event,{...context,market:{contractValue:1,tickSize:.01}}).action,'rejected');
 const d=e.onEntry(event,context);assert.equal(d.action,'pending',d.reason);
 near(e.pendingEntries()[0].policy!.paper.feeRatePct,.02);
 near(e.pendingEntries()[0].policy!.sizing.feeRatePct,.02);
 const restart=new PaperEngine(db,()=>c,{book,now:()=>now});
 restart.marketFeesFor=()=>({...oil,feeRatePct:.03}); // later observation must not change this order
 now=at+120000;
 restart.onBar('OILUSD',{time:at+60000,high:100.01,low:99.99,close:100},now);
 const p=restart.openPositions()[0]; assert.ok(p);near(p.fees,100*p.qty*.0002*1.18);
 const id=p.policy!.id; c.paper.feeRatePct=.4;c.paper.makerFeeRatePct=.3;
 const restored=new PaperEngine(db,()=>c,{book,now:()=>now});
 assert.equal(restored.openPositions()[0].policy!.id,id);
 restored.setMark('OILUSD',101);
 restored.onScriptExit('s','OILUSD','1h','close',101,now+1000,'both');
 const closed=restored.closedPositions()[0];assert.ok(closed);near(closed.fees,(100+101)*closed.qty*.0002*1.18);
 const trace=db.get<{snapshot:string}>("SELECT snapshot FROM decision_trace WHERE stage='received' ORDER BY id DESC LIMIT 1");
 near(JSON.parse(trace!.snapshot).feeRatePct,.02);
});

test('OIL fee changes separate policy evidence while unchanged crypto keeps its existing identity',()=>{
 const c=config(),e=new PaperEngine(new Db(':memory:'),()=>c);
 const before=e.policyForCell(context), old=e.policyForCell({...context,market:undefined});
 assert.notEqual(before.strategyId,old.strategyId);
 const btc={...context,symbol:'BTCUSD',market:{contractValue:1,tickSize:.01}};
 const a=e.policyForCell(btc);
 e.marketFeesFor=symbol=>productFees({symbol,taker_commission_rate:'.0005',maker_commission_rate:'.0002'});
 assert.equal(e.policyForCell(btc).id,a.id);
 // Legacy adoption is deliberately not a retroactive fee upgrade.
 e.marketFeesFor=()=>oil;near(e.policyForCell(context,true).paper.feeRatePct,.05);
});

test('backtests disclose current-product pricing, and frozen research plans retain their own rates',()=>{
 const c=config();c.paper.minRiskFeeRatio=0;
 const h=3600000,bars=Array.from({length:35},(_,i)=>({time:at+i*h,open:100,high:100.01,low:99.99,close:100,volume:10}));
 const entry={...event,sl:90,barTime:bars[30].time,barIndex:30},exit={...event,kind:'exit' as const,exitType:'close' as const,barTime:bars[31].time,barIndex:31};
 const inp={scannerId:'s',scannerName:'s',symbol:'OILUSD',tf:'1h',bars,events:[entry,exit],cfg:c.paper,exitMode:'both' as const,...market};
 const current=runBacktest(inp),generic=runBacktest({...inp,productFees:undefined});
 assert.equal(current.trades.length,1);assert.equal(generic.trades.length,1);
 near(current.trades[0].fees/current.trades[0].qty,.0472);
 near(generic.trades[0].fees/generic.trades[0].qty,.118);
 assert.equal(current.costCoverage.feeSchedule?.basis,'current-product-scenario');
 const plan=planSnapshot(c,{id:'oil',revision:1,enabled:true,scannerId:'s',symbol:'OILUSD',tf:'1h',variant:'current',referenceEquity:1000},null,oil);
 near(plan.paper.feeRatePct,.02);
 const frozen=runBacktest({...inp,executionPlan:plan,productFees:{...oil,feeRatePct:.04}});
 near(frozen.trades[0].fees/frozen.trades[0].qty,.0472);
});

test('fresh-depth and cached market budgets use the same product rates without changing risk limits',async()=>{
 const c=config();Object.assign(c.risk.marketGate!,{enabled:true,freshDepth:true,maxBookCostPct:.06,minTurnoverUsd:0,minAtrFeeMult:0,cryptoOnly:false,exempt:[],probeNotionalUsd:1000});
 const limits=structuredClone(c.risk),fees=withProductFees(c.paper,oil,'OILUSD');
 const gate=new EntryDepthGate({cfg:()=>c,now:()=>at,book:async()=>({buy:[{price:100,size:1000}],sell:[{price:100,size:1000}],timestamp:at})});
 await gate.prepare('OILUSD');
 const req={symbol:'OILUSD',qty:10,contractValue:1,maker:true,at};
 assert.ok(gate.check(req).reject);assert.equal(gate.check({...req,fees}).reject,undefined);
 const db=new Db(':memory:'),m=new MarketGate({db,cfgRef:()=>c,candles:null,feesFor:()=>fees,markets:async()=>[{symbol:'OILUSD',price:100,volume24h:1e8}],book:async()=>({bids:[[100,1000]],asks:[[100,1000]]})});
 const row=(await m.refresh(['OILUSD'],at)).markets[0];near(row.bookCostPct!,.0472);near(row.feeRoundTripPct!,.0472);near(row.bookCrossingPct!,0);
 assert.deepEqual(c.risk,limits);near(admissionCostPct(c.paper),.118);
});
