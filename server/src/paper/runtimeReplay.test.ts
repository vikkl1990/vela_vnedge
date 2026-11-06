import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_CONFIG} from '../config.ts';
import {replayRuntime,type ReplayEvent} from './runtimeReplay.ts';
const T=Date.UTC(2026,10,1);
const manifest={version:1 as const,policyInput:'fixture-v1',dataId:'recorded-tape-v1',sources:{s:'source-v1'},limitations:['Fixture execution replay; no historical depth or signal reconstruction.']};
function config(){const cfg=structuredClone(DEFAULT_CONFIG);cfg.risk.enabled=false;Object.assign(cfg.paper,{initialEquity:1000,
  slippageBps:0,quotedSlippageBps:0,feeRatePct:.05,makerFeeRatePct:.02,feeTaxPct:0,liquidation:false,
  latencyMs:0,fillSource:'tape',useSpread:false,requireQuote:false,minRiskFeeRatio:0,skipScriptStops:false,
  floorAtR:0,trailAfterR:0,trailSteps:[],trailGiveBackPct:0,limitEntry:{enabled:true,books:['account'],tfs:['1h'],atr:.2,bars:2}});return cfg;}
const entry:ReplayEvent={kind:'entry',at:T,sequence:1,event:{kind:'entry',side:'long',price:100,sl:99,tp:[101,102,103],label:'long',message:'',source:'alert',barTime:T-3600000,barIndex:0},
 context:{scannerId:'s',scannerName:'s',symbol:'BTCUSD',tf:'1h',market:{tickSize:.01,contractValue:1},atr:1,refPrice:100,signalId:null,exitMode:'both'}};
test('same runtime inputs reconcile deterministically across a resting-order restart',()=>{
 const events:ReplayEvent[]=[entry,{kind:'restart',at:T+1,sequence:2},{kind:'trade',symbol:'BTCUSD',price:99.7,qty:1000,exchangeAt:T+2,at:T+2,sequence:3},
  {kind:'trade',symbol:'BTCUSD',price:98.8,qty:1000,exchangeAt:T+3,at:T+3,sequence:4}];
 const a=replayRuntime(config(),events,manifest),b=replayRuntime(config(),[...events].reverse(),manifest);
 assert.deepEqual(a,b);assert.equal(a.trades.length,1);assert.equal(a.pending.length,0);assert.equal(a.open.length,0);
 assert.ok(a.trades[0].fees>0);assert.equal(a.finalEquity,1000+a.realized);
 assert.ok(a.trades[0].fills.every(f=>f.at>=a.trades[0].entryAt));
});
test('runtime replay rejects lookahead context and ambiguous ordering',()=>{
 assert.throws(()=>replayRuntime(config(),[entry,entry],manifest),/duplicate/);
 assert.throws(()=>replayRuntime(config(),[{kind:'context',at:T,sequence:1,symbol:'BTCUSD',tf:'1h',bar:{time:T-1,open:100,high:101,low:99,close:100,volume:1}}],manifest),/not closed/);
});
