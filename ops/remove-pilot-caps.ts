#!/usr/bin/env node
/** Remove pilot-only quotas; preserve sizing and account limits. Run with service stopped. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ConfigStore,validateConfig} from '../server/src/config.ts';

export function removePilotCaps(file:string,dryRun=false){
 const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
 const pilot=cfg.incubator.mirror?.pilot;
 if(cfg.execution.mode!=='paper'||!pilot)throw Error('Requires a configured paper pilot');
 const next=structuredClone(raw),shared={...pilot,maxDailyEntries:0,maxOpenPositions:0};delete shared.byHorizon;
 const errors=validateConfig({...cfg,incubator:{...cfg.incubator,mirror:{...cfg.incubator.mirror!,pilot:shared}}});
 if(errors.length)throw Error('Configuration validation failed: '+errors.join('; '));
 const changed=pilot.maxDailyEntries!==0||pilot.maxOpenPositions!==0||Object.hasOwn(pilot,'byHorizon');
 Object.assign(next.incubator.mirror.pilot,{maxDailyEntries:0,maxOpenPositions:0});delete next.incubator.mirror.pilot.byHorizon;
 if(dryRun||!changed)return {changed,dryRun,maxOpenPositions:0,maxDailyEntries:0,sizeScale:pilot.sizeScale};
 if(fs.readFileSync(file,'utf8')!==before)throw Error('Configuration changed during migration; retry with service stopped');
 const backup=`${file}.before-remove-pilot-caps-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;
 fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
 try{fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{mode:fs.statSync(file).mode&0o777,flag:'wx'});fs.renameSync(tmp,file);}
 finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return {changed,dryRun,backup,maxOpenPositions:0,maxDailyEntries:0,sizeScale:pilot.sizeScale};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const file=process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json');
 console.log(JSON.stringify(removePilotCaps(file,process.argv.includes('--dry-run'))));
}
