import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DEFAULT_CONFIG,validateConfig} from '../src/config.ts';
import {removePromotionCountCaps} from '../../ops/remove-promotion-count-caps.ts';

test('promotion quota migration changes one flag only, is private/idempotent, and refuses production',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'promotion-caps-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json'),cfg=structuredClone(DEFAULT_CONFIG);cfg.scanners={};
 delete cfg.incubator.promote.countLimitsEnabled;
 const raw=JSON.stringify(cfg);fs.writeFileSync(file,raw,{mode:0o600});
 assert.equal(removePromotionCountCaps(file,true).changed,true);assert.equal(fs.readFileSync(file,'utf8'),raw);assert.equal(fs.readdirSync(dir).length,1);
 assert.equal(removePromotionCountCaps(file).changed,true);
 const after=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(after.incubator.promote.countLimitsEnabled,false);
 delete after.incubator.promote.countLimitsEnabled;assert.deepEqual(after,cfg);
 assert.equal(fs.statSync(file).mode&0o777,0o600);const count=fs.readdirSync(dir).length;
 assert.equal(removePromotionCountCaps(file).changed,false);assert.equal(fs.readdirSync(dir).length,count);
 for(const patch of [{mode:'testnet'},{allowProduction:true}]){
  fs.writeFileSync(file,JSON.stringify({...cfg,execution:{...cfg.execution,...patch}}));assert.throws(()=>removePromotionCountCaps(file),/locked paper/);
 }
 assert.ok(validateConfig({...cfg,incubator:{...cfg.incubator,promote:{...cfg.incubator.promote,countLimitsEnabled:'false' as any}}}).some(e=>e.includes('countLimitsEnabled')));
});
