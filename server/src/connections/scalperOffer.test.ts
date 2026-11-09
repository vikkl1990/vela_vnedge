import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DeltaRest,DELTA_INDIA_TESTNET} from '../delta/rest.ts';
import {activateScalperOffer,bindScalperConnection,readScalperEligibility} from './scalperOffer.ts';
import {DEFAULT_CONFIG,validateConfig} from '../config.ts';
import {closingFeeWaived,fillExit,openPosition} from '../paper/logic.ts';
import {admissionCostPct,offerStatus} from '../paper/costs.ts';
import {PaperEngine} from '../paper/engine.ts';
import {Db} from '../db.ts';
import {runBacktest} from '../paper/backtest.ts';

const at=1794248823000;
const observation={active:true,checkedAt:at,accountHash:'a'.repeat(64),connectionRevision:'saved-key-revision'};
const base=()=>({...structuredClone(DEFAULT_CONFIG.paper),liquidation:false,slippageBps:0,depthUsdPerBp:0,feeTaxPct:18});
const position=(cfg:any,symbol='BTCUSD',openedAt=at)=>openPosition({id:1,scannerId:'s',scannerName:'s',symbol,tf:'15m',side:'long',qty:10,contractValue:1,entryPrice:100,at:openedAt,sl:90,tp:[110],riskAmount:100,levelsSource:'script',signalId:null,cfg,bt:false});
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('eligibility uses only an authenticated production account boolean, with no raw identity or credential output',async t=>{
  let active:unknown=true;
  t.mock.method(globalThis,'fetch',async(url:string,options:RequestInit)=>{
    assert.equal(url,'https://api.india.delta.exchange/v2/users/trading_preferences');
    assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.body,undefined);
    return new Response(JSON.stringify({success:true,result:{user_id:123,futures_scalper_offer_enabled:active,email:'private@example.invalid'}}));
  });
  const rest=new DeltaRest({apiKey:'secret-key',apiSecret:'secret-secret'});
  for(const value of [true,false,'true',1,undefined]){
    active=value;const result=await readScalperEligibility(rest,'r');
    assert.equal(result.active,typeof value==='boolean'?value:null);
    assert.equal(result.accountHash.length,64);
    assert.ok(!JSON.stringify(result).includes('secret'));assert.ok(!JSON.stringify(result).includes('private@'));
  }
  await assert.rejects(readScalperEligibility(new DeltaRest({baseUrl:DELTA_INDIA_TESTNET}),'r'),/production/);
});

test('activation preserves risk and base fees, uses first verified time, and cannot backdate or cross accounts',()=>{
  const p=base(),original=structuredClone(p),enabled=activateScalperOffer(p,observation);
  assert.deepEqual(p,original);const {scalperOffer,...rest}=enabled;const {scalperOffer:old,...expected}=p;assert.deepEqual(rest,expected);
  assert.equal(scalperOffer?.joinedAt,undefined);assert.equal(scalperOffer?.verification?.effectiveFrom,at);
  assert.equal(offerStatus(enabled),'exchange-verified');assert.equal(admissionCostPct(enabled),admissionCostPct(p));
  assert.deepEqual(activateScalperOffer(enabled,{...observation,checkedAt:at+1000}),enabled);
  const changed=activateScalperOffer(enabled,{...observation,checkedAt:at+1000,accountHash:'b'.repeat(64)});
  assert.equal(changed.scalperOffer?.verification?.effectiveFrom,at+1000);
  for(const active of [false,null])assert.throws(()=>activateScalperOffer(p,{...observation,active}),/not verified/);
  assert.equal(bindScalperConnection(enabled,observation.connectionRevision),enabled);
  assert.equal(offerStatus(bindScalperConnection(enabled,'another-key')),'disabled');
  assert.equal(offerStatus(bindScalperConnection(enabled,null)),'disabled');
  const invalid=structuredClone(DEFAULT_CONFIG);invalid.paper=enabled;invalid.paper.scalperOffer!.verification!.effectiveFrom=at-1;
  assert.ok(validateConfig(invalid).some(s=>s.includes('no backdating')));assert.equal(offerStatus(invalid.paper),'unverified-full-fees');
  const badDate=activateScalperOffer(base(),observation);badDate.scalperOffer!.joinedAt=NaN;assert.equal(offerStatus(badDate),'unverified-full-fees');
});

test('BTC/ETH and OIL/other futures honor exact windows, exclusions, partial fills and actual opening time',()=>{
  const cfg=activateScalperOffer(base(),observation);
  for(const [symbol,minutes] of [['BTCUSD',30],['ETHUSD',30],['OILUSD',15],['SOLUSD',15]] as const){
    const p=position(cfg,symbol);
    assert.equal(closingFeeWaived(p,at+minutes*60000,'sl',cfg),true);
    assert.equal(closingFeeWaived(p,at+minutes*60000+1,'sl',cfg),false);
    assert.equal(closingFeeWaived(p,at+1,'liquidation',cfg),false);
    assert.equal(closingFeeWaived(position(cfg,symbol,at-1),at+1,'close',cfg),false);
    assert.equal(closingFeeWaived(p,at-1,'close',cfg),false);
    const early=fillExit(p,101,4,'tp1',at+60000,cfg,false);
    assert.equal(early.fee,0);near(early.feeDiscount!,early.feeGross!);assert.ok(early.feeGross!>0);
    const late=fillExit(p,102,6,'close',at+(minutes+1)*60000,cfg,true);
    assert.ok(late.fee>0);assert.equal(late.feeDiscount,0);near(p.fees,p.fills[0].fee+late.fee);
  }
  for(const symbol of ['PAXGUSD','SLVONUSD','XAUTUSD'])assert.equal(closingFeeWaived(position(cfg,symbol),at+1,'close',cfg),false);
  const oil=activateScalperOffer({...base(),feeRatePct:.02,makerFeeRatePct:.02},observation),p=position(oil,'OILUSD');
  near(p.fees,.236);fillExit(p,100,10,'close',at+60000,oil,true);near(p.fees,.236);near(p.fills[1].feeDiscount!,.236);
});

