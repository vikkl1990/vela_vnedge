import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ConfigStore,DEFAULT_CONFIG} from '../config.ts';
import {planSnapshot,MAX_RESEARCH_PLANS} from './executionPlans.ts';
import {VNEDGE_IMPORT_PLANS} from '../../../ops/enable-vnedge-import-shadow.ts';
import {LIQUID_IMPORT_PLANS,enableLiquidImportShadow} from '../../../ops/enable-liquid-import-shadow.ts';

function fixture(t:{after:(fn:()=>void)=>void}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'liquid-import-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json'),raw=structuredClone(DEFAULT_CONFIG);
 raw.execution.mode='paper';raw.paper.sizingMode='margin';raw.paper.marginPerTrade=150;raw.paper.maxStopLossPct=3;raw.incubator.enabled=true;raw.risk.ddScale=[];
 raw.executionPlans=Array.from({length:79},(_,i)=>({...structuredClone(VNEDGE_IMPORT_PLANS[i%6]),id:`existing-${i}`}));
 fs.writeFileSync(file,JSON.stringify(raw));return {file,raw,plans:raw.executionPlans};
}

test('liquid finalists add two isolated plans without changing 79 existing cohorts or any risk/evidence setting',t=>{
 const {file,raw,plans}=fixture(t),before=fs.readFileSync(file,'utf8'),cfg=new ConfigStore(file).get();
 const original=planSnapshot(cfg,plans[0],'pinned-source');
 assert.equal(enableLiquidImportShadow(file,true).totalPlans,81);assert.equal(fs.readFileSync(file,'utf8'),before);
 const result=enableLiquidImportShadow(file);assert.equal(result.changed,true);assert.equal(result.totalPlans,81);
 assert.ok('backup' in result);assert.equal(fs.readFileSync(result.backup,'utf8'),before);
 const after=JSON.parse(fs.readFileSync(file,'utf8')),next=new ConfigStore(file).get();
 assert.deepEqual(after.executionPlans.slice(0,79),raw.executionPlans);
 assert.deepEqual({...after,executionPlans:raw.executionPlans},raw);
 assert.deepEqual(planSnapshot(next,plans[0],'pinned-source'),original);
 assert.deepEqual(after.executionPlans.slice(79).map((p:typeof LIQUID_IMPORT_PLANS[number])=>[p.symbol,p.tf]),[['ZECUSD','1h'],['UNIUSD','1h']]);
 for(const p of LIQUID_IMPORT_PLANS){
  assert.equal(next.scanners[p.scannerId].enabled,false);
  const s=planSnapshot(next,p,'pinned-source');
  assert.equal(s.paper.marginPerTrade,150);assert.equal(s.paper.maxStopLossPct,3);
  assert.equal(s.paper.minRiskFeeRatio,cfg.paper.minRiskFeeRatio);assert.equal(s.paper.scalperOffer?.enabled,false);
 }
 const installed=fs.readFileSync(file,'utf8'),mtime=fs.statSync(file).mtimeMs;
 assert.equal(enableLiquidImportShadow(file).changed,false);assert.equal(fs.readFileSync(file,'utf8'),installed);assert.equal(fs.statSync(file).mtimeMs,mtime);
});

test('liquid rollout refuses edited plans, changed native readers and capacity overflow without writing',t=>{
 const {file,raw,plans}=fixture(t);
 const cases=[
  {...raw,executionPlans:[...plans,{...LIQUID_IMPORT_PLANS[0],referenceEquity:2000}]},
  {...raw,scanners:{...new ConfigStore(file).get().scanners,[LIQUID_IMPORT_PLANS[0].scannerId]:{...new ConfigStore(file).get().scanners[LIQUID_IMPORT_PLANS[0].scannerId],reader:1}}},
  {...raw,executionPlans:Array.from({length:MAX_RESEARCH_PLANS-1},(_,i)=>({...plans[0],id:`capacity-${i}`}))},
 ];
 for(const [i,c] of cases.entries()){
  fs.writeFileSync(file,JSON.stringify(c));const before=fs.readFileSync(file,'utf8');
  assert.throws(()=>enableLiquidImportShadow(file),i===0?/Edited plan/:i===1?/Reviewed profile/:new RegExp(String(MAX_RESEARCH_PLANS)));
  assert.equal(fs.readFileSync(file,'utf8'),before);
 }
});
