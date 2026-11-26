import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';
import{PinePool}from'../pine/pool.ts';import{ScannerRegistry}from'./registry.ts';import{loadSpecs}from'../config.ts';import{readingOf}from'./reading.ts';import{extractEvents}from'./extractor.ts';import{PRECISION_NATIVE,NEO_NATIVE,FISHER_UPDATED,sourceGeometryError}from'./sourceReaders.ts';import type{Bar}from'../data/candleStore.ts';
const bars:Bar[]=JSON.parse(fs.readFileSync(new URL('../../test/fixtures/markittick-eth-15m-20261114.json',import.meta.url),'utf8'));
test('actual updated sources preserve causal prefix signals and native price geometry',{timeout:180000},async t=>{
 const reg=new ScannerRegistry(),spec=loadSpecs(),pool=new PinePool(1,30000);t.after(()=>pool.stop());const counts=[];
 for(const id of[PRECISION_NATIVE,NEO_NATIVE,'fisher-transform-of-williams-r-divergence',FISHER_UPDATED]){
  const s=reg.get(id)!,sc=spec[id],read=readingOf(sc,id,900000,s.patched);
  const run=(b:Bar[])=>pool.run({scannerId:id,source:s.patched,symbol:'ETHUSD',tf:'15m',tickSize:.05,bars:b,tailBars:'all',plotTail:0,inputs:sc?.inputs,timezone:sc?.timezone});
  const r=await run(bars);assert.ok(r.ok,r.error);const events=extractEvents(r.alerts,r.shapes,{...read.extract,drawn:r.labels});const entries=events.filter(e=>e.kind==='entry');assert.ok(entries.length>0,id+' must exercise real source entries');
  if(id===PRECISION_NATIVE||id===NEO_NATIVE)for(const e of entries)assert.equal(sourceGeometryError(id,e.side!,e.price!,e.sl,e.tp),null);
  if(id===PRECISION_NATIVE){const raw=r.alerts.filter(a=>a.type==='alert').flatMap(a=>JSON.parse(a.message).events);assert.equal(entries.length,raw.filter(e=>e.event_type==='entry').length);assert.equal(events.filter(e=>e.kind==='exit'&&e.exitType!=='stop_update').length,raw.filter(e=>e.event_type==='exit').length);assert.ok(events.filter(e=>e.kind==='exit').every(e=>e.authorEntryAt));}
  for(const end of[500,800]){const r=await run(bars.slice(0,end));assert.ok(r.ok,r.error);assert.deepEqual(extractEvents(r.alerts,r.shapes,{...read.extract,drawn:r.labels}),events.filter(e=>e.barIndex<end),id+' prefix parity');}
  counts.push({id,entries:entries.length,exits:events.filter(e=>e.kind==='exit').length});
 }
 t.diagnostic(JSON.stringify(counts));
});
