import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {BREAKOUT_NATIVE,ML_RSI_NATIVE,plotPrefix,readPlotLifecycle,nativeGeometryError} from './plotLifecycle.ts';
import {variantCompatibleSource} from './variantCompat.ts';
import {applyRules} from './rules.ts';
import {readingOf} from './reading.ts';
import {extractEvents} from './extractor.ts';
const T=1800000000000;
const bars=[{time:T,open:100,close:100,high:103,low:97,volume:1}];
const ctx=(id:string,values:Record<string,number|null>)=>({scannerId:id,bars,mode:'live' as const,alerts:[],shapes:[],labels:[],plots:Object.entries(values).map(([k,value])=>({title:plotPrefix+k,style:'line',overlay:true,data:[{time:T,value}]}))});
test('native breakout reads signal-time prices, rejects overshoot, missing targets and ambiguous signals',()=>{
 const c=ctx(BREAKOUT_NATIVE,{entry:1,stop:98,tp1:102,tp2:104,tp3:106});
 assert.deepEqual(readPlotLifecycle(c).map(e=>[e.kind,e.side,e.sl,e.tp]),[['entry','long',98,[102,104,106]]]);
 assert.equal(readPlotLifecycle({...c,bars:[{...bars[0],close:102.5}]}).filter(e=>e.kind==='entry').length,0);
 assert.equal(readPlotLifecycle(ctx(BREAKOUT_NATIVE,{entry:-1,stop:102,tp1:98,tp2:96,tp3:94}))[0].side,'short');
 assert.equal(readPlotLifecycle(ctx(BREAKOUT_NATIVE,{entry:0,stop:98,tp1:102,tp2:104,tp3:106})).length,0);
 assert.throws(()=>readPlotLifecycle({...c,plots:c.plots.slice(1)}),/Missing/);
 assert.throws(()=>readPlotLifecycle({...c,plots:[...c.plots,c.plots[0]]}),/duplicate/);
 assert.equal(readPlotLifecycle({...c,plots:c.plots.map(p=>({...p,data:p.data.map(d=>({...d,time:T+1}))}))}).length,0,'future plot is not carried back');
});
test('ML classifier alone enters; regime flip closes the old side and updates the new side stop without a TP',()=>{
 const c=ctx(ML_RSI_NATIVE,{entry:0,stop:102,direction:-1,flip:-1});
 assert.deepEqual(readPlotLifecycle(c).map(e=>[e.kind,e.side,e.exitType,e.price]),[['exit','long','flip',undefined],['exit','short','stop_update',102]]);
 const ev=readPlotLifecycle(ctx(ML_RSI_NATIVE,{entry:-1,stop:102,direction:-1,flip:0})).at(-1)!;
 assert.equal(ev.kind,'entry');assert.deepEqual(ev.tp,[]);assert.equal(ev.sl,102);
 assert.equal(readPlotLifecycle(ctx(ML_RSI_NATIVE,{entry:-1,stop:98,direction:1,flip:0})).filter(e=>e.kind==='entry').length,0);
});
test('versioned adapters route through shared reading/rules and cannot inherit generic alerts or base rules',()=>{
 for(const id of [BREAKOUT_NATIVE,ML_RSI_NATIVE]){
  const c=ctx(id,id===BREAKOUT_NATIVE?{entry:1,stop:98,tp1:102,tp2:104,tp3:106}:{entry:1,stop:98,direction:1,flip:0});
  const reading=readingOf({reader:2,sources:['derived']},id,900000,'source','unrelated-base');
  const derived=applyRules({...c,...reading.rule});
  const alerts=[{type:'alert' as const,time:T,barIndex:0,message:'SHORT | Price: 100 | SL: 105'}];
  const events=extractEvents(alerts,[{title:'ST Flip Dn',times:[T]}],{...reading.extract,derived});
  assert.equal(events.filter(e=>e.kind==='entry').length,1);assert.equal(events.find(e=>e.kind==='entry')!.side,'long');
  assert.equal(extractEvents(alerts,[],{...reading.extract,derived,sources:[]}).filter(e=>e.kind==='entry').length,0,'entry channel off is respected');
  assert.equal(extractEvents(alerts,[],{...reading.extract,derived,invert:true}).length,0,'native geometry cannot be inverted');
  assert.equal(extractEvents(alerts,[],{...reading.extract}).length,0,'missing source observations never falls back to generic entries');
  assert.equal(extractEvents(alerts,[],{...reading.extract,derived,sinceBarTime:T+1}).length,0);
 }
 assert.equal(extractEvents([],[{title:'Break Up',times:[T]}],{scannerId:'other'}).length,1);
});
test('source observations are appended only to exact reviewed variants; originals remain byte-identical',()=>{
 const sources=[[BREAKOUT_NATIVE,'IV6eZF3w-Smart-Money-Breakout-Signals-AlgoAlpha.pine'],[ML_RSI_NATIVE,'VrTL3VwF-Machine-Learning-RSI-AI-Classification-Ranking-Zeiierman.pine']];
 for(const [id,file] of sources){
  const source=fs.readFileSync(new URL('../../../scripts/pine/'+file,import.meta.url),'utf8');
  assert.equal(variantCompatibleSource('legacy',source).source,source);
  assert.ok(variantCompatibleSource(id,source).source.startsWith(source+'\n'));
  assert.throws(()=>variantCompatibleSource(id,source+'\n'),/Source changed/);
 }
});
test('native quote and fill geometry never substitutes ATR or silently drops target rungs',()=>{
 assert.match(nativeGeometryError(BREAKOUT_NATIVE,'long',103,98,[102,104,106])!,/target/);
 assert.match(nativeGeometryError(BREAKOUT_NATIVE,'long',97,98,[102,104,106])!,/stop/);
 assert.equal(nativeGeometryError(BREAKOUT_NATIVE,'short',100,102,[98,96,94]),null);
 assert.equal(nativeGeometryError(ML_RSI_NATIVE,'long',100,98,[]),null);
 assert.match(nativeGeometryError(ML_RSI_NATIVE,'long',100,98,[102])!,/no fixed target/);
 assert.equal(nativeGeometryError('legacy','long',97,98,[102]),null);
});
