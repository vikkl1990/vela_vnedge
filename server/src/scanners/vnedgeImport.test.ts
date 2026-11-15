import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PinePool} from '../pine/pool.ts';
import {ScannerRegistry} from './registry.ts';
import {readingOf} from './reading.ts';
import {applyRules} from './rules.ts';
import {extractEvents} from './extractor.ts';
import {TREND_CONTINUATION,STEALTH_NATIVE,readPlotLifecycle,plotPrefix,nativeGeometryError} from './plotLifecycle.ts';
import {variantCompatibleSource} from './variantCompat.ts';
import {nativeReentry} from './nativeLifecycle.ts';
import type {Bar} from '../data/candleStore.ts';
import type {WorkerResult} from '../pine/worker.ts';

const specs=JSON.parse(fs.readFileSync(new URL('../../../scripts/specs.json',import.meta.url),'utf8'));
const fixture=JSON.parse(fs.readFileSync(new URL('../../test/fixtures/vnedge-trend-reference.json',import.meta.url),'utf8'));
const canonical=(r:WorkerResult,bars:Bar[],id:string,source:string)=>{
 const reading=readingOf(specs[id],id,900000,source);
 const derived=applyRules({...r,bars,scannerId:id,mode:'backtest',...reading.rule});
 return extractEvents(r.alerts,r.shapes,{...reading.extract,derived});
};
test('Trend Continuation Pine port matches pinned Python signals and brackets, including strict inputs, warmup and flat ATR ties',async()=>{
 const registry=new ScannerRegistry(),s=registry.get(TREND_CONTINUATION)!;
 assert.equal(s.status,'ok');assert.equal(specs[s.id].enabled,false);
 const pool=new PinePool(1,30000);
 const run=(bars:Bar[],inputs:Record<string,number>={})=>pool.run({scannerId:s.id,source:s.patched,symbol:'ETHUSD',tf:'15m',tickSize:.01,bars,tailBars:'all',plotTail:bars.length,inputs});
 try{
  for(const [threshold,expected] of [[.30,fixture.events],[.35,fixture.strictEvents]] as const){
   const r=await run(fixture.bars,{erTrendMin:threshold});assert.ok(r.ok,r.error);
   const entries=canonical(r,fixture.bars,s.id,s.patched).filter(e=>e.kind==='entry');
   assert.deepEqual(entries.map(e=>[e.barIndex,e.side]),expected.map((e:any)=>[e.index,e.side]));
   for(const [i,e] of entries.entries()){
    assert.ok(Math.abs(e.sl!-expected[i].sl)<1e-8);
    assert.ok(Math.abs(e.tp[0]-expected[i].tp[0])<1e-8);
    assert.ok(Math.abs(Math.abs(e.tp[0]-e.price!)/Math.abs(e.price!-e.sl!)-2)<1e-9);
   }
  }
  const short=fixture.bars.slice(0,263),warm=await run(short);assert.ok(warm.ok,warm.error);
  assert.equal(canonical(warm,short,s.id,s.patched).length,0);
  const flat=await run(fixture.flat);assert.ok(flat.ok,flat.error);
  assert.equal(canonical(flat,fixture.flat,s.id,s.patched).length,0);
  assert.equal(flat.plots.find(p=>p.title==='ATR midrank')!.data.at(-1)!.value,.5);
  for(const end of [264,400,600,850]){
   const bars=fixture.bars.slice(0,end),r=await run(bars);assert.ok(r.ok,r.error);
   assert.deepEqual(canonical(r,bars,s.id,s.patched).filter(e=>e.kind==='entry').map(e=>[e.barIndex,e.side]),fixture.events.filter((e:any)=>e.index<end).map((e:any)=>[e.index,e.side]),'prefix cannot revise earlier signals');
  }
  assert.throws(()=>variantCompatibleSource(s.id,s.source+'\n'),/Source changed/);
 }finally{pool.stop();}
});

const T=1800000000000;
const context=(values:Record<string,number|null>)=>({
 scannerId:STEALTH_NATIVE,mode:'live' as const,alerts:[],shapes:[],labels:[],
 bars:[{time:T,open:100,high:103,low:97,close:100,volume:10}],
 plots:Object.entries({entry:0,stop:98,tp1:102,tp2:104,tp3:106,exitSide:1,close:0,hit1:0,hit2:0,amend:null,...values}).map(([name,value])=>({title:plotPrefix+name,style:'line',overlay:true,data:[{time:T,value}]})),
});
test('Stealth native closes the old side before reversal, treats BE as amendment, and never closes at a milestone',()=>{
 const reversed=readPlotLifecycle(context({entry:-1,stop:102,tp1:98,tp2:96,tp3:94,close:4}));
 assert.deepEqual(reversed.map(e=>[e.kind,e.side,e.exitType]),[['exit','long','flip'],['entry','short',undefined]]);
 const milestone=readPlotLifecycle(context({hit1:1,amend:100}));
 assert.deepEqual(milestone.map(e=>[e.exitType,e.price]),[['tp1',undefined],['stop_update',100]]);
 assert.deepEqual(readPlotLifecycle(context({exitSide:-1,close:2})).map(e=>[e.side,e.exitType]),[['short','be']]);
 assert.deepEqual(readPlotLifecycle(context({close:1,hit1:1,hit2:1})).map(e=>e.exitType),['sl'],'SL has source-defined same-bar priority');
 assert.equal(readPlotLifecycle(context({entry:1,stop:101})).filter(e=>e.kind==='entry').length,0);
 assert.equal(nativeReentry(STEALTH_NATIVE,2),true);
 assert.equal(nativeReentry('stealthtrail-supertrend',2),false);
 assert.match(nativeGeometryError(TREND_CONTINUATION,'long',105,98,[104])!,/target/);
 assert.match(nativeGeometryError(STEALTH_NATIVE,'long',100,98,[102])!,/target/);
});

test('Stealth observation exports preserve original script alerts and stable closed-bar entries',async()=>{
 const registry=new ScannerRegistry(),s=registry.get(STEALTH_NATIVE)!,legacy=registry.get('stealthtrail-supertrend')!;
 assert.equal(s.status,'ok');assert.equal(specs[s.id].enabled,false);
 assert.throws(()=>variantCompatibleSource(s.id,s.source+'\n'),/Source changed/);
 const pool=new PinePool(1,30000);
 const run=(source:string,bars:Bar[])=>pool.run({scannerId:s.id,source,symbol:'ETHUSD',tf:'15m',tickSize:.01,bars,tailBars:'all',plotTail:bars.length});
 try{
  const bars=fixture.bars,r=await run(s.patched,bars),control=await run(legacy.patched,bars);
  assert.ok(r.ok,r.error);assert.ok(control.ok,control.error);assert.deepEqual(r.alerts,control.alerts);assert.deepEqual(r.shapes,control.shapes);
  const events=canonical(r,bars,s.id,s.patched),entries=events.filter(e=>e.kind==='entry');
  assert.ok(entries.some(e=>e.side==='long'));assert.ok(entries.some(e=>e.side==='short'));
  assert.ok(events.some(e=>e.exitType==='stop_update'));
  for(const e of entries)assert.equal(nativeGeometryError(s.id,e.side!,e.price!,e.sl,e.tp),null);
  for(const end of [400,650,900]){
   const prefix=bars.slice(0,end),p=await run(s.patched,prefix);assert.ok(p.ok,p.error);
   assert.deepEqual(canonical(p,prefix,s.id,s.patched),events.filter(e=>e.barIndex<end));
  }
 }finally{pool.stop();}
});
