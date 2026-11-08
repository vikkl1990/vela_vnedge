#!/usr/bin/env node
/** Apply the reviewed capacity split only. Run with the service stopped; --dry-run is read-only. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {ConfigStore,validateConfig} from '../server/src/config.ts';
export const PILOT_HORIZONS={scalp:{maxOpenPositions:1,maxDailyEntries:8},swing:{maxOpenPositions:1,maxDailyEntries:2}};
export function enablePilotHorizons(file:string,dryRun=false){
 const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
 const pilot=cfg.incubator.mirror?.pilot;
 if(cfg.execution.mode!=='paper'||!cfg.incubator.mirror?.enabled||!pilot)throw Error('Requires an enabled paper copy pilot');
 if(cfg.paper.marginPerTrade!==150||cfg.risk.reentryCooldownMinutes!==60||!cfg.risk.enabled)throw Error('Margin or cooldown policy differs from the reviewed configuration');
 if(pilot.maxOpenPositions!==2||pilot.maxDailyEntries!==10||Math.abs(pilot.sizeScale-1/3)>1e-12)throw Error('Pilot budget differs from the reviewed 2-slot/10-entry/one-third-size budget');
 if(pilot.byHorizon&&!isDeepStrictEqual(pilot.byHorizon,PILOT_HORIZONS))throw Error('Existing horizon split differs; review before changing it');
 const next=structuredClone(raw);next.incubator.mirror.pilot.byHorizon=structuredClone(PILOT_HORIZONS);
 const errors=validateConfig({...cfg,incubator:{...cfg.incubator,mirror:{...cfg.incubator.mirror,pilot:{...pilot,byHorizon:PILOT_HORIZONS}}}});
 if(errors.length)throw Error('Configuration validation failed: '+errors.join('; '));
 const changed=!isDeepStrictEqual(raw,next);
 if(dryRun||!changed)return {changed,dryRun,byHorizon:PILOT_HORIZONS};
 if(fs.readFileSync(file,'utf8')!==before)throw Error('Configuration changed during migration; retry with service stopped');
 const backup=`${file}.before-pilot-horizons-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;
 fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
 try{fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{mode:fs.statSync(file).mode&0o777,flag:'wx'});fs.renameSync(tmp,file);}
 finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return {changed,dryRun,backup,byHorizon:PILOT_HORIZONS};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const file=process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json');
 console.log(JSON.stringify(enablePilotHorizons(file,process.argv.includes('--dry-run'))));
}
