import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PinePool} from '../pine/pool.ts';
import {declaredChannels, extractEvents} from './extractor.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {strategyIdentity} from './identity.ts';
import {applyPatches} from '../pine/patches.ts';
import {variantCompatibleSource} from './variantCompat.ts';

const root=new URL('../../../',import.meta.url);
const specs=JSON.parse(fs.readFileSync(new URL('scripts/specs.json',root),'utf8'));
const samples=[
 ['high-volume-pivot-support-resistance-zones-author-signals','AFbHxgBM-High-Volume-Pivot-Support-Resistance-Zones-BigBeluga.pine'],
 ['dynamic-trend-bands-anchored-vwap-signals-author-signals','pYlVdSoZ-Dynamic-Trend-Bands-Anchored-VWAP-Signals-BigBeluga.pine'],
 ['triangular-hull-moving-average-volatility-author-signals','jequ7L0t-Triangular-Hull-Moving-Average-Volatility-BigBeluga.pine'],
 ['liquidity-void-detector-zeiierman-author-direction','q1hXS0v6-Liquidity-Void-Detector-Zeiierman.pine'],
 ['false-breakout-expo-author-signals','vz0bVIJo-False-Breakout-Expo.pine'],
 ['adaptive-smart-money-liquidity-sweep-levels-author-signals','GjZ8YU0x-Adaptive-Smart-Money-Liquidity-Sweep-Levels-AlgoAlpha.pine'],
 ['zero-lag-ma-trend-levels-author-retests','pP2FhzAX-Zero-Lag-MA-Trend-Levels-ChartPrime.pine'],
 ['swing-failure-zones-and-signals-author-signals','tdAuf5tG-Swing-Failure-Zones-and-Signals-AlgoAlpha.pine'],
 ['zone-shift-author-retests','8lfE3qMN-Zone-Shift-ChartPrime.pine'],
 ['breaker-blocks-with-signals-author-retests','1owp3WD0-Breaker-Blocks-with-Signals-LuxAlgo.pine'],
];
let seed=7649;
const noise=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const noisyCloses=Array.from({length:1001},(_,i)=>100+12*Math.sin(i/20)+4*Math.sin(i/6)+5*(noise()-.5));
const rejectionBars=noisyCloses.slice(1).map((close,i)=>({time:1700000100000+i*900000,open:noisyCloses[i],high:Math.max(close,noisyCloses[i])+2*noise(),low:Math.min(close,noisyCloses[i])-2*noise(),close,volume:200+2400*noise()}));
const bars=Array.from({length:1000},(_,i)=>{
 const close=100+12*Math.sin(i/20)+4*Math.sin(i/6)+3*Math.sin(i/99),open=100+12*Math.sin((i-1)/20)+4*Math.sin((i-1)/6)+3*Math.sin((i-1)/99);
 return {time:1700000100000+i*900000,open,high:Math.max(open,close)+.5,low:Math.min(open,close)-.5,close,volume:200+2400*Math.sin(i/13)**2};
});

