import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractEvents,describeEvent} from './extractor.ts';
import {WILLY_CONTRACTS} from './willyContracts.ts';
import {DEFAULT_CONFIG,validateConfig} from '../config.ts';
import {strategyIdentity} from './identity.ts';
import type {WorkerAlert} from '../pine/worker.ts';

const a=(message:unknown):WorkerAlert=>({type:'alert',time:900000,barIndex:10,message:typeof message==='string'?message:JSON.stringify(message)});
const read=(id:string,message:unknown,reader=3)=>extractEvents([a(message)],[],{scannerId:id,reader,barMs:900000});
const buy={action:'buy',direction:1,entry:100,price:100,sl:99,tp1:101,tp2:102,tp3:103};

test('all 48 author publications have unique roles; context/manual tools cannot create entries from labels, alerts or derived rules',()=>{
 assert.equal(WILLY_CONTRACTS.length,48);assert.equal(new Set(WILLY_CONTRACTS.map(c=>c.publication)).size,48);
 for(const c of WILLY_CONTRACTS.filter(c=>c.role==='Context'||c.role==='Manual / restricted')){
  const events=extractEvents([a('🟢 BUY | Price: 100 | SL: 99 | TP1: 101')],[{title:'Buy',times:[900000]}],{
   scannerId:c.scannerIds[0],reader:3,derived:[{kind:'entry',side:'long',price:100,sl:99,tp:[101],label:'derived buy',message:'',source:'derived',barTime:900000,barIndex:10}]});
  assert.ok(events.every(e=>e.kind==='info'),c.name);
 }
});
test('Synapse entry/reversal batches keep both actions; legacy readings stay frozen',()=>{
 const packet={schema:'stp.events.v1',events:[{action:'flip_close',direction:-1,price:100},buy]};
 assert.deepEqual(read('synapse-trail-pro',packet).map(e=>[e.kind,e.side,e.exitType]),[['exit','short','flip'],['entry','long',undefined]]);
 for(const reader of [1,2])assert.deepEqual(read('synapse-trail-pro',packet,reader).map(e=>e.kind),['info']);
 assert.deepEqual(read('synapse-trail-pro',`🔄 FLIP_CLOSE | Price: 100 | Entry: 101 | SL: 102\n🟢 BUY | Price: 100 | Entry: 100 | SL: 99 | TP1: 101 | TP2: 102 | TP3: 103`).map(e=>e.kind),['exit','entry']);
});
test('author review does not enable unvalidated native schemas or incompatible interpretations',()=>{
 for(const id of ['self-aware-trend-system','precision-sniper-upstream-6-0','fibonacci-structure-engine']){
  assert.deepEqual(read(id,{schema:'sats.events.v2',events:[buy]}),[]);
  const c=structuredClone(DEFAULT_CONFIG);c.scanners[id]={enabled:false,symbols:null,timeframes:null,exitMode:'both',reader:3};
  assert.ok(validateConfig(c).some(x=>/validated Willy adapter/.test(x)));
 }
 const c=structuredClone(DEFAULT_CONFIG);c.scanners['synapse-trail-pro']={enabled:false,symbols:null,timeframes:null,exitMode:'both',reader:3,invert:true};
 assert.ok(validateConfig(c).some(x=>/cannot invert/.test(x)));
});
test('native channels, label filters and none mappings still block entries while preserving exits',()=>{
 const alerts=[a({schema:'stp.events.v1',events:[{action:'flip_close',direction:-1,price:100},buy]})];
 for(const opts of [{sources:['shape'] as const},{labels:['SHORT']},{sides:{LONG:'none' as const}},{sides:{LONG:'short' as const}}]){
  const e=extractEvents(alerts,[],{scannerId:'synapse-trail-pro',reader:3,...opts,sources:opts.sources?[...opts.sources]:undefined});
  assert.equal(e.filter(x=>x.kind==='entry').length,0);assert.equal(e.filter(x=>x.kind==='exit').length,1);
 }
 assert.deepEqual(extractEvents(alerts,[],{scannerId:'synapse-trail-pro',reader:3,invert:true}),[]);
});
test('break-even activation amends the stop; a BE stop-out closes; disabled gates never become entries',()=>{
 const x=read('structure-anchored-vwap-upstream-2-0',{action:'break_even',sl:100})[0];
 assert.equal(x.exitType,'stop_update');assert.equal(x.price,100);assert.match(describeEvent(x),/amendment/);
 assert.equal(read('structure-anchored-vwap-upstream-2-0',{action:'be_stop',price:100})[0].exitType,'be');
 for(const action of ['new_leg_bull','vwap_cross_up','candidate_cancelled'])assert.equal(read('structure-anchored-vwap-upstream-2-0',{action,price:100})[0].kind,'info');
 const b=read('liquidity-trail-matrix','🛡️ BREAK-EVEN | BTCUSD | SL moved to 100')[0];assert.equal(b.exitType,'stop_update');assert.equal(b.price,100);
});
test('Liquidity reversal closes the named old side and native entry keeps geometry',()=>{
 assert.equal(read('liquidity-trail-matrix-author-native','🔄 REVERSAL | Long → Short | Price: 100')[0].side,'long');
 const e=read('liquidity-trail-matrix-author-native','🟢 LONG | BTCUSD | Price: 100 | SL: 99 | TP1: 101 | TP2: 102 | TP3: 103')[0];
 assert.equal(e.kind,'entry');assert.deepEqual(e.tp,[101,102,103]);
 assert.equal(read('liquidity-trail-matrix-author-native','▲ BULL FLIP | BTCUSD | Price: 100')[0].kind,'info');
});
test('bad geometry, null batch members, invalid schema and non-entry actions fail closed',()=>{
 const cases=[{schema:'stp.events.v1',events:[null,{...buy,sl:101}]},{schema:'stp.events.v999',events:[buy]},{action:'setup_bull',entry:100,sl:99}];
 for(const p of cases)assert.ok(read('synapse-trail-pro',p).every(e=>e.kind==='info'));
});
test('reader 3 has a distinct evidence identity, cannot be set on an unreviewed family, and leaves all risk/capital values intact',()=>{
 const c=structuredClone(DEFAULT_CONFIG),risk=JSON.stringify(c.risk),paper=JSON.stringify(c.paper);
 const id='synapse-trail-pro';c.scanners[id]={enabled:false,symbols:null,timeframes:null,exitMode:'both'};
 const old=strategyIdentity('source',c,id);c.scanners[id].reader=3;assert.notEqual(strategyIdentity('source',c,id),old);
 assert.ok(!validateConfig(c).some(x=>/reader/.test(x)));c.scanners.other={...c.scanners[id]};assert.ok(validateConfig(c).some(x=>/validated Willy adapter/.test(x)));
 assert.equal(JSON.stringify(c.paper),paper);assert.equal(JSON.stringify(c.risk),risk);
});
