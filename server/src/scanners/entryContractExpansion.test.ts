import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DEFAULT_CONFIG,validateConfig} from '../config.ts';
import {planSnapshot,MAX_RESEARCH_PLANS} from '../paper/executionPlans.ts';
import {ENTRY_CONTRACTS} from './entryContracts.ts';
import {CONTRACT_PLANS} from '../../../ops/enable-entry-contract-comparisons.ts';
import {EXPANSION_PLANS,EXPANSION_CELLS,expandEntryContracts} from '../../../ops/expand-entry-contract-comparisons.ts';

function fixture(t:any){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'contract-expansion-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json'),cfg=structuredClone(DEFAULT_CONFIG);
 cfg.execution.mode='paper';cfg.execution.allowProduction=false;cfg.incubator.enabled=true;
 for(const pin of Object.values(ENTRY_CONTRACTS))cfg.scanners[pin.scannerId]={enabled:false,symbols:null,timeframes:null,exitMode:'both'};
 cfg.executionPlans=structuredClone(CONTRACT_PLANS);
 // Retain an entire pre-expansion fleet, including unrelated experimental cohorts.
 for(let i=6;i<145;i++)cfg.executionPlans.push({...structuredClone(CONTRACT_PLANS[0]),id:`prior-${i}`,comparison:undefined});
 fs.writeFileSync(file,JSON.stringify(cfg));return {file,cfg};
}
test('expansion appends 24 arms to all 145 existing plans and changes no saved trading settings',t=>{
 const {file,cfg}=fixture(t),before=fs.readFileSync(file,'utf8');
 assert.equal(expandEntryContracts(file,true).totalPlans,169);assert.equal(fs.readFileSync(file,'utf8'),before);
 assert.throws(()=>expandEntryContracts(file,false,'stale'),/changed since preflight/);
 expandEntryContracts(file);const after=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.deepEqual(after.executionPlans.slice(0,145),JSON.parse(JSON.stringify(cfg.executionPlans)));
 assert.deepEqual({...after,executionPlans:[]},{...JSON.parse(JSON.stringify(cfg)),executionPlans:[]});
 assert.equal(after.executionPlans.length,MAX_RESEARCH_PLANS);assert.deepEqual(validateConfig(after),[]);
 assert.equal(fs.statSync(file).mode&0o777,0o600);
 const saved=fs.readFileSync(file,'utf8');assert.equal(expandEntryContracts(file).changed,false);assert.equal(fs.readFileSync(file,'utf8'),saved);
 after.executionPlans.at(-1).label='operator edit';fs.writeFileSync(file,JSON.stringify(after));
 assert.throws(()=>expandEntryContracts(file),/will not be overwritten/);
});
test('each selected cell has identical execution and distinct reader evidence; existing cells remain separate',t=>{
 const {cfg}=fixture(t);assert.equal(EXPANSION_CELLS.length,12);assert.equal(EXPANSION_PLANS.length,24);
 assert.equal(new Set([...CONTRACT_PLANS,...EXPANSION_PLANS].map(p=>p.id)).size,30);
 for(let i=0;i<24;i+=2){const a=EXPANSION_PLANS[i],b=EXPANSION_PLANS[i+1];
  assert.equal(a.comparison!.group,b.comparison!.group);assert.equal(a.comparison!.role,'control');assert.equal(b.comparison!.role,'candidate');
  const x=planSnapshot(cfg,a),y=planSnapshot(cfg,b);assert.deepEqual(x.paper,y.paper);assert.equal(x.exitMode,y.exitMode);assert.notEqual(x.signature,y.signature);
  assert.equal(a.enabled,true);assert.equal(a.variant,'current');assert.equal(a.readingOverride?.signalContract,undefined);
  assert.ok(b.readingOverride?.signalContract);assert.equal(b.readingOverride.reader,2);
 }
});
test('activation refuses production, disabled shadow and capacity overflow without writing',t=>{
 const {file,cfg}=fixture(t);
 for(const mutate of [(c:typeof cfg)=>{c.execution.allowProduction=true;},(c:typeof cfg)=>{c.incubator.enabled=false;},(c:typeof cfg)=>{c.executionPlans!.push({...CONTRACT_PLANS[0],id:'overflow',comparison:undefined});}]){
  const c=structuredClone(cfg);mutate(c);fs.writeFileSync(file,JSON.stringify(c));const before=fs.readFileSync(file,'utf8');
  assert.throws(()=>expandEntryContracts(file));assert.equal(fs.readFileSync(file,'utf8'),before);
 }
});