test('reviewed source markers survive actual Pine execution with exact contracts and causal observation times',{timeout:60000},async t=>{
 const pool=new PinePool(1,20000);t.after(()=>pool.stop());
 for(const [id,file] of samples){
  const s=specs[id];
  const source=applyPatches(variantCompatibleSource(id,fs.readFileSync(new URL('scripts/pine/'+file,root),'utf8')).source,file).source;
  const r=await pool.run({scannerId:id,source,symbol:'ETHUSD',tf:'15m',tickSize:.01,bars:['false-breakout-expo-author-signals','zero-lag-ma-trend-levels-author-retests','swing-failure-zones-and-signals-author-signals','zone-shift-author-retests','breaker-blocks-with-signals-author-retests'].includes(id)?rejectionBars:bars,tailBars:'all',plotTail:0,inputs:s.inputs});
  assert.equal(r.ok,true,`${id}: ${r.error}`);
  const events=extractEvents(r.alerts,r.shapes,{scannerId:id,...s,drawn:r.labels,declared:declaredChannels(source)}).filter(e=>e.kind!=='info');
  assert.ok(events.length>0,`${id}: source fixture must exercise signals`);
  assert.ok(events.some(e=>e.side==='long'),`${id}: long path`);
  assert.ok(events.some(e=>e.side==='short'),`${id}: short path`);
  assert.equal(new Set(events.map(e=>`${e.barTime}:${e.kind}:${e.side}`)).size,events.length,`${id}: duplicate rendered markers`);
  for(const e of events){
   assert.equal(e.kind,'entry');
   const drawn=e.source==='label'?r.labels.find(x=>x.text===e.label&&x.createdAt===e.barTime):undefined;
   assert.equal(s.sides?.[e.label]??s.labelStyles?.[e.label]?.[drawn?.style??''],e.side,`${id}: declared source meaning`);
   // A chart offset is a drawing hint. It must not move observation to a prior bar.
   const raw=e.source==='label'?r.labels.find(x=>x.text===e.label&&x.createdAt===e.barTime):
    e.source==='shape'?r.shapes.find(x=>x.title===e.label&&x.times.includes(e.barTime)):
    r.alerts.find(x=>x.type==='alertcondition'&&x.time===e.barTime&&x.title?.trim()===e.label);
   assert.ok(raw,`${id}: no same-bar raw event for ${e.label}`);
  }
 }
});

test('author rejection variants keep their legacy controls and exclude context alerts',()=>{
 for(const [base,id,titles] of [
  ['false-breakout-expo','false-breakout-expo-author-signals',['False Breakout Up','False Breakout Down']],
  ['adaptive-smart-money-liquidity-sweep-levels','adaptive-smart-money-liquidity-sweep-levels-author-signals',['Upper Liquidity Wick Sweep','Lower Liquidity Wick Sweep']],
 ] as const){
  const cfg=structuredClone(DEFAULT_CONFIG);cfg.scanners[id]={symbols:null,timeframes:null,...specs[id]};
  assert.equal(cfg.scanners[id].enabled,false);
  assert.notEqual(strategyIdentity('same source',cfg,base),strategyIdentity('same source',cfg,id));
  titles.forEach((title,i)=>{
   const alerts=[{type:'alertcondition' as const,title,message:title,time:900000,barIndex:10}];
   assert.equal(extractEvents(alerts,[],{scannerId:base})[0]?.side,i?'short':'long');
   assert.equal(extractEvents(alerts,[],{scannerId:id,...specs[id]})[0]?.side,i?'long':'short');
  });
 }
 const id='adaptive-smart-money-liquidity-sweep-levels-author-signals';
 const alerts=['Upper Liquidity Detected','Lower Liquidity Detected','Upper Level Removed','Lower Level Removed','Shorts Liquidated','Longs Liquidated','Near Range Liquidity Balance: Bear Dominant','Near Range Liquidity Balance: Bull Dominant','Any Liquidity Wick Sweep']
  .map((title,i)=>({type:'alertcondition' as const,title,message:title,time:900000+i*900000,barIndex:10+i}));
 assert.equal(extractEvents(alerts,[],{scannerId:id,...specs[id]}).length,0);
 // Consecutive confirmed sweeps are separate events; they are not a persistent trend state.
 const sweeps=[10,11].map(i=>({type:'alertcondition' as const,title:'Upper Liquidity Wick Sweep',message:'',time:i*900000,barIndex:i}));
 assert.equal(extractEvents(sweeps,[],{scannerId:id,...specs[id]}).length,2);
});

