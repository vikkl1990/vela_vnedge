import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {DEFAULT_CONFIG} from '../config.ts';
import {relaxGates} from '../../../ops/relax-gates.ts';

test('the three entry guards ship off by default, the real limits stay',()=>{
 assert.equal(DEFAULT_CONFIG.risk.reentryCooldownMinutes,0);assert.equal(DEFAULT_CONFIG.risk.burstWindowSec,0);
 assert.equal(DEFAULT_CONFIG.risk.maxPositionsTotal,8);assert.equal(DEFAULT_CONFIG.risk.maxDailyLossPct,15);assert.equal(DEFAULT_CONFIG.risk.perScannerMaxPositions,4);
});
test('relaxing touches only the three guards, with a private backup, dry run and idempotency; never a non-paper config',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vnedge-relax-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json'),cfg=structuredClone(DEFAULT_CONFIG);
 Object.assign(cfg.risk,{reentryCooldownMinutes:60,burstWindowSec:120,maxPositionsTotal:8,maxPositionsPerSymbol:1});
 cfg.risk.regime={enabled:true,minAtrPct:0.3,noWeekend:false,exempt:[],minEr:0.1};
 const before=JSON.stringify(cfg);fs.writeFileSync(file,before);
 const dry=relaxGates(file,true);assert.equal(dry.changed,true);assert.deepEqual(dry.was,{reentryCooldownMinutes:60,burstWindowSec:120,minEr:0.1});
 assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(fs.readdirSync(dir).length,1);
 const done=relaxGates(file);assert.equal(fs.readFileSync(done.backup!,'utf8'),before);assert.equal(fs.statSync(done.backup!).mode&0o777,0o600);
 const next=JSON.parse(fs.readFileSync(file,'utf8')),expected=structuredClone(cfg);
 Object.assign(expected.risk,{reentryCooldownMinutes:0,burstWindowSec:0});expected.risk.regime!.minEr=0;
 assert.deepEqual(next,expected);
 assert.equal(next.risk.regime.minAtrPct,0.3);assert.equal(next.risk.maxPositionsTotal,8);assert.equal(next.risk.maxPositionsPerSymbol,1);
 assert.equal(relaxGates(file).changed,false);
 cfg.execution.mode='live' as any;fs.writeFileSync(file,JSON.stringify(cfg));assert.throws(()=>relaxGates(file),/paper/);
});
