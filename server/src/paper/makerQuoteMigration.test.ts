import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DEFAULT_CONFIG} from '../config.ts';
import {enableLabQuoteMaker} from '../ops/enableLabQuoteMaker.ts';

test('LAB opt-in migration preserves every existing config value, is private and idempotent, and refuses mode or capital drift',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lab-maker-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json'),cfg=structuredClone(DEFAULT_CONFIG);
 cfg.execution.mode='paper';cfg.execution.allowProduction=false;cfg.paper.marginPerTrade=150;cfg.paper.maxStopLossPct=3;
 const before=JSON.stringify(cfg,null,2);fs.writeFileSync(file,before,{mode:0o600});
 assert.equal(enableLabQuoteMaker(file,true).changed,true);assert.equal(fs.readFileSync(file,'utf8'),before);
 const r=enableLabQuoteMaker(file);assert.equal(r.changed,true);assert.equal(fs.statSync(r.backup!).mode&0o777,0o600);
 assert.equal(fs.readFileSync(r.backup!,'utf8'),before);
 const after=JSON.parse(fs.readFileSync(file,'utf8'));assert.deepEqual(after.paper.makerQuoteCells,[{scannerId:'macd',symbol:'LABUSD',tf:'1h'}]);
 delete after.paper.makerQuoteCells;assert.deepEqual(after,cfg);
 assert.equal(enableLabQuoteMaker(file).changed,false);
 for(const over of [{execution:{...cfg.execution,mode:'live'}},{execution:{...cfg.execution,allowProduction:true}},{paper:{...cfg.paper,marginPerTrade:200}},{paper:{...cfg.paper,maxStopLossPct:4}}]){
  const value=JSON.stringify({...cfg,...over});fs.writeFileSync(file,value);
  assert.throws(()=>enableLabQuoteMaker(file),/Expected paper mode/);assert.equal(fs.readFileSync(file,'utf8'),value);
 }
});
