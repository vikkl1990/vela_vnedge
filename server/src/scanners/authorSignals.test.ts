import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PinePool} from '../pine/pool.ts';
import {extractEvents} from './extractor.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {strategyIdentity} from './identity.ts';
import {applyPatches} from '../pine/patches.ts';

const root=new URL('../../../',import.meta.url);
const specs=JSON.parse(fs.readFileSync(new URL('scripts/specs.json',root),'utf8'));
const samples=[
 ['high-volume-pivot-support-resistance-zones-author-signals','AFbHxgBM-High-Volume-Pivot-Support-Resistance-Zones-BigBeluga.pine'],
 ['dynamic-trend-bands-anchored-vwap-signals-author-signals','pYlVdSoZ-Dynamic-Trend-Bands-Anchored-VWAP-Signals-BigBeluga.pine'],
 ['triangular-hull-moving-average-volatility-author-signals','jequ7L0t-Triangular-Hull-Moving-Average-Volatility-BigBeluga.pine'],
 ['liquidity-void-detector-zeiierman-author-direction','q1hXS0v6-Liquidity-Void-Detector-Zeiierman.pine'],
];
const bars=Array.from({length:1000},(_,i)=>{
 const close=100+12*Math.sin(i/20)+4*Math.sin(i/6)+3*Math.sin(i/99),open=100+12*Math.sin((i-1)/20)+4*Math.sin((i-1)/6)+3*Math.sin((i-1)/99);
 return {time:1700000100000+i*900000,open,high:Math.max(open,close)+.5,low:Math.min(open,close)-.5,close,volume:200+2400*Math.sin(i/13)**2};
});

test('reviewed source markers survive actual Pine execution with exact contracts and causal observation times',{timeout:60000},async t=>{
 const pool=new PinePool(1,20000);t.after(()=>pool.stop());
 for(const [id,file] of samples){
  const s=specs[id];
  const source=applyPatches(fs.readFileSync(new URL('scripts/pine/'+file,root),'utf8'),file).source;
  const r=await pool.run({scannerId:id,source,symbol:'ETHUSD',tf:'15m',tickSize:.01,bars,tailBars:'all',plotTail:0,inputs:s.inputs});
  assert.equal(r.ok,true,`${id}: ${r.error}`);
  const events=extractEvents(r.alerts,r.shapes,{scannerId:id,...s});
  assert.ok(events.length>0,`${id}: source fixture must exercise signals`);
  assert.ok(events.some(e=>e.side==='long'),`${id}: long path`);
  assert.ok(events.some(e=>e.side==='short'),`${id}: short path`);
  assert.equal(new Set(events.map(e=>`${e.barTime}:${e.kind}:${e.side}`)).size,events.length,`${id}: duplicate rendered markers`);
  for(const e of events){
   assert.equal(e.kind,'entry');
   assert.equal(s.sides[e.label],e.side,`${id}: declared source meaning`);
   // A chart offset is a drawing hint. It must not move observation to a prior bar.
   const raw=e.source==='shape'?r.shapes.find(x=>x.title===e.label&&x.times.includes(e.barTime)):
    r.alerts.find(x=>x.type==='alertcondition'&&x.time===e.barTime&&x.title===e.label);
   assert.ok(raw,`${id}: no same-bar raw event for ${e.label}`);
  }
 }
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
