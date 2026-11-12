import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DEFAULT_CONFIG} from '../src/config.ts';
import {READING_PLANS,enableReadingComparisons} from '../../ops/enable-reading-comparisons.ts';

const base=(over:object={})=>({enabled:false,symbols:null,timeframes:null,exitMode:'both' as const,...over});

test('reading comparisons add four matched pairs and nothing else; back up; idempotent; refuse a confounded pair',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vnedge-reading-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'config.json'),cfg=structuredClone(DEFAULT_CONFIG);
  cfg.execution.mode='paper';cfg.incubator.enabled=true;cfg.paper.marginPerTrade=150;
  for(const p of READING_PLANS)cfg.scanners[p.scannerId]=base();
  cfg.scanners['trend-impulse-channels-zeiierman']=base({enabled:true,symbols:['AAVEUSD']});
  const other={id:'other',enabled:true,revision:1,scannerId:'other',symbol:'ETHUSD',tf:'1h',variant:'current' as const,referenceEquity:1000};cfg.executionPlans=[other];
  const before=JSON.stringify(cfg);fs.writeFileSync(file,before);
  assert.equal(READING_PLANS.length,8);
  assert.ok(READING_PLANS.every(p=>p.variant==='current'&&p.referenceEquity===1000&&p.comparison?.axis==='reading'&&p.maxStopLossPct===undefined));
  assert.equal(enableReadingComparisons(file,true).changed,true);assert.equal(fs.readFileSync(file,'utf8'),before);
  const result=enableReadingComparisons(file);assert.ok(result.backup);assert.equal(fs.readFileSync(result.backup!,'utf8'),before);
  const next=JSON.parse(fs.readFileSync(file,'utf8'));assert.deepEqual(next.executionPlans,[other,...READING_PLANS]);
  next.executionPlans=[other];assert.deepEqual(next,cfg,'only the eight research plans change');
  assert.equal(enableReadingComparisons(file).changed,false);
  const applied=fs.readFileSync(file,'utf8');
  for(const [mutate,error] of [
    [(c:any)=>{c.execution.mode='testnet'},/paper execution/],
    [(c:any)=>{c.incubator.enabled=false},/scheduler/],
    [(c:any)=>{c.paper.marginPerTrade=300},/150/],
    [(c:any)=>{c.scanners['supertrend-cluster-zeiierman-consensus'].exitMode='levels'},/more than their reading/],
    [(c:any)=>{c.scanners['liquidity-trail-matrix-reader2'].entryProtection='native'},/more than their reading/],
    [(c:any)=>{c.executionPlans[1].revision=2},/differs/],
  ] as const){const changed=JSON.parse(fs.readFileSync(file,'utf8'));mutate(changed);const text=JSON.stringify(changed);fs.writeFileSync(file,text);assert.throws(()=>enableReadingComparisons(file),error);assert.equal(fs.readFileSync(file,'utf8'),text);fs.writeFileSync(file,applied);}
});