for(const book of [0,2])test(`book ${book}: only new policies gain eligibility; fee evidence survives restart`,()=>{
  const cfg=structuredClone(DEFAULT_CONFIG),db=new Db(':memory:');let now=at-1000;
  Object.assign(cfg.paper,base(),{initialEquity:1000,marginPerTrade:150,sizingMode:'margin',minSizeShare:0,minRiskFeeRatio:0,skipScriptStops:false,latencyMs:0,fillSource:'candles',useSpread:false,requireQuote:false,maxSignalAgeSec:0,trailAfterR:0,floorAtR:0,trendGate:{enabled:false},limitEntry:undefined});
  cfg.scanners.s={enabled:true,symbols:['OILUSD'],timeframes:['1h'],exitMode:'both'};
  const engine=new PaperEngine(db,()=>cfg,{book,now:()=>now});
  const ev={kind:'entry' as const,side:'long' as const,price:100,sl:99,tp:[110],label:'',message:'',source:'alert' as const,barTime:now-3600000,barIndex:0};
  const ctx={scannerId:'s',scannerName:'s',symbol:'OILUSD',tf:'1h',market:{contractValue:1,tickSize:.01},refPrice:100,at:now,signalId:null,exitMode:'both' as const,atr:1};
  const old=engine.onEntry(ev,ctx);assert.equal(old.action,'opened',old.reason);const oldId=engine.openPositions()[0].policy!.id;
  cfg.paper=activateScalperOffer(cfg.paper,observation);now=at+1000;
  const resumed=new PaperEngine(db,()=>cfg,{book,now:()=>now});assert.equal(resumed.openPositions()[0].policy!.id,oldId);
  resumed.setMark('OILUSD',101);resumed.onScriptExit('s','OILUSD','1h','close',101,now,'both');
  assert.equal(resumed.closedPositions()[0].fills.at(-1)!.feeWaived,false);
  const fresh=resumed.onEntry({...ev,barTime:now-3600000},{...ctx,scannerId:'s2',at:now});assert.equal(fresh.action,'opened',fresh.reason);
  const freshId=resumed.openPositions()[0].id;cfg.paper.scalperOffer!.enabled=false;
  const restarted=new PaperEngine(db,()=>cfg,{book,now:()=>now});restarted.setMark('OILUSD',101);now+=60000;
  restarted.onScriptExit('s2','OILUSD','1h','close',101,now,'both');
  const closed=restarted.closedPositions().find(p=>p.id===freshId)!;assert.equal(closed.fills.at(-1)!.fee,0);
  assert.ok(closed.fills.at(-1)!.feeGross!>0);near(closed.fills.at(-1)!.feeDiscount!,closed.fills.at(-1)!.feeGross!);
  const order=db.get<{id:number}>('SELECT id FROM orders WHERE position_id=? ORDER BY id DESC LIMIT 1',freshId)!;
  const actual=restarted.restateOrderFill(order.id,{price:101,fee:0})!;
  assert.equal(actual.fills.at(-1)!.fee,0);assert.equal(actual.fills.at(-1)!.feeGross,undefined);
  assert.equal(actual.fills.at(-1)!.feeDiscount,undefined);assert.equal(actual.fills.at(-1)!.feeWaived,undefined);
});

test('historical replay keeps full fees before the first verified date and does not book BTC voucher profit',()=>{
  const cfg=activateScalperOffer({...base(),minRiskFeeRatio:0,trailAfterR:0,floorAtR:0,allowReversal:false},observation);
  const step=60000,bars=Array.from({length:35},(_,i)=>({time:at-86400000+i*step,open:100,high:100.01,low:99.99,close:100,volume:1}));
  const event={kind:'entry' as const,side:'long' as const,price:100,sl:90,tp:[110],barTime:bars[30].time,barIndex:30,label:'',message:'',source:'alert' as const};
  const bt=runBacktest({scannerId:'s',scannerName:'s',symbol:'BTCUSD',tf:'1m',bars,events:[event,{...event,kind:'exit',exitType:'close',barTime:bars[31].time,barIndex:31}],cfg,exitMode:'both',contractValue:1,tickSize:.01});
  assert.equal(bt.trades.length,1);assert.equal(bt.costCoverage.feeWaiver,'verified-from');assert.equal(bt.trades[0].fills.filter(f=>f.feeWaived).length,0);assert.ok(bt.trades[0].pnl<0);
});
