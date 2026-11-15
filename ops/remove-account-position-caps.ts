#!/usr/bin/env node
/** Operator-authorized removal of the two eight-position ceilings. Stop service before writing. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ConfigStore,validateConfig} from '../server/src/config.ts';

export function removeAccountPositionCaps(file:string,dryRun=false){
 const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
 if(cfg.execution.mode!=='paper')throw Error('Requires paper mode');
 if(![0,8].includes(cfg.paper.maxOpenPositions)||![0,8].includes(cfg.risk.maxPositionsTotal))throw Error('Count ceilings differ from the reviewed eight-position settings');
 const next={...raw,paper:{...raw.paper,maxOpenPositions:0},risk:{...raw.risk,maxPositionsTotal:0}};
 const errors=validateConfig({...cfg,paper:{...cfg.paper,maxOpenPositions:0},risk:{...cfg.risk,maxPositionsTotal:0}});
 if(errors.length)throw Error(errors.join('; '));
 const changed=cfg.paper.maxOpenPositions!==0||cfg.risk.maxPositionsTotal!==0;
 const result={changed,dryRun,maxOpenPositions:0,maxPositionsTotal:0,note:'Only account-wide count limits removed. Margin, loss limits, per-market/per-scanner caps and evidence rules remain. Exact account-policy qualification starts under the new configuration.'};
 if(dryRun||!changed)return result;
 if(fs.readFileSync(file,'utf8')!==before)throw Error('Configuration changed during migration');
 const backup=`${file}.before-account-position-caps-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;
 fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
 try{fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{mode:fs.statSync(file).mode&0o777,flag:'wx'});fs.renameSync(tmp,file);}
 finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return {...result,backup};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
 console.log(JSON.stringify(removeAccountPositionCaps(process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json'),process.argv.includes('--dry-run'))));
