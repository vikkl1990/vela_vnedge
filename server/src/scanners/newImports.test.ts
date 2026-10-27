import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {SCRIPTS_DIR} from '../config.ts';
import {applyPatches} from '../pine/patches.ts';
import {extractEvents} from './extractor.ts';
import {readingOf} from './reading.ts';
const specs=JSON.parse(fs.readFileSync(`${SCRIPTS_DIR}/specs.json`,'utf8'));
const alert=(title:string,time:number)=>({title,message:title,type:'alertcondition' as const,time,barIndex:time});
test('Signal Charge reads confirmed locks only, excluding intrabar and persistent stance signals',()=>{
 const id='signal-charge-momentum-buy-sell-signals',read=readingOf(specs[id],id,900000);
 const alerts=['Buy locked (confirmed at bar close)','Sell locked (confirmed at bar close)','Buy live (intrabar)','Sell live (intrabar)','Buy charge 80% (live)','Sell charge 80% (live)','Thrust faded (confirmed at bar close)'].map((t,i)=>alert(t,i+1));
 const ev=extractEvents(alerts,[{title:'Stance strip (long)',times:[8,9,10]}],{...read.extract,drawn:[{text:'BUY ≥ 100',time:11,y:100,style:'style_label_left'}]});
 assert.deepEqual(ev.map(e=>[e.kind,e.side,e.barTime]),[['entry','long',1],['entry','short',2]]);
});
test('Trend Step adapter exposes the original flip conditions, scoped to its source',()=>{
 const file='ihf781Bu-Efficient-Trend-Step-Noise-Detection.pine',source=fs.readFileSync(`${SCRIPTS_DIR}/pine/${file}`,'utf8');
 const patched=applyPatches(source,file);
 assert.ok(patched.applied.includes('trend-step-confirmed-signals'));
 assert.match(patched.source,/alertcondition\(barstate\.isconfirmed and buySignal,/);
 assert.match(patched.source,/alertcondition\(barstate\.isconfirmed and sellSignal,/);
 assert.equal((applyPatches(patched.source,file).source.match(/alertcondition\(/g)??[]).length,2);
 assert.ok(!applyPatches(source,'unrelated.pine').applied.includes('trend-step-confirmed-signals'));
 const id='efficient-trend-step-noise-detection',read=readingOf(specs[id],id,900000,patched.source);
 const ev=extractEvents([alert('Trend Step buy confirmed',1),alert('Trend Step sell confirmed',2)],[],{...read.extract,drawn:[{text:'81.772K',time:3,y:80000,style:'style_label_up'}]});
 assert.deepEqual(ev.map(e=>[e.kind,e.side]),[['entry','long'],['entry','short']]);
});
test('Absorption Reversal remains quarantined while its source and intrabar data defects are unresolved',()=>{
 const row=JSON.parse(fs.readFileSync(`${SCRIPTS_DIR}/manifest.json`,'utf8')).find((m:any)=>m.id==='absorption-reversal-delta-trap');
 assert.equal(row.status,'incompatible');assert.match(row.reason,/precedence/);
});

test('a runtime pass cannot clear a source/data correctness quarantine',async()=>{
 const {reviewedStatus}=await import('./registry.ts');
 assert.deepEqual(reviewedStatus({status:'incompatible',quarantine:'source logic defect'},{ok:true}),{status:'incompatible',reason:'source logic defect'});
 assert.deepEqual(reviewedStatus({status:'incompatible',reason:'old runtime failure'},{ok:true}),{status:'ok',reason:null});
});
