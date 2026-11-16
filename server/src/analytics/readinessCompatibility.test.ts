import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_CONFIG} from '../config.ts';
import {resolveTradePolicy,tradePolicyIdFor,type TradePolicy} from '../paper/tradePolicy.ts';
import {strategyIdFor} from '../paper/strategyIdentity.ts';
import {capacityExpansionCompatible} from './readinessCompatibility.ts';

function policies(){
  const cfg=structuredClone(DEFAULT_CONFIG),cell={scannerId:'s',symbol:'BTCUSD',tf:'1h'};
  cfg.paper.maxOpenPositions=8;cfg.risk.maxPositionsTotal=8;
  const old=resolveTradePolicy(cfg,cell,'source');
  cfg.paper.maxOpenPositions=0;cfg.risk.maxPositionsTotal=0;
  return {old,current:resolveTradePolicy(cfg,cell,'source')};
}
function reidentify(p:TradePolicy){p.strategyId=strategyIdFor(p);p.id=tradePolicyIdFor(p);return p;}

test('readiness accepts only a verified expansion of global count ceilings, preserving immutable identities',()=>{
  const {old,current}=policies(),before=JSON.stringify([old,current]);
  assert.notEqual(old.id,current.id);assert.equal(old.strategyId,current.strategyId);
  assert.equal(capacityExpansionCompatible(old,current),true);
  assert.equal(capacityExpansionCompatible(current,old),false,'tightening could exclude old concurrent trades');
  assert.equal(capacityExpansionCompatible(old,old),false,'exact matching stays a separate basis');
  assert.equal(JSON.stringify([old,current]),before);
  const finite=structuredClone(current);finite.paper.maxOpenPositions=12;finite.sizing.maxOpenPositions=12;finite.risk.maxPositionsTotal=10;
  assert.equal(capacityExpansionCompatible(old,reidentify(finite)),true);
  finite.risk.maxPositionsTotal=7;
  assert.equal(capacityExpansionCompatible(old,reidentify(finite)),false,'expanding one ceiling cannot hide tightening another');
});

const changes:Record<string,(p:TradePolicy)=>void>={
  source:p=>{p.sourceHash='different-source';},reader:p=>{p.reading.reader=2;},symbol:p=>{p.symbol='ETHUSD';},
  timeframe:p=>{p.tf='15m';},simulation:p=>{p.sim++;},exitMode:p=>{p.exitMode='script';},
  margin:p=>{p.sizing.marginPerTrade=75;},resolvedMargin:p=>{p.paper.marginPerTrade=75;},
  leverage:p=>{p.sizing.maxLeverage++;},purse:p=>{p.paper.initialEquity++;},
  stopRisk:p=>{p.paper.maxStopLossPct=4;},sizingStopRisk:p=>{p.sizing.maxStopLossPct=4;},
  takerFee:p=>{p.paper.feeRatePct+=.01;},makerFee:p=>{p.paper.makerFeeRatePct+=.01;},
  tax:p=>{p.paper.feeTaxPct=0;},offer:p=>{p.paper.scalperOffer={enabled:true,majors:['BTCUSD','ETHUSD'],majorsMinutes:30,othersMinutes:15,excluded:[]};},
  signalAge:p=>{p.paper.maxSignalAgeSec++;},latency:p=>{p.paper.latencyMs++;},
  feeGate:p=>{p.paper.minRiskFeeRatio++;},slippage:p=>{p.paper.slippageBps++;},
  stops:p=>{p.paper.skipScriptStops=!p.paper.skipScriptStops;},
  dailyLoss:p=>{p.risk.maxDailyLossPct++;},weeklyLoss:p=>{p.risk.maxWeeklyLossPct++;},
  perSymbol:p=>{p.risk.maxPositionsPerSymbol++;},perScanner:p=>{p.risk.perScannerMaxPositions++;},
  regime:p=>{p.risk.regime={...p.risk.regime,enabled:!p.risk.regime?.enabled};},
  cooldown:p=>{p.risk.reentryCooldownMinutes++;},ml:p=>{p.ml.minProb+=.1;},
};
for(const [name,change]of Object.entries(changes))test(`count expansion does not admit a changed ${name} policy`,()=>{
  const {old,current}=policies();change(current);reidentify(current);
  assert.equal(capacityExpansionCompatible(old,current),false);
});

test('missing, adopted, invalid and tampered policy snapshots fail closed',()=>{
  const {old,current}=policies();
  for(const change of [
    (p:TradePolicy)=>{p.sourceHash=null;reidentify(p);},(p:TradePolicy)=>{p.adoptedAt=1;},
    (p:TradePolicy)=>{p.paper.feeRatePct+=.01;},(p:TradePolicy)=>{p.strategyId='wrong';},
    (p:TradePolicy)=>{p.id='wrong';},(p:TradePolicy)=>{delete (p as Partial<TradePolicy>).sizing;},
    ...[-1,.5,NaN,Infinity].map(n=>(p:TradePolicy)=>{p.paper.maxOpenPositions=n;reidentify(p);}),
  ]){const p=structuredClone(old);change(p);assert.equal(capacityExpansionCompatible(p,current),false);}
  assert.equal(capacityExpansionCompatible(null as unknown as TradePolicy,current),false);
  const missing=structuredClone(old);delete (missing.paper as Partial<TradePolicy['paper']>).maxOpenPositions;
  assert.equal(capacityExpansionCompatible(reidentify(missing),current),false);
});
