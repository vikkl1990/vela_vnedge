import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_CONFIG} from '../config.ts';
import {capitalPlan} from './capitalPlan.ts';
const cfg={...DEFAULT_CONFIG.paper,sizingMode:'margin' as const,marginPerTrade:150,maxStopLossPct:3,maxLeverage:100,minSizeShare:0,feeRatePct:.05,makerFeeRatePct:.02,feeTaxPct:18,slippageBps:2,liquidation:true};
const s={equity:1000,availableMargin:1000,contractValue:.001,tickSize:.01,maintenanceMarginPct:.5,maxLeverage:100,cfg};
const pref={preferredMargin:50,minLeverage:5,maxLeverage:100,targetRiskPct:1,remainingRiskUsd:30};
test('preferred $50 margin is funding, not a $5,000 automatic 100x order',()=>{
 const p=capitalPlan(10000,9900,s,pref);
 assert.ok(p.qty>0);assert.ok(p.riskAmount<=10+1e-8);assert.ok(p.margin<=50.01);assert.ok(p.marginLeverage<100);
 assert.ok(p.notional<1000);
});
test('wide stops need lower leverage; product limits and costs remain binding',()=>{
 const p=capitalPlan(10000,8500,{...s,maxLeverage:10},{...pref,targetRiskPct:3});
 assert.ok(p.marginLeverage<=1/(.15*1.25+.005)+1e-8);assert.ok(p.riskAmount<=30);assert.ok(p.qty>0);
 const limited=capitalPlan(10000,9900,{...s,maxLeverage:7},pref);assert.ok(limited.marginLeverage<=7);
});
test('held and pending risk/margin budgets constrain every proposed allocation',()=>{
 const p=capitalPlan(10000,9900,{...s,availableMargin:12},{...pref,remainingRiskUsd:2});
 assert.ok(p.margin+p.entryFeeReserve<=12+1e-8);assert.ok(p.riskAmount<=2);
 assert.equal(capitalPlan(10000,9900,s,{...pref,remainingRiskUsd:0}).qty,0);
 assert.equal(capitalPlan(10000,9900,{...s,availableMargin:NaN},pref).qty,0);
 assert.equal(capitalPlan(10000,9900,s,{...pref,maxLeverage:Infinity}).qty,0);
});
test('planning cannot relax account ceilings or mutate the existing configuration',()=>{
 const original=JSON.stringify(s);const p=capitalPlan(10000,9900,{...s,cfg:{...cfg,maxLeverage:5,maxStopLossPct:.5}},{...pref,targetRiskPct:50});
 assert.ok(p.marginLeverage<=5);assert.ok(p.riskAmount<=5);assert.equal(JSON.stringify(s),original);
});
test('reported reservations include nonlinear entry impact and its taxed commission',()=>{
 const input={...s,availableMargin:8,cfg:{...cfg,depthUsdPerBp:1}};
 const p=capitalPlan(10000,9900,input,pref);
 assert.ok(p.qty>0);assert.ok(p.notional>p.qty*10000*s.contractValue);
 assert.ok(p.margin+p.entryFeeReserve<=8);assert.ok(p.riskAmount<=10);
});
