import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {SCRIPTS_DIR} from '../config.ts';
import {readingOf} from './reading.ts';
import {extractEvents} from './extractor.ts';
import {reviewedStatus} from './registry.ts';
const specs=JSON.parse(fs.readFileSync(`${SCRIPTS_DIR}/specs.json`,'utf8'));
const manifest=JSON.parse(fs.readFileSync(`${SCRIPTS_DIR}/manifest.json`,'utf8'));
const audit=JSON.parse(fs.readFileSync(`${SCRIPTS_DIR}/family-update-2026-10-30.json`,'utf8'));
const alert=(title:string,message=title,time=1)=>({title,message,time,barIndex:time,type:'alertcondition' as const});
test('upstream imports have separate evidence identities, pinned sources and disabled account defaults',()=>{
 for(const a of audit){
  const row=manifest.find((m:any)=>m.id===a.id);
  assert.equal(createHash('sha256').update(fs.readFileSync(`${SCRIPTS_DIR}/pine/${row.file}`)).digest('hex'),a.sha256);
  assert.equal(specs[a.id].enabled,false);
  if(a.previousId){assert.notEqual(a.id,a.previousId);assert.ok(manifest.some((m:any)=>m.id===a.previousId));}
 }
});
test('confirmed buy/sell contracts exclude grade duplicates, drawings and volume labels',()=>{
 for(const id of ['precision-sniper-upstream-6-0','anchored-orderflow-vwap-signals']){
  const read=readingOf(specs[id],id,900000);
  const events=extractEvents([alert('Buy Signal'),alert('Sell Signal','Sell Signal',2),alert('Buy A+ only','BUY A+',3),alert('Any Signal','BUY',4)], [{title:'Buy Signal',times:[1,5]}],{...read.extract,drawn:[{text:'BUY VOLUME',time:6,y:100,style:'style_label_up'}]});
  assert.deepEqual(events.filter(e=>e.kind==='entry').map(e=>[e.side,e.barTime]),[['long',1],['short',2]]);
 }
});
test('range breakout contract excludes range states, retests and VWAP context',()=>{
 const id='vwap-range-breakout',prefix='Zeiierman VWAP Range | ';
 const events=extractEvents([
  alert(prefix+'Breakout Up','confirmed bullish breakout',1),alert(prefix+'Breakout Down','confirmed bearish breakout',2),
  alert(prefix+'Bullish Range','bullish',3),alert(prefix+'Bearish Retest','bearish',4),alert(prefix+'Smart Trend Bullish','bullish',5),
 ],[],readingOf(specs[id],id,900000).extract);
 assert.deepEqual(events.filter(e=>e.kind==='entry').map(e=>[e.side,e.barTime]),[['long',1],['short',2]]);
});
test('trend profile entries come from current-bar flips rather than back-anchored labels',()=>{
 const id='trend-volume-profile-and-rolling-poc';
 const events=extractEvents([], [{title:'Bullish Trend Change',times:[10]},{title:'Bearish Trend Change',times:[20]}],{...readingOf(specs[id],id,900000).extract,drawn:[{text:'BULL',time:1,y:100,style:'style_label_up'}]});
 assert.deepEqual(events.filter(e=>e.kind==='entry').map(e=>[e.side,e.barTime]),[['long',10],['short',20]]);
});
test('context-only imports cannot become entries or lose their correctness hold after a runtime pass',()=>{
 for(const a of audit.filter((a:any)=>a.contextOnly)){
  const row=manifest.find((m:any)=>m.id===a.id);
  assert.equal(reviewedStatus(row,{ok:true}).status,'incompatible');
  const ev=extractEvents([alert('Buy')],[{title:'Bullish',times:[1]}],{...readingOf(specs[a.id],a.id,900000).extract,drawn:[{text:'BUY VOLUME',time:1,y:100,style:'style_label_up'}]});
  assert.equal(ev.filter(e=>e.kind==='entry').length,0);
 }
});
