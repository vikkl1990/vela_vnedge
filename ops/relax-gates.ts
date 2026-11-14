#!/usr/bin/env node
/**
 * Decision 267: switch off the three account entry guards the books' own record shows do not select better trades:
 * the pair re-entry cooldown (`risk.reentryCooldownMinutes`), the one-entry-per-side burst guard (`risk.burstWindowSec`) and
 * the whipsaw gate (`risk.regime.minEr`). Everything that protects against real risk or an unrealistic fill stays.
 * Run with the service stopped; --dry-run is read-only. Writes a timestamped backup next to the config.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {ConfigStore,validateConfig} from '../server/src/config.ts';
export const RELAXED={reentryCooldownMinutes:0,burstWindowSec:0,minEr:0};
export function relaxGates(file:string,dryRun=false){
 const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
 if(cfg.execution.mode!=='paper')throw Error('Only a paper configuration may be relaxed with this script');
 const next=structuredClone(raw);
 next.risk={...(next.risk??{}),reentryCooldownMinutes:RELAXED.reentryCooldownMinutes,burstWindowSec:RELAXED.burstWindowSec,
  regime:{...(next.risk?.regime??cfg.risk.regime??{}),minEr:RELAXED.minEr}};
 const errors=validateConfig({...cfg,risk:{...cfg.risk,reentryCooldownMinutes:0,burstWindowSec:0,regime:{...cfg.risk.regime!,minEr:0}}});
 if(errors.length)throw Error('Configuration validation failed: '+errors.join('; '));
 const was={reentryCooldownMinutes:cfg.risk.reentryCooldownMinutes,burstWindowSec:cfg.risk.burstWindowSec,minEr:cfg.risk.regime?.minEr??0};
 const changed=!isDeepStrictEqual(raw,next);
 if(dryRun||!changed)return {changed,dryRun,was,now:RELAXED};
 if(fs.readFileSync(file,'utf8')!==before)throw Error('Configuration changed during migration; retry with service stopped');
 const backup=`${file}.before-relax-gates-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;
 fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
 try{fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{mode:fs.statSync(file).mode&0o777,flag:'wx'});fs.renameSync(tmp,file);}
 finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return {changed,dryRun,backup,was,now:RELAXED};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const file=process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json');
 console.log(JSON.stringify(relaxGates(file,process.argv.includes('--dry-run'))));
}
