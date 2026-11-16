#!/usr/bin/env node
/** Explicit operator request: remove allocation-count quotas without changing trade or evidence policy. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ConfigStore,validateConfig} from '../server/src/config.ts';

export function removePromotionCountCaps(file:string,dryRun=false){
 const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
 if(cfg.execution.mode!=='paper'||cfg.execution.allowProduction)throw Error('Requires locked paper mode');
 const next={...raw,incubator:{...raw.incubator,promote:{...raw.incubator.promote,countLimitsEnabled:false}}};
 const errors=validateConfig({...cfg,incubator:{...cfg.incubator,promote:{...cfg.incubator.promote,countLimitsEnabled:false}}});
 if(errors.length)throw Error(errors.join('; '));
 const changed=cfg.incubator.promote.countLimitsEnabled!==false;
 const result={changed,dryRun,countLimitsEnabled:false,note:'Allocation count quotas removed. Trade policy, risk, capital, evidence and worker capacity unchanged.'};
 if(dryRun||!changed)return result;
 if(fs.readFileSync(file,'utf8')!==before)throw Error('Configuration changed during migration');
 const backup=`${file}.before-promotion-count-caps-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;
 fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
 try{fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);}
 finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return {...result,backup};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
 console.log(JSON.stringify(removePromotionCountCaps(process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json'),process.argv.includes('--dry-run'))));
