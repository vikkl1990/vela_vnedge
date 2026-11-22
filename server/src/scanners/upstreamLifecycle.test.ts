import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PinePool} from '../pine/pool.ts';
import {ScannerRegistry} from './registry.ts';
import {upstreamSources,BAR_BALANCE_V1} from './upstreamLifecycle.ts';
import {readPlotLifecycle,plotPrefix,nativeGeometryError} from './plotLifecycle.ts';
import {variantCompatibleSource} from './variantCompat.ts';
import {applyPatches} from '../pine/patches.ts';
import {readingOf} from './reading.ts';
import {extractEvents} from './extractor.ts';
import type {Bar} from '../data/candleStore.ts';
const specs=JSON.parse(fs.readFileSync(new URL('../../../scripts/specs.json',import.meta.url),'utf8'));
const bars:Bar[]=JSON.parse(fs.readFileSync(new URL('../../test/fixtures/markittick-eth-15m-20261114.json',import.meta.url),'utf8'));

test('upstream lifecycle emits old-side exits before new entries and never invents partial quantities',()=>{
 const b={time:1800000000000,open:100,high:103,low:97,close:100,volume:1};
 for(const id of Object.keys(upstreamSources)){
  const values={entry:-1,stop:102,tp1:98,tp2:96,tp3:94,exitSide:1,close:4,hit1:0,hit2:0,amend:0};
  const ctx={scannerId:id,bars:[b],alerts:[],shapes:[],labels:[],mode:'live' as const,
   plots:Object.entries(values).map(([k,value])=>({title:plotPrefix+k,style:'line',overlay:true,data:[{time:b.time,value}]}))};
  assert.deepEqual(readPlotLifecycle(ctx).map(e=>[e.kind,e.side,e.exitType]),[['exit','long','flip'],['entry','short',undefined]]);
  const milestone={...ctx,plots:ctx.plots.map(p=>({...p,data:[{time:b.time,value:p.title.endsWith('entry')?0:p.title.endsWith('close')?0:p.title.endsWith('hit1')?1:p.title.endsWith('amend')?100:p.data[0].value}]}))};
  const events=readPlotLifecycle(milestone);assert.deepEqual(events.map(e=>e.exitType),['tp1','stop_update']);assert.ok(events.every(e=>!e.partial));
  assert.match(nativeGeometryError(id,'long',103,98,[102,104,106])!,/target/);
  if(id===BAR_BALANCE_V1){ctx.plots.find(p=>p.title.endsWith('close'))!.data[0].value=5;assert.equal(readPlotLifecycle(ctx)[0].exitType,'close');}
 }
});

test('three actual upstream sources preserve author outputs and have causal closed-bar lifecycle signals',{timeout:180000},async t=>{
 const registry=new ScannerRegistry(),pool=new PinePool(1,30000);t.after(()=>pool.stop());
 for(const id of Object.keys(upstreamSources)){
  const s=registry.get(id)!;assert.equal(s.status,'ok',s.reason??id);assert.equal(specs[id].enabled,false);
  assert.throws(()=>variantCompatibleSource(id,s.source+'\n'),/Source changed/);
  const run=(source:string,b:Bar[])=>pool.run({scannerId:id,source,symbol:'ETHUSD',tf:'15m',tickSize:.01,bars:b,tailBars:'all',plotTail:b.length});
  const original=await run(applyPatches(s.source,s.file).source,bars),observed=await run(s.patched,bars);
  assert.ok(original.ok,original.error);assert.ok(observed.ok,observed.error);
  assert.deepEqual(observed.alerts,original.alerts);assert.deepEqual(observed.shapes,original.shapes);
  const read=(r:typeof observed,b:Bar[])=>extractEvents(r.alerts,r.shapes,{...readingOf(specs[id],id,900000,s.patched).extract,derived:readPlotLifecycle({...r,bars:b,scannerId:id,mode:'backtest'})});
  const events=read(observed,bars),entries=events.filter(e=>e.kind==='entry');
  assert.ok(entries.length>0,id+' must exercise actual entries');
  for(const e of entries)assert.equal(nativeGeometryError(id,e.side!,e.price!,e.sl,e.tp),null);
  for(const end of [500,800]){
   const b=bars.slice(0,end),r=await run(s.patched,b);assert.ok(r.ok,r.error);
   assert.deepEqual(read(r,b),events.filter(e=>e.barIndex<end),id+' prefix parity');
  }
  t.diagnostic(`${id}: ${entries.length} entries, ${events.filter(e=>e.kind==='exit').length} exit/amendment observations`);
 }
});
