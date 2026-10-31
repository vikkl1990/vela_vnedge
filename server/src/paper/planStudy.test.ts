import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adaptPlan,planPrefixDifference} from './planStudy.ts';
import type {ScanEvent} from '../scanners/extractor.ts';
const bars=Array.from({length:40},(_,i)=>({time:i*60000,open:100,high:102,low:98,close:100,volume:1}));
const event={kind:'entry',barTime:20*60000,side:'long',price:100,sl:95,tp:[110,120],label:'entry',source:'alert',message:''} as ScanEvent;
test('ATR adaptation replaces both native stop and targets without mutating the source',()=>{
 const [a]=adaptPlan([event],bars,'atr');assert.equal(a.sl,undefined);assert.deepEqual(a.tp,[]);assert.equal(event.sl,95);assert.deepEqual(event.tp,[110,120]);
});
test('structure uses only closed trailing bars and gives long/short stops on the correct side',()=>{
 const first=adaptPlan([event],bars,'structure')[0];
 const future=bars.map((b,i)=>i>20?{...b,low:1,high:1000}:b);
 assert.equal(adaptPlan([event],future,'structure')[0].sl,first.sl);assert.ok(first.sl!<100);
 const short=adaptPlan([{...event,side:'short'}],future,'structure')[0];assert.ok(short.sl!>100);assert.deepEqual(short.tp,[]);
});
test('prefix honesty detects changed stops even when entry direction and time stay unchanged',()=>{
 assert.deepEqual(planPrefixDifference([event],[{...event,sl:96}],30*60000),{entries:1,changed:2});
 assert.deepEqual(planPrefixDifference([event],[event],30*60000),{entries:1,changed:0});
});
