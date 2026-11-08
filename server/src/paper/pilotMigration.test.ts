import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {DEFAULT_CONFIG} from '../config.ts';
import {enablePilotHorizons,PILOT_HORIZONS} from '../../../ops/enable-pilot-horizons.ts';
test('pilot split migration is narrow, backed up, idempotent and rejects capital/mode drift',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vnedge-pilot-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json'),cfg=structuredClone(DEFAULT_CONFIG);
 cfg.paper.marginPerTrade=150;cfg.risk.reentryCooldownMinutes=60;cfg.risk.enabled=true;
 cfg.incubator.mirror={enabled:true,minTrades:5,minNetR:0,pilot:{sizeScale:1/3,maxOpenPositions:2,maxDailyEntries:10}};
 const before=JSON.stringify(cfg);fs.writeFileSync(file,before);
 assert.equal(enablePilotHorizons(file,true).changed,true);assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(fs.readdirSync(dir).length,1);
 const done=enablePilotHorizons(file);assert.equal(fs.readFileSync(done.backup!,'utf8'),before);assert.equal(fs.statSync(done.backup!).mode&0o777,0o600);
 const next=JSON.parse(fs.readFileSync(file,'utf8'));assert.deepEqual(next.incubator.mirror.pilot.byHorizon,PILOT_HORIZONS);delete next.incubator.mirror.pilot.byHorizon;assert.deepEqual(next,cfg);
 assert.equal(enablePilotHorizons(file).changed,false);
 for(const mutate of [(c:typeof cfg)=>c.execution.mode='live',(c:typeof cfg)=>c.paper.marginPerTrade=200,(c:typeof cfg)=>c.incubator.mirror!.pilot!.maxOpenPositions=3]){
  const changed=structuredClone(cfg);mutate(changed);fs.writeFileSync(file,JSON.stringify(changed));assert.throws(()=>enablePilotHorizons(file));assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),changed);
 }
});

test('removing horizon quotas preserves every other setting, backs up and is idempotent',async t=>{
 const{restoreSharedPilot}=await import('../../../ops/restore-shared-pilot.ts');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vnedge-shared-pilot-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json'),cfg=structuredClone(DEFAULT_CONFIG);
 cfg.paper.marginPerTrade=150;cfg.incubator.mirror={enabled:true,minTrades:5,minNetR:0,pilot:{sizeScale:1/3,maxOpenPositions:2,maxDailyEntries:10,byHorizon:structuredClone(PILOT_HORIZONS)}};
 const before=JSON.stringify(cfg);fs.writeFileSync(file,before);
 assert.equal(restoreSharedPilot(file,true).changed,true);assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(fs.readdirSync(dir).length,1);
 const done=restoreSharedPilot(file);assert.equal(fs.readFileSync(done.backup!,'utf8'),before);
 const expected=structuredClone(cfg);delete expected.incubator.mirror!.pilot!.byHorizon;
 assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),expected);assert.equal(restoreSharedPilot(file).changed,false);
 assert.equal(fs.statSync(done.backup!).mode&0o777,0o600);
 cfg.execution.mode='live';fs.writeFileSync(file,JSON.stringify(cfg));assert.throws(()=>restoreSharedPilot(file),/paper/);
});
