#!/usr/bin/env node
/** Stop service before applying. Only executionPlans changes; dry-run never writes. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {ConfigStore,validateConfig} from '../server/src/config.ts';
import {planSnapshot} from '../server/src/paper/executionPlans.ts';
import {MAKER_UNIVERSE_PLANS} from '../server/src/research/makerUniverseStudy.ts';

export function enableMakerUniverseStudy(file:string,dryRun=false){
  const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
  if(cfg.execution.mode!=='paper'||cfg.execution.allowProduction||!cfg.incubator.enabled)throw Error('Requires paper mode, production disabled and active incubator');
  if(!(cfg.paper.maxStopLossPct>0))throw Error('Requires existing stop-risk cap');
  const plans=structuredClone(raw.executionPlans??[]);
  let added=0;
  for(const plan of MAKER_UNIVERSE_PLANS){
    if(!cfg.scanners[plan.scannerId])throw Error(`Missing configured source: ${plan.scannerId}`);
    const snapshot=planSnapshot(cfg,plan);
    if(!snapshot.paper.limitEntry?.enabled)throw Error(`Source is no longer a resting maker: ${plan.id}`);
    const old=plans.find((p: {id:string})=>p.id===plan.id);
    if(old&&!isDeepStrictEqual(old,plan))throw Error(`Existing plan differs; refusing overwrite: ${plan.id}`);
    if(!old){plans.push(structuredClone(plan));added++;}
  }
  const errors=validateConfig({...cfg,executionPlans:plans});if(errors.length)throw Error(errors.join('; '));
  const report={changed:added>0,dryRun,added,total:plans.length,promotionEligible:false,paperChanged:false};
  if(dryRun||!added)return report;
  if(fs.readFileSync(file,'utf8')!==before)throw Error('Configuration changed during migration');
  const backup=`${file}.before-maker-universe-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
  try{
    fs.writeFileSync(tmp,JSON.stringify({...raw,executionPlans:plans},null,2)+'\n',{mode:fs.statSync(file).mode&0o777,flag:'wx'});
    fs.renameSync(tmp,file);
  }finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
  return {...report,backup};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  console.log(JSON.stringify(enableMakerUniverseStudy(process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json'),process.argv.includes('--dry-run'))));
