import {test} from 'node:test';
import assert from 'node:assert/strict';
import {App} from './app.ts';
import {DEFAULT_CONFIG} from './config.ts';

test('saved research plans join the shadow schedule before config refresh completes',async()=>{
 const cfg=structuredClone(DEFAULT_CONFIG),before=structuredClone(cfg),calls:string[]=[],subscriptions:string[][]=[];
 let researchSymbols:string[]=[];
 const book={openPositions:()=>[],pendingEntries:()=>[]};
 const app={config:{get:()=>cfg},candles:{setMaxBars:()=>{}},resolvedSymbols:[],
  resolveUniverse:async()=>{},feed:{subscribe:(_channel:string,symbols:string[])=>subscriptions.push([...symbols])},
  scanners:{refresh:async()=>{calls.push('account');},requiredSeries:()=>[]},paper:book,shadow:book,
  incubator:{sync:async()=>{calls.push('shadow');researchSymbols=['SOLUSD'];},symbols:()=>researchSymbols},
  depthRecorder:{symbols:[]},orderFlow:{symbols:[]},marketGate:{needsRefresh:()=>false}};
 await App.prototype.onConfigChanged.call(app as any);
 assert.deepEqual(calls,['account','shadow']);
 assert.ok(subscriptions.some(s=>s.includes('SOLUSD')),'new shadow market gets the entry-price stream immediately');
 assert.deepEqual(cfg,before,'refresh cannot alter risk, evidence, sizing or execution settings');
});
