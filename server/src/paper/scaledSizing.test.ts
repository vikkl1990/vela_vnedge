import test from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from './engine.ts';
import {sizeContracts} from './logic.ts';

function config(){const c=structuredClone(DEFAULT_CONFIG);Object.assign(c.paper,{initialEquity:1000,sizingMode:'margin',marginPerTrade:150,
  maxStopLossPct:3,feeRatePct:0,makerFeeRatePct:0,feeTaxPct:0,slippageBps:0,quotedSlippageBps:0,
  requireQuote:false,useSpread:false,liquidation:false,latencyMs:0,skipScriptStops:false,minRiskFeeRatio:0,maxSignalAgeSec:0,
  minSizeShare:.5,limitEntry:undefined,marginLeverage:{base:5,strong:5,weak:5,minTrades:20,lookback:30,strongAboveR:.05,weakBelowR:-.05}});return c;}
test('pilot capacity uses the intended fraction before checking available margin',()=>{
  const cfg=config().paper;
  const size=(availableMargin:number,sizeScale=1/3)=>sizeContracts(100,98,{equity:1000,availableMargin,contractValue:1,tickSize:.01,cfg,sizeScale});
  assert.equal(size(1000).qty,2);assert.equal(size(50).qty,2,'$40 pilot fits although full $140 trade does not');
  assert.equal(size(100).qty,2,'margin must not shrink the order twice');
  assert.equal(size(20).qty,1);assert.equal(size(19).qty,0);
  assert.equal(size(50,1).qty,0,'full-size scrap refusal retained');
  assert.equal(size(1000).riskAmount,4);assert.equal(size(1000).marginLeverage,5);
});
test('scaled depth risk is repriced inside its reduced loss budget',()=>{
  const cfg={...config().paper,depthUsdPerBp:10,maxStopLossPct:1,marginPerTrade:1000};
  const s=sizeContracts(100,98,{equity:1000,availableMargin:1000,contractValue:1,tickSize:.01,cfg,sizeScale:1/3});
  assert.ok(s.qty>0);assert.ok(s.riskAmount<=1000*.01/3+1e-8);
});
test('scaling preserves fee-inclusive stop ceilings, rejects invalid fractions and never boosts normal size',()=>{
  for(const sizingMode of ['risk','margin','quality'] as const)for(const sl of [90,98,102,110])for(const availableMargin of [20,50,100,1000]){
    const cfg={...config().paper,sizingMode,feeRatePct:.05,makerFeeRatePct:.02,feeTaxPct:18,slippageBps:2};
    const input={equity:1000,availableMargin,contractValue:1,tickSize:.01,cfg};
    const full=sizeContracts(100,sl,{...input,availableMargin:1000});
    const reduced=sizeContracts(100,sl,{...input,sizeScale:1/3});
    assert.ok(reduced.qty<=Math.floor(full.qty/3));assert.ok(reduced.riskAmount<=full.riskAmount/3+1e-8);
    assert.ok(reduced.qty*100/reduced.marginLeverage<=availableMargin+1e-8);
    for(const scale of [0,-1,NaN,Infinity,1.1])assert.equal(sizeContracts(100,sl,{...input,sizeScale:scale}).qty,0);
  }
});
test('maker pilot reservation survives restart and shares the wallet without oversubscription',t=>{
  const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=config();cfg.paper.initialEquity=200;cfg.paper.maxStopLossPct=0;
  cfg.paper.fillSource='tape';cfg.paper.limitEntry={enabled:true,tfs:['15m'],books:['account'],atr:0,bars:2};
  cfg.incubator.mirror={enabled:true,pilot:{sizeScale:1/3,maxDailyEntries:0,maxOpenPositions:0}};
  const at=1000000;
  const ev={kind:'entry',side:'long',price:100,sl:98,tp:[110],barTime:0,barIndex:0,label:'Long',message:'',source:'alert'} as const;
  const ctx={scannerId:'s',scannerName:'s',symbol:'BTCUSD',tf:'15m',market:{contractValue:1,tickSize:.01},atr:1,refPrice:100,at,signalId:null,exitMode:'both' as const};
  const engine=new PaperEngine(db,()=>cfg,{now:()=>at});assert.equal(engine.onEntry({...ev,tp:[...ev.tp]},ctx).action,'pending');
  const pilot=engine.onEntry({...ev,tp:[...ev.tp]},{...ctx,symbol:'ETHUSD',scannerId:'pilot',sizeScale:1/3,features:{copy_pilot:1}});
  assert.equal(pilot.action,'pending');assert.equal(engine.pendingEntries()[1].reservation!.qty,2);
  const restored=new PaperEngine(db,()=>cfg,{now:()=>at});restored.risk={gate:()=>({leverageMult:1}),exposureCheck:()=>null};
  restored.onTrade('ETHUSD',99.99,100,at+2000,at+2000);
  assert.equal(restored.openPositions()[0].qty,2);
  assert.ok(restored.openPositions()[0].qty*100/5+restored.pendingEntries()[0].reservation!.margin<=200);
});