test('confirmed retests use label creation, do not backdate fills, and do not trade unnamed diamonds',()=>{
 const id='zero-lag-ma-trend-levels-author-retests';
 const opts={scannerId:id,...specs[id],declared:new Set(['shape'] as const),drawn:[
  {text:'▲',time:900000,y:100,createdAt:1800000,style:'label_up'},
  {text:'▼',time:1800000,y:100,createdAt:2700000,style:'label_down'},
  {text:'▲',time:2700000,y:100,style:'label_up'}, // unknown creation cannot be made causal
 ]};
 const events=extractEvents([],[],opts);
 assert.deepEqual(events.map(e=>[e.side,e.barTime]),[['long',1800000],['short',2700000]]);
 assert.deepEqual(extractEvents([],[],{...opts,sinceBarTime:2700000}).map(e=>e.side),['short']);
 assert.equal(extractEvents([],[],{...opts,sinceBarTime:3600000}).length,0);
 assert.equal(extractEvents([], [{title:'',shape:'diamond',location:'absolute',times:[1800000]}],{...opts,drawn:[]}).length,0);
});

test('zone mitigation with a reused Swing Failure alert title cannot create an authored reversal entry',()=>{
 const id='swing-failure-zones-and-signals-author-signals',opts={scannerId:id,...specs[id]};
 const alerts=['Bullish Swing Failure','Bearish Swing Failure'].map((title,i)=>({type:'alertcondition' as const,title,message:title,time:(i+1)*900000,barIndex:i+1}));
 assert.equal(extractEvents(alerts,[],opts).length,0);
 const shapes=[{title:'Bullish Signal',times:[900000]},{title:'Bearish Signal',times:[1800000]}];
 assert.deepEqual(extractEvents(alerts,shapes,opts).map(e=>[e.source,e.side]),[['shape','long'],['shape','short']]);
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.scanners[id]={symbols:null,timeframes:null,...specs[id]};
 assert.equal(cfg.scanners[id].enabled,false);
 assert.notEqual(strategyIdentity('same source',cfg,'swing-failure-zones-and-signals'),strategyIdentity('same source',cfg,id));
});

test('void refill direction is separately versioned, disabled, and leaves legacy interpretation unchanged',()=>{
 const id='liquidity-void-detector-zeiierman',variant=id+'-author-direction',cfg=structuredClone(DEFAULT_CONFIG);
 cfg.scanners[id]={enabled:false,symbols:null,timeframes:null,exitMode:'both'};
 cfg.scanners[variant]={symbols:null,timeframes:null,...specs[variant]};
 assert.equal(cfg.scanners[variant].enabled,false);
 assert.notEqual(strategyIdentity('same source',cfg,id),strategyIdentity('same source',cfg,variant));
 for(const [title,side,old] of [['Buy-Side Imbalance','short','long'],['Sell-Side Imbalance','long','short']]){
  const alerts=[{type:'alertcondition' as const,title,message:title,time:900000,barIndex:10}];
  assert.equal(extractEvents(alerts,[],{scannerId:id})[0]?.side,old);
  assert.equal(extractEvents(alerts,[],{scannerId:variant,...specs[variant]})[0]?.side,side);
 }
});

test('breaker block formation, resets and swing breaks are not retest entries',()=>{
 const id='breaker-blocks-with-signals-author-retests',opts={scannerId:id,...specs[id]};
 const context=['1. +BB','1. -BB','+BB (R)','-BB (R)','3. TP UP 1','3. TP DN 1','4. cancel UP','4. cancel DN','5. +BB Mitigated','5. -BB Mitigated','6. LL 1 Break','6. HH 1 Break','7. Swing UP 1 Break','7. Swing DN 1 Break'];
 const alerts=context.map((title,i)=>({type:'alertcondition' as const,title,message:title,time:(i+1)*900000,barIndex:i+1}));
 assert.equal(extractEvents(alerts,[],opts).filter(e=>e.kind==='entry').length,0);
 const retests=[' 2. signal UP','2. signal DN'].map((title,i)=>({type:'alertcondition' as const,title,message:title,time:(i+30)*900000,barIndex:i+30}));
 assert.deepEqual(extractEvents(retests,[],opts).filter(e=>e.kind==='entry').map(e=>e.side),['long','short']);
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.scanners[id]={symbols:null,timeframes:null,...specs[id]};
 assert.equal(cfg.scanners[id].enabled,false);
 assert.notEqual(strategyIdentity('same source',cfg,'breaker-blocks-with-signals'),strategyIdentity('same source',cfg,id));
});
