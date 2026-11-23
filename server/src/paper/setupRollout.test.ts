import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {MAX_RESEARCH_PLANS} from './executionPlans.ts';
import {RETIRED_SETUP_PLANS,enableSetupComparisons} from '../../../ops/enable-setup-comparisons.ts';

function fixture(t:TestContext){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'setup-rollout-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const cfg=structuredClone(DEFAULT_CONFIG);cfg.execution.mode='paper';cfg.execution.allowProduction=false;cfg.incubator.enabled=true;
  cfg.scanners.native={enabled:false,symbols:null,timeframes:null,reader:2,exitMode:'both',entryExecution:'market'};
  cfg.scanners.maker={enabled:true,symbols:null,timeframes:null,reader:2,exitMode:'both'};
  const base={revision:1,enabled:true,scannerId:'native',symbol:'ETHUSD',tf:'15m',variant:'current' as const,referenceEquity:1000,readingOverride:{version:1,reader:2 as const}};
  cfg.executionPlans=[{...base,id:'author-strat-eth-15m-v1'},{...base,id:'reader-liquidity-aiot-15m-candidate',scannerId:'maker'},
    ...RETIRED_SETUP_PLANS.map(id=>({...base,id})),...Array.from({length:MAX_RESEARCH_PLANS-6},(_,i)=>({...base,id:`other-${i}`}))];
  const file=path.join(dir,'config.json'),dbFile=path.join(dir,'vnedge.db');fs.writeFileSync(file,JSON.stringify(cfg));
  const db=new Db(dbFile);db.run('CREATE TABLE execution_plan_events(id INTEGER PRIMARY KEY,plan_id TEXT,at INTEGER)');t.after(()=>db.db.close());
  const source=()=>({status:'ok',patched:'reviewed source'});
  return {cfg,file,dbFile,db,source,save:()=>fs.writeFileSync(file,JSON.stringify(cfg)),run:(dry=false,hash?:string)=>enableSetupComparisons(file,dbFile,dry,hash,source)};
}
test('activation rotates four idle plans within capacity, preserves settings, and is idempotent',t=>{
  const x=fixture(t),before=fs.readFileSync(x.file,'utf8');assert.equal(x.run(true).totalPlans,MAX_RESEARCH_PLANS);assert.equal(fs.readFileSync(x.file,'utf8'),before);
  const result=x.run();assert.equal(result.changed,true);const next=JSON.parse(fs.readFileSync(x.file,'utf8'));
  assert.deepEqual({...next,executionPlans:[]},{...x.cfg,executionPlans:[]});assert.equal(next.executionPlans.length,MAX_RESEARCH_PLANS);
  assert.equal(next.executionPlans.filter((p:any)=>p.setupLifecycle).length,2);
  assert.equal(x.run().changed,false);assert.ok('backup' in result);assert.ok(fs.existsSync(result.backup));
});
test('activation refuses held or partially filled retirement plans and recent evidence',t=>{
  for(const status of ['open','pending']){
    const x=fixture(t),before=fs.readFileSync(x.file,'utf8');
    x.db.run("INSERT INTO positions(scanner_id,scanner_name,symbol,tf,side,status,qty,qty_open,contract_value,entry_price,entry_at,bt,fills) VALUES('s','s','ETHUSD','15m','long',?,1,1,1,100,1,2,?)",status,JSON.stringify(status==='open'?{executionPlan:{id:RETIRED_SETUP_PLANS[0]}}:{limitEntry:{executionPlan:{id:RETIRED_SETUP_PLANS[0]}}}));
    assert.throws(()=>x.run(),/Cannot retire held plan/);assert.equal(fs.readFileSync(x.file,'utf8'),before);
  }
  const x=fixture(t);x.db.run('INSERT INTO execution_plan_events(plan_id,at) VALUES(?,?)',RETIRED_SETUP_PLANS[0],Date.now());assert.throws(()=>x.run(),/recent signal evidence/);
});
test('activation rejects config drift, edited installs, unavailable sources and production mode',t=>{
  const x=fixture(t);assert.throws(()=>x.run(true,'wrong'),/changed since preflight/);
  const hash=createHash('sha256').update(fs.readFileSync(x.file)).digest('hex');assert.equal(x.run(true,hash).changed,true);
  assert.throws(()=>enableSetupComparisons(x.file,x.dbFile,true,undefined,()=>({status:'incompatible',patched:''})),/Source unavailable/);
  x.cfg.execution.allowProduction=true;x.save();assert.throws(()=>x.run(),/paper-only/);
  x.cfg.execution.allowProduction=false;x.save();x.run();const next=JSON.parse(fs.readFileSync(x.file,'utf8'));next.executionPlans.at(-1).label='operator edit';fs.writeFileSync(x.file,JSON.stringify(next));assert.throws(()=>x.run(),/will not be overwritten/);
});
