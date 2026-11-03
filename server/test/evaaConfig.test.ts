import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DEFAULT_CONFIG} from '../src/config.ts';
import {enableEvaaReclaim,EVAA_RECLAIM} from '../../ops/enable-evaa-reclaim.ts';

test('EVAA migration is scoped, validated, backed up and idempotent',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vnedge-evaa-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'config.json'),cfg=structuredClone(DEFAULT_CONFIG);
  cfg.paper.marginPerTrade=150;cfg.paper.maxStopLossPct=3;
  cfg.scanners[EVAA_RECLAIM.scannerId]={...cfg.scanners[EVAA_RECLAIM.scannerId],enabled:true,pairs:[{symbol:'EVAAUSD',tf:'15m'}]};
  const other={...EVAA_RECLAIM,symbol:'SOLUSD'};cfg.paper.reclaimTrials=[other];
  const before=JSON.stringify(cfg);fs.writeFileSync(file,before);
  assert.equal(enableEvaaReclaim(file,true).changed,true);assert.equal(fs.readFileSync(file,'utf8'),before);
  const result=enableEvaaReclaim(file);assert.ok(result.backup);assert.equal(fs.readFileSync(result.backup!,'utf8'),before);
  const next=JSON.parse(fs.readFileSync(file,'utf8'));assert.deepEqual(next.paper.reclaimTrials,[other,EVAA_RECLAIM]);
  next.paper.reclaimTrials=[other];assert.deepEqual(next,cfg,'only the requested rule changes');
  assert.equal(enableEvaaReclaim(file).changed,false);
  next.execution.mode='live';fs.writeFileSync(file,JSON.stringify(next));assert.throws(()=>enableEvaaReclaim(file),/paper execution/);
});
