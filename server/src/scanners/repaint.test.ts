import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareEventPlans,compareRepaint,REPAINT_MAX_SHARE} from './repaint.ts';
import type {ScanEvent} from './extractor.ts';
const entry=(i:number):ScanEvent=>({kind:'entry',side:'long',barTime:(i+1)*60000,barIndex:i,price:100,sl:99,tp:[101,102],label:'long',message:'',source:'alert'});
const entries=Array.from({length:10},(_,i)=>entry(i));
test('full-plan prefix check detects price, SL and TP changes with stable arrows',()=>{
 for(const patch of [{price:101},{sl:95},{tp:[102,104]},{score:80}]){
  const result=compareEventPlans(entries,entries.map(e=>({...e,...patch})));
  assert.equal(result.timingChanged,0);assert.ok(result.planChanged>0);assert.equal(result.repaints,true);
 }
});
test('exit creation, disappearance and changed exit level cannot hide behind stable entries',()=>{
 const exit:ScanEvent={...entry(10),kind:'exit',exitType:'sl',price:99};
 for(const changed of [[],[{...exit,price:95}],[{...exit,exitType:'tp1' as const}]]){
  const result=compareEventPlans([...entries,exit],[...entries,...changed]);assert.equal(result.repaints,true);assert.ok(result.exitChanged>0);
 }
});
test('unchanged plans pass and short records remain explicitly insufficient at unchanged thresholds',()=>{
 assert.equal(REPAINT_MAX_SHARE,.10);assert.equal(compareEventPlans(entries,entries).repaints,false);
 const short=compareEventPlans(entries.slice(0,4),[]);assert.equal(short.coverage,'insufficient');assert.equal(short.repaints,false);
});
test('additional stable exit events cannot dilute a previously detected entry-timing change',()=>{
 const exits=Array.from({length:100},(_,i)=>({...entry(i+10),kind:'exit' as const,exitType:'sl' as const}));
 const changed=[...entries.slice(0,8),...entries.slice(8).map(e=>({...e,barTime:e.barTime+1}))];
 assert.equal(compareEventPlans([...entries,...exits],[...changed,...exits]).repaints,true);
});
test('parser integration ignores future bars but compares the earlier complete plans',()=>{
 const bars=Array.from({length:12},(_,i)=>({time:(i+1)*60000,open:100,high:102,low:98,close:100,volume:100}));
 const result=(sl:number)=>({id:1,ok:true,ms:1,bars:12,lastBarTime:bars.at(-1)!.time,warnings:0,shapes:[],labels:[],plots:[],alerts:bars.map((b,i)=>({time:b.time,barIndex:i,type:'alert' as const,message:`LONG | Price: 100 | SL: ${sl} | TP1: 102`}))});
 assert.equal(compareRepaint(result(99),bars,result(95),bars.slice(0,6),'audit',{sources:['alert']}).repaints,true);
 const same=compareRepaint(result(99),bars,{...result(99),alerts:result(99).alerts.slice(0,6)},bars.slice(0,6),'audit',{sources:['alert']});
 assert.equal(same.repaints,false);assert.equal(same.prefix,6);
 assert.equal(compareRepaint(result(99),bars,result(99),[],'audit',{}).coverage,'insufficient');
});
