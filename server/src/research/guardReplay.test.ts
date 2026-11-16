import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_CONFIG} from '../config.ts';
import {resolveTradePolicy} from '../paper/tradePolicy.ts';
import {guardKind,replayGuardSample,type GuardObservation,type Minute} from './guardReplay.ts';
const T=1800000000000,M=60000;
function fixture(){
 const c=structuredClone(DEFAULT_CONFIG);c.scanners.s={enabled:true,symbols:['ETHUSD'],timeframes:['15m'],exitMode:'both'};
 Object.assign(c.paper,{sizingMode:'margin',marginPerTrade:150,maxStopLossPct:3,initialEquity:1000,latencyMs:1500,
  minRiskFeeRatio:0,minSizeShare:0,liquidation:false,slippageBps:0,depthUsdPerBp:0,feeRatePct:.05,feeTaxPct:18,
  limitEntry:undefined,makerQuoteCells:undefined,makerTapeCells:undefined,reclaimTrials:undefined,
  trailAfterR:0,floorAtR:0,trailAtrMult:0,scriptTargets:'use',scalperOffer:undefined});
 c.paper.marginLeverage={base:5,strong:5,weak:5,minTrades:20,lookback:30,strongAboveR:.1,weakBelowR:-.1};
 const policy=resolveTradePolicy(c,{scannerId:'s',symbol:'ETHUSD',tf:'15m'},'source',0);
 const x:GuardObservation={id:1,at:T+1000,sc:'s',sym:'ETHUSD',tf:'15m',side:'long',action:'rejected:risk re-entry cooldown: wait 60',
  policy,snapshot:{policyId:policy.id,signalAt:T+1000,atr:4,market:{tickSize:.01,contractValue:1},event:
   {kind:'entry',side:'long',sl:94,tp:[120],price:100,label:'Long',message:'Long',source:'alert',barTime:T-900000,barIndex:20}}};
 return x;
}
const bars=(prices:number[]):Minute[]=>prices.map((p,i)=>[T+(i+1)*M,p,p,p,p]);
test('guard replay caps dollar risk by quantity, never stop distance; gap exit uses observed price and actual notional fees',()=>{
 const r=replayGuardSample(fixture(),bars([100,90]),T+2*M,1000);
 assert.equal(r.status,'sampled-closed');
 if(r.status!=='sampled-closed')throw Error('missing close');
 assert.equal(r.sl,94);assert.equal(r.qty,4);assert.ok(r.riskAmount<=30);
 assert.ok(r.net < -40,'gap through stop pays observed price plus fees');
 assert.equal(r.fees,4*(100+90)*.0005*1.18);
 assert.equal(r.policyChangeEligible,false);assert.equal(r.promotionEligible,false);
});
test('unfinished, missing and horizon-open paths are never synthetic closed trades',()=>{
 const x=fixture();
 assert.equal(replayGuardSample(x,bars([100,101]),T+2*M,1000).status,'censored');
 const h=replayGuardSample(x,bars([100,101]),T+2*M,1000,M);
 assert.equal(h.status,'horizon-open');assert.equal(h.net,null);
 const gap=replayGuardSample(x,[...bars([100]),[T+3*M,90,90,90,90]],T+3*M,1000);
 assert.equal(gap.status,'unverified');assert.equal(gap.net,null);
});
test('resting orders, absent historical policy and missing entry samples fail closed',()=>{
 const x=fixture();assert.equal(replayGuardSample({...x,policy:null},bars([100,90]),T+2*M,1000).status,'unverified');
 x.policy!.paper.limitEntry={enabled:true,tfs:['15m'],books:['account'],atr:0,bars:2};
 const maker=replayGuardSample(x,bars([100,90]),T+2*M,1000);
 assert.equal(maker.status,'unverified');assert.match(maker.reason!,/never converted/);
 assert.equal(replayGuardSample(fixture(),bars([100,90]).slice(1),T+2*M,1000).status,'unverified');
});
test('the explicit as-of cutoff cannot use later samples and refusal categories retain the actual reason',()=>{
 const x=fixture(),r=replayGuardSample(x,bars([100,90]),T+M,1000);
 assert.equal(r.status,'censored');assert.equal(r.net,null);
 assert.equal(guardKind('rejected:risk regime: choppy (efficiency 0.01 < 0.1)'),'regime-efficiency');
 assert.equal(guardKind('rejected:risk regime: ATR below floor'),'regime-other');
 assert.equal(guardKind(x.action),'cooldown');
 assert.equal(replayGuardSample(x,[bars([100])[0],bars([100])[0]],T+M,1000).status,'unverified');
});
test('execution latency starts at saved admission time, not the earlier journal insert',()=>{
 const x=fixture();x.snapshot!.signalAt=T+59900;
 const r=replayGuardSample(x,bars([100,95,90]),T+3*M,1000);
 assert.equal(r.status,'sampled-closed');
 if(r.status==='sampled-closed')assert.equal(r.entryAt,T+2*M);
});
