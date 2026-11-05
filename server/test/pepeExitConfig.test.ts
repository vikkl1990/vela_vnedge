import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DEFAULT_CONFIG} from '../src/config.ts';
import {PEPE_EXIT_PLANS,enablePepeExitComparison} from '../../ops/enable-pepe-exit-comparison.ts';

test('PEPE exit migration preserves account policy and other plans; backs up and is idempotent',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vnedge-pepe-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'config.json'),cfg=structuredClone(DEFAULT_CONFIG);
  cfg.execution.mode='paper';cfg.incubator.enabled=true;
  Object.assign(cfg.paper,{marginPerTrade:150,maxStopLossPct:3,skipScriptStops:true,trailAfterR:.5,trailGiveBackPct:10,floorAtR:.5,floorKeepR:.25,trailAtrMult:0});
  cfg.scanners[PEPE_EXIT_PLANS[0].scannerId]={enabled:true,symbols:null,timeframes:null,entryProtection:'atr',exitMode:'both'};
  const other={id:'other',enabled:true,revision:1,scannerId:'other',symbol:'ETHUSD',tf:'1h',variant:'current' as const,referenceEquity:1000};cfg.executionPlans=[other];
  const before=JSON.stringify(cfg);fs.writeFileSync(file,before);
  assert.equal(enablePepeExitComparison(file,true).changed,true);assert.equal(fs.readFileSync(file,'utf8'),before);
  const result=enablePepeExitComparison(file);assert.ok(result.backup);assert.equal(fs.readFileSync(result.backup!,'utf8'),before);
  const next=JSON.parse(fs.readFileSync(file,'utf8'));assert.deepEqual(next.executionPlans,[other,...PEPE_EXIT_PLANS]);
  next.executionPlans=[other];assert.deepEqual(next,cfg,'only the two research plans change');
  assert.equal(enablePepeExitComparison(file).changed,false);
  for(const [mutate,error] of [
    [(c:any)=>{c.execution.mode='live'},/paper execution/],
    [(c:any)=>{c.incubator.enabled=false},/scheduler/],
    [(c:any)=>{c.paper.trailAfterR=1},/tested control/],
    [(c:any)=>{c.paper.skipScriptStops=false},/tested control/],
    [(c:any)=>{c.paper.marginPerTrade=300},/150/],
    [(c:any)=>{c.executionPlans[1].revision=2},/differs/],
  ] as const){const changed=JSON.parse(fs.readFileSync(file,'utf8'));mutate(changed);const text=JSON.stringify(changed);fs.writeFileSync(file,text);assert.throws(()=>enablePepeExitComparison(file),error);assert.equal(fs.readFileSync(file,'utf8'),text);fs.writeFileSync(file,JSON.stringify({...cfg,executionPlans:[other,...PEPE_EXIT_PLANS]}));}
});
