import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {MARKITTICK_NATIVE} from './markitTick.ts';
import {extractEvents,type ScanEvent} from './extractor.ts';
import {applyPatches} from '../pine/patches.ts';
import {PinePool} from '../pine/pool.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {planSnapshot} from '../paper/executionPlans.ts';
const root=new URL('../../../',import.meta.url),specs=JSON.parse(fs.readFileSync(new URL('scripts/specs.json',root),'utf8'));
const manifest=JSON.parse(fs.readFileSync(new URL('scripts/manifest.json',root),'utf8'));
const id=Object.keys(MARKITTICK_NATIVE)[0];
const event=(message:string,time=900000)=>({type:'alert' as const,message,time,barIndex:1});
test('MarkitTick native readers are scoped and preserve exact valid brackets without invented targets',()=>{
 const a=event('{"action":"LONG","entry":100,"sl":98,"tp":104}');
 assert.equal(extractEvents([a],[],{scannerId:id,reader:1}).length,0);
 assert.equal(extractEvents([a],[],{scannerId:'unrelated',reader:2})[0]?.kind,'info');
 const events=extractEvents([a,a],[],{scannerId:id,...specs[id]});
 assert.equal(events.length,1);assert.deepEqual(events[0].tp,[104]);assert.equal(events[0].sl,98);assert.equal(events[0].barTime,900000);
 assert.equal(extractEvents([a],[],{scannerId:id,reader:2,sources:['shape']}).length,0);
 assert.equal(extractEvents([a],[],{scannerId:id,reader:2,sinceBarTime:900001}).length,0);
 for(const msg of ['{"action":"LONG","entry":100,"sl":102,"tp":104}','{"action":"LONG","entry":100,"sl":98}','{"action":"close_long","entry":100,"sl":98,"tp":104}','{"action":"LONG","entry":"","sl":98,"tp":104}','not JSON'])assert.equal(extractEvents([event(msg)],[],{scannerId:id,reader:2}).length,0,msg);
 const short=extractEvents([event('{"action":"short","entry":"100","sl":"102","tp":"97"}')],[],{scannerId:id,reader:2});assert.equal(short[0].side,'short');
});
test('new profiles are disabled and native 1.5R/2R/structural targets survive research policy',()=>{
 for(const id of Object.keys(MARKITTICK_NATIVE)){
  assert.equal(specs[id].enabled,false);const cfg=structuredClone(DEFAULT_CONFIG);cfg.scanners[id]={symbols:null,timeframes:null,...specs[id]};
  const snap=planSnapshot(cfg,{id:'test-'+id,revision:1,enabled:true,scannerId:id,symbol:'ETHUSD',tf:'15m',variant:'current',referenceEquity:1000},MARKITTICK_NATIVE[id]);
  assert.equal(snap.paper.scriptTargets,'use');assert.equal(snap.paper.skipScriptStops,false);assert.deepEqual(snap.paper.tpSplit,[1,0,0]);assert.equal(snap.paper.trailAfterR,0);assert.equal(snap.paper.floorAtR,0);
 }
});
test('actual MarkitTick source emits causal bracket entries, with prefix parity and no chart duplicates',{timeout:60000},async t=>{
 const pool=new PinePool(1,15000);t.after(()=>pool.stop());
 const bars:Array<{time:number;open:number;high:number;low:number;close:number;volume:number}>=JSON.parse(fs.readFileSync(new URL('server/test/fixtures/markittick-eth-15m-20261114.json',root),'utf8'));
 for(const [id,hash]of Object.entries(MARKITTICK_NATIVE)){
  const row=manifest.find((m:any)=>m.id===id),raw=fs.readFileSync(new URL('scripts/pine/'+row.file,root),'utf8');assert.equal(createHash('sha256').update(raw).digest('hex'),hash,id);
  const source=applyPatches(raw,row.file).source;
  const run=async(b:typeof bars)=>{const out=await pool.run({scannerId:id,source,symbol:'ETHUSD',tf:'15m',tickSize:.01,bars:b,tailBars:'all',plotTail:0});assert.equal(out.ok,true,`${id}: ${out.error}`);return extractEvents(out.alerts,out.shapes,{scannerId:id,...specs[id]});};
  const all=await run(bars);assert.ok(all.length>0,id+' must exercise the reader');
  for(const e of all){assert.equal(e.kind,'entry');assert.equal(e.tp.length,1);assert.ok(e.side==='long'?e.sl!<e.price!&&e.tp[0]>e.price!:e.sl!>e.price!&&e.tp[0]<e.price!);}
  const canonical=(e:ScanEvent)=>({time:e.barTime,side:e.side,price:e.price,sl:e.sl,tp:e.tp});
  for(const e of all.filter(e=>e.barIndex>300).filter((_,i)=>i%Math.max(1,Math.floor(all.length/3))===0).slice(0,3)){
   const prefix=await run(bars.filter(b=>b.time<=e.barTime));assert.deepEqual(prefix.filter(p=>p.barTime===e.barTime).map(canonical),all.filter(p=>p.barTime===e.barTime).map(canonical),`${id} prefix ${e.barTime}`);
  }
 }
});

test('native source pin fails closed on upstream changes without affecting other scanners', async () => {
 const {markitTickSourceError}=await import('./markitTick.ts');
 assert.match(markitTickSourceError('mesa-adaptive-cycle-engine-markittick','changed')!,/source changed/);
 assert.equal(markitTickSourceError('other-scanner','changed'),null);
});

test('readiness describes the tested native target adapter without claiming paper eligibility', async () => {
 const {ScannerRegistry}=await import('./registry.ts');const {scannerContract}=await import('./contracts.ts');
 const registry=new ScannerRegistry();
 for(const id of Object.keys(MARKITTICK_NATIVE)){
  const detail=scannerContract(registry.get(id)!,specs[id]);
  assert.equal(detail.summary.adapter,'MarkitTick native bracket v1');
  assert.ok(detail.summary.gaps.some(g=>g.includes('prospective profitability')));
  assert.ok(!detail.summary.capabilities.includes('Uses a separate bot exit policy'));
 }
});
