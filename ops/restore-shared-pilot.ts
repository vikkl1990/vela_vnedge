#!/usr/bin/env node
/** Remove only the horizon split. Run with the service stopped; --dry-run makes no writes. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {ConfigStore,validateConfig} from '../server/src/config.ts';
export function restoreSharedPilot(file:string,dryRun=false){
 const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
 const pilot=cfg.incubator.mirror?.pilot;
 if(cfg.execution.mode!=='paper'||!pilot)throw Error('Requires a configured paper pilot');
 const next=structuredClone(raw),shared={...pilot};delete shared.byHorizon;
 const errors=validateConfig({...cfg,incubator:{...cfg.incubator,mirror:{...cfg.incubator.mirror!,pilot:shared}}});
 if(errors.length)throw Error('Configuration validation failed: '+errors.join('; '));
 const changed=Object.hasOwn(next.incubator.mirror.pilot,'byHorizon');delete next.incubator.mirror.pilot.byHorizon;
 if(dryRun||!changed)return {changed,dryRun,mode:'shared',maxOpenPositions:pilot.maxOpenPositions,maxDailyEntries:pilot.maxDailyEntries};
 if(fs.readFileSync(file,'utf8')!==before)throw Error('Configuration changed during migration; retry with service stopped');
 const backup=`${file}.before-shared-pilot-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;
 fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
 try{fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{mode:fs.statSync(file).mode&0o777,flag:'wx'});fs.renameSync(tmp,file);}
 finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return {changed,dryRun,backup,mode:'shared',maxOpenPositions:pilot.maxOpenPositions,maxDailyEntries:pilot.maxDailyEntries};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const file=process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json');
 console.log(JSON.stringify(restoreSharedPilot(file,process.argv.includes('--dry-run'))));
}
