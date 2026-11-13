import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PinePool} from '../pine/pool.ts';
import {extractEvents} from './extractor.ts';
import {DEFAULT_CONFIG,validateConfig,type ScannerConfig} from '../config.ts';
import {exitConfigFor} from '../paper/logic.ts';
import {scannerExitPolicy} from '../paper/policy.ts';
const root=new URL('../../../',import.meta.url);
const specs=JSON.parse(fs.readFileSync(new URL('scripts/specs.json',root),'utf8'));
const sources=[
 ['structure-anchored-vwap-upstream-2-0','E31jKiTS-Structure-Anchored-VWAP-WillyAlgoTrader-v2.0.pine'],
 ['synapse-trail-pro-author-native','RjkDXQnZ-Synapse-Trail-Pro-WillyAlgoTrader.pine'],
 ['liquidity-trail-matrix-author-native','cdnBBG0A-Liquidity-Trail-Matrix-WillyAlgoTrader.pine']
];
const bars=Array.from({length:700},(_,i)=>{
 const c=100+12*Math.sin(i/20)+4*Math.sin(i/6),o=100+12*Math.sin((i-1)/20)+4*Math.sin((i-1)/6);
 return {time:1700000000000+i*900000,open:o,high:Math.max(o,c)+.5,low:Math.min(o,c)-.5,close:c,volume:1000+700*Math.sin(i/13)**2};
});
test('actual author sources compile and their configured lifecycle output is understood', {timeout:60000},async t=>{
 const pool=new PinePool(1,20000);t.after(()=>pool.stop());
 for(const [id,file] of sources){
  const r=await pool.run({scannerId:id,source:fs.readFileSync(new URL('scripts/pine/'+file,root),'utf8'),symbol:'BTCUSD',tf:'15m',tickSize:.01,bars,tailBars:'all',plotTail:0,inputs:specs[id].inputs});
  assert.equal(r.ok,true,`${id}: ${r.error}`);
  const events=extractEvents(r.alerts,r.shapes,{scannerId:id,...specs[id]});
  assert.ok(events.some(e=>e.kind==='entry'),`${id}: no entry read`);
  assert.ok(events.some(e=>e.kind==='exit'&&e.exitType!=='stop_update'),`${id}: no exit read`);
  assert.ok(!events.some(e=>e.label.startsWith('Unsupported author schema')||e.label.includes('invalid native geometry')),id);
  for(const e of events.filter(e=>e.kind==='entry')){
   assert.ok(e.sl&&e.price&&e.tp.length===3,id);
   assert.ok(e.side==='long'?e.sl!<e.price!:e.sl!>e.price!,id);
  }
  if(id==='synapse-trail-pro-author-native'){
   assert.equal(extractEvents(r.alerts,[],{scannerId:'synapse-trail-pro',reader:1}).filter(e=>e.kind==='entry').length,0,'control cannot read the batched schema');
   assert.ok(events.some(e=>e.exitType==='stop_update'),'configured TP/BE alerts must be enabled');
  }
  if(id==='liquidity-trail-matrix-author-native')assert.ok(events.some(e=>e.exitType==='stop_update'));
 }
});
test('native profiles remain disabled, use native geometry and cannot inherit unrelated exit rules',()=>{
 const c=structuredClone(DEFAULT_CONFIG);c.paper.marginPerTrade=150;
 c.paper.trendExit={enabled:true,emaLen:30,minR:.1};c.paper.structureTrail={enabled:true,pivot:3,incrPct:1,books:['account','shadow']};
 c.paper.breakEvenAfterTp1=true;c.paper.floorAtR=.3;c.paper.trailAfterR=.5;c.paper.staleBars=10;
 const risk=JSON.stringify(c.risk),paper=JSON.stringify(c.paper);
 for(const [id] of sources){
  c.scanners[id]={symbols:null,timeframes:null,...specs[id]} as ScannerConfig;
  assert.equal(c.scanners[id].enabled,false);assert.equal(c.scanners[id].entryProtection,'native');
  assert.equal(c.scanners[id].inputs?.alertTpHitInput,true);
  const resolved=exitConfigFor(c.paper,'BTCUSD',scannerExitPolicy(c,id),'15m');
  assert.equal(resolved.scriptTargets,'use');assert.equal(resolved.breakEvenAfterTp1,false);
  assert.equal(resolved.trendExit?.enabled,false);assert.equal(resolved.structureTrail?.enabled,false);
  assert.equal(resolved.floorAtR,0);assert.equal(resolved.trailAfterR,0);assert.equal(resolved.staleBars,0);
  assert.equal(resolved.earlyCut?.minutes,0);assert.equal(resolved.earlyStall?.minutes,0);
  assert.deepEqual(resolved.tpSplit,id.startsWith('synapse')?[1/3,1/3,1/3]:[0,0,1]);
 }
 assert.deepEqual(validateConfig(c),[]);
 assert.equal(JSON.stringify(c.risk),risk);assert.equal(JSON.stringify(c.paper),paper);
});
