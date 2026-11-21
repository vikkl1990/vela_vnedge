import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ConfigStore,DEFAULT_CONFIG,loadSpecs} from '../config.ts';
import {extractEvents} from './extractor.ts';
import {readingOf} from './reading.ts';
import type {WorkerLabel} from '../pine/worker.ts';
import {PinePool} from '../pine/pool.ts';
import {applyPatches} from '../pine/patches.ts';
import {strategyIdentity} from './identity.ts';
import {MAKER_UNIVERSE_PLANS} from '../research/makerUniverseStudy.ts';
import {fixBnbMakerReading,BNB_MAKER_READER} from '../../../ops/fix-bnb-maker-reading.ts';

test('Half-Trend maker excludes persistent trend badges, retains both reversal sides at creation time',()=>{
 const spec=loadSpecs()[BNB_MAKER_READER],T=1795262400000,H=14400000;
 const drawn:WorkerLabel[]=[
  {text:'▲',style:'style_label_up',time:T-H,createdAt:T,y:518.56},
  {text:'▼',style:'style_label_left',time:T,createdAt:T,y:585.8438989899},
 ];
 const read=readingOf(spec,BNB_MAKER_READER,H);
 const run=(labels=drawn)=>extractEvents([],[],{...read.extract,drawn:labels,sinceBarTime:T});
 assert.deepEqual(extractEvents([],[],{drawn,sinceBarTime:T}).map(e=>e.side),['long','short'],'observed legacy misread');
 assert.deepEqual(run().map(e=>[e.side,e.barTime]),[['long',T]],'back-plotted reversal becomes known only now');
 assert.equal(run([{...drawn[1],text:'▲'}]).length,0,'bullish status badge is context too');
 assert.deepEqual(run([{...drawn[0],text:'▼',style:'style_label_down'}]).map(e=>e.side),['short']);
 for(const style of [undefined,'style_label_center','unknown'])assert.equal(run([{...drawn[0],style}]).length,0);
 assert.equal(run([{...drawn[0],createdAt:undefined}]).length,0,'never invent creation time');
 assert.equal(run([{...drawn[0],text:'x'}]).length,0);
 const cfg=structuredClone(DEFAULT_CONFIG),old=strategyIdentity('source',cfg,'half-trend-channel');
 cfg.scanners[BNB_MAKER_READER]={symbols:null,timeframes:null,...spec} as any;
 assert.equal(strategyIdentity('source',cfg,'half-trend-channel'),old);
 assert.notEqual(strategyIdentity('source',cfg,BNB_MAKER_READER),old);
});

test('BNB repair revises shadow evidence only, preserves policies and is atomic/idempotent',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bnb-maker-reader-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json'),cfg=structuredClone(DEFAULT_CONFIG);
 cfg.execution.mode='paper';cfg.execution.allowProduction=false;cfg.incubator.enabled=true;
 cfg.scanners['half-trend-channel']={enabled:false,symbols:null,timeframes:null,exitMode:'both',hidden:true};
 cfg.executionPlans=structuredClone(MAKER_UNIVERSE_PLANS.filter(p=>p.comparison?.group==='maker-v2-bnb-channel'));
 fs.writeFileSync(file,JSON.stringify(cfg),{mode:0o600});const before=fs.readFileSync(file,'utf8');
 assert.equal(fixBnbMakerReading(file,true).changed,true);assert.equal(fs.readFileSync(file,'utf8'),before);
 fixBnbMakerReading(file);const saved=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.deepEqual(saved.paper,cfg.paper);assert.deepEqual(saved.risk,cfg.risk);assert.deepEqual(saved.incubator,cfg.incubator);
 assert.deepEqual(saved.scanners['half-trend-channel'],cfg.scanners['half-trend-channel']);
 assert.ok(saved.executionPlans.every((p:any)=>p.revision===2&&p.scannerId===BNB_MAKER_READER));
 assert.equal(saved.scanners[BNB_MAKER_READER].enabled,false);assert.equal(new ConfigStore(file).get().execution.mode,'paper');
 const at=fs.statSync(file).mtimeMs;assert.equal(fixBnbMakerReading(file).changed,false);assert.equal(fs.statSync(file).mtimeMs,at);
 saved.executionPlans[0].label='operator edit';fs.writeFileSync(file,JSON.stringify(saved));const edited=fs.readFileSync(file,'utf8');
 assert.throws(()=>fixBnbMakerReading(file),/refusing overwrite/);assert.equal(fs.readFileSync(file,'utf8'),edited);
});

test('actual Half-Trend source supplies both reversal styles without using its trend badge',{timeout:30000},async t=>{
 const pool=new PinePool(1,20000);t.after(()=>pool.stop());
 const source=applyPatches(fs.readFileSync(new URL('../../../scripts/pine/pP2qBbWw-Half-Trend-Channel-BigBeluga.pine',import.meta.url),'utf8'),'half-trend.pine').source;
 const bars=Array.from({length:1000},(_,i)=>{
  const close=100+30*Math.sin(i/18)+9*Math.sin(i/3),open=100+30*Math.sin((i-1)/18)+9*Math.sin((i-1)/3);
  return {time:1700000000000+i*14400000,open,close,high:Math.max(open,close)+1,low:Math.min(open,close)-1,volume:1000};
 });
 const res=await pool.run({scannerId:BNB_MAKER_READER,source,symbol:'BNBUSD',tf:'4h',tickSize:.01,bars,tailBars:'all',plotTail:0});
 assert.equal(res.ok,true,res.error);
 const events=extractEvents(res.alerts,res.shapes,{...readingOf(loadSpecs()[BNB_MAKER_READER],BNB_MAKER_READER,14400000,source).extract,drawn:res.labels});
 assert.ok(events.some(e=>e.side==='long'));assert.ok(events.some(e=>e.side==='short'));
 for(const e of events){
  const label=res.labels.find(l=>l.createdAt===e.barTime&&l.text===e.label&&l.style!=='style_label_left');
  assert.ok(label);assert.ok(label.time<e.barTime,'confirmed reversal is drawn one bar back, never executed there');
 }
});
