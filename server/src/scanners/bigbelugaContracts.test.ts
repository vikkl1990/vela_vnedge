import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {extractEvents} from './extractor.ts';
import {strategyIdentity} from './identity.ts';
import {DEFAULT_CONFIG,type ScannerConfig} from '../config.ts';
const root=new URL('../../../',import.meta.url);
const specs=JSON.parse(fs.readFileSync(new URL('scripts/specs.json',root),'utf8'));
const ids=['high-volume-pivot-support-resistance-zones','dynamic-trend-bands-anchored-vwap-signals','triangular-hull-moving-average-volatility'];
test('BigBeluga source-direction contracts correct flipped breakout guesses and missing shorts, without activating them',()=>{
 const cfg=structuredClone(DEFAULT_CONFIG);
 for(const id of ids){
  const variant=id+'-author-signals',s=specs[variant];assert.equal(s.enabled,false);assert.equal(s.exitMode,'levels');
  cfg.scanners[id]={enabled:false,symbols:null,timeframes:null,exitMode:'both',...specs[id]};
  cfg.scanners[variant]={symbols:null,timeframes:null,...s} as ScannerConfig;
  assert.notEqual(strategyIdentity('same source',cfg,id),strategyIdentity('same source',cfg,variant));
  for(const [title,side] of Object.entries(s.sides)){
   const shape={title,times:[900000]};const e=extractEvents([], [shape,shape],{scannerId:variant,...s});
   assert.equal(e.length,1,`${id}/${title}: duplicate chart marker`);assert.equal(e[0].kind,'entry');assert.equal(e[0].side,side);
   assert.equal(e[0].barTime,900000,'observation time, not the previous-bar drawing offset');
  }
  assert.deepEqual(extractEvents([],[{title:'Bullish Context',times:[900000]}],{scannerId:variant,...s}),[]);
 }
 const shape={title:'Resistance Breakout',times:[900000]};
 assert.equal(extractEvents([],[shape],{scannerId:ids[0],...specs[ids[0]]})[0]?.side,'short','control remains unchanged');
});
test('BigBeluga deliberate account allow-lists are preserved',()=>{
 const samples=[['pivot-channel-breaks','Break Dn'],['kinetic-momentum-vectors','Bear Spike'],['session-killzones-breakouts','Asia Bear Breakout']];
 for(const [id,title] of samples)assert.deepEqual(extractEvents([],[{title,times:[900000]}],{scannerId:id,...specs[id]}),[]);
});
