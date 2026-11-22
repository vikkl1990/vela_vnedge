#!/usr/bin/env node
/** Shadow reference only. Run after stopping the service; --dry-run writes nothing. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {ConfigStore,validateConfig} from '../server/src/config.ts';
import {planSnapshot} from '../server/src/paper/executionPlans.ts';
import {SOL_MAKER_REFERENCE,SOL_MAKER_TICK_REFERENCE,SOL_MAKER_SCANNER} from '../server/src/research/solMakerStudy.ts';
export function enableSolMakerStudy(file:string,dryRun=false,tickDepth=false){
 const plan=tickDepth?{...SOL_MAKER_TICK_REFERENCE,enabled:true}:SOL_MAKER_REFERENCE;
 const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
 if(cfg.execution.mode!=='paper'||cfg.execution.allowProduction||!cfg.incubator.enabled)throw Error('Requires paper mode, production disabled and active incubator');
 if(!cfg.scanners[SOL_MAKER_SCANNER]||!(cfg.paper.maxStopLossPct>0))throw Error('Requires current maker reader and stop-risk cap');
 const snapshot=planSnapshot(cfg,plan);
 if(!snapshot.paper.limitEntry?.enabled||snapshot.paper.limitEntry.atr!==.1)throw Error('Maker entry must retain its reviewed 0.1 ATR resting limit');
 const existing=(raw.executionPlans??[]).find((p:any)=>p.id===plan.id);
 if(existing&&!isDeepStrictEqual(existing,plan))throw Error('Existing SOL reference differs; refusing overwrite');
 const plans=existing?raw.executionPlans:[...(raw.executionPlans??[]),structuredClone(plan)];
 const errors=validateConfig({...cfg,executionPlans:plans});if(errors.length)throw Error(errors.join('; '));
 const changed=!existing;
 if(dryRun||!changed)return {changed,dryRun,plan:plan.id,promotionEligible:false,halfStopMode:'advisory'};
 if(fs.readFileSync(file,'utf8')!==before)throw Error('Configuration changed during migration');
 const backup=`${file}.before-sol-maker-study-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;
 fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
 try{fs.writeFileSync(tmp,JSON.stringify({...raw,executionPlans:plans},null,2)+'\n',{mode:fs.statSync(file).mode&0o777,flag:'wx'});fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return {changed,dryRun,backup,plan:plan.id,promotionEligible:false,halfStopMode:'advisory'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(enableSolMakerStudy(process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json'),process.argv.includes('--dry-run'),process.argv.includes('--tick-depth'))));
