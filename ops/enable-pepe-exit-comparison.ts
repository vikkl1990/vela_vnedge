#!/usr/bin/env node
/** Enable only the two forward research plans; run with the service stopped. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {ConfigStore,validateConfig} from '../server/src/config.ts';
import {planSnapshot,type ExecutionPlan} from '../server/src/paper/executionPlans.ts';

const source='trend-impulse-channels-zeiierman',group='pepe-impulse-profit-capture';
export const PEPE_EXIT_PLANS:ExecutionPlan[]=[
  {id:'tic-pepe-15m-exit-control',label:'Current exits · control',revision:1,enabled:true,scannerId:source,symbol:'1000PEPEUSD',tf:'15m',variant:'current',referenceEquity:1000,maxStopLossPct:1,comparison:{group,role:'control'}},
  {id:'tic-pepe-15m-exit-runner',label:'Later trailing · candidate',revision:1,enabled:true,scannerId:source,symbol:'1000PEPEUSD',tf:'15m',variant:'current',referenceEquity:1000,maxStopLossPct:1,comparison:{group,role:'candidate'},trailing:{afterR:1,giveBackPct:20,floorAtR:1,floorKeepR:.5}},
];

export function enablePepeExitComparison(file:string,dryRun=false){
  const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
  if(cfg.execution.mode!=='paper')throw Error('PEPE comparison requires paper execution');
  if(!cfg.incubator.enabled)throw Error('PEPE comparison requires the incubator source scheduler');
  if(cfg.paper.marginPerTrade!==150)throw Error('expected the reviewed $150 margin policy');
  if(!cfg.scanners[source])throw Error('PEPE source scanner configuration is missing');
  const control=planSnapshot(cfg,PEPE_EXIT_PLANS[0]);
  if(!control.requireAtrStop||control.paper.trailAfterR!==.5||control.paper.trailGiveBackPct!==10||control.paper.floorAtR!==.5||control.paper.floorKeepR!==.25||control.paper.trailAtrMult!==0)throw Error('current scanner/exit policy differs from the tested control; review before enabling');
  const ids=new Set(PEPE_EXIT_PLANS.map(p=>p.id));
  // Never overwrite an independently edited or newer experiment under the same id.
  for(const p of raw.executionPlans??[])if(ids.has(p.id)&&!isDeepStrictEqual(p,PEPE_EXIT_PLANS.find(x=>x.id===p.id)))throw Error(`existing ${p.id} differs from the reviewed experiment`);
  const plans=[...(raw.executionPlans??[]).filter((p:ExecutionPlan)=>!ids.has(p.id)),...structuredClone(PEPE_EXIT_PLANS)];
  const errors=validateConfig({...cfg,executionPlans:plans});
  if(errors.length)throw Error('configuration validation failed: '+errors.join('; '));
  const next={...raw,executionPlans:plans},changed=JSON.stringify(raw)!==JSON.stringify(next);
  if(dryRun||!changed)return {changed,dryRun,plans:PEPE_EXIT_PLANS};
  if(fs.readFileSync(file,'utf8')!==before)throw Error('config changed during migration; retry with service stopped');
  const backup=`${file}.before-pepe-exit-comparison-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
  try{fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{mode:fs.statSync(file).mode&0o777,flag:'wx'});fs.renameSync(tmp,file);}
  finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
  return {changed,dryRun,backup,plans:PEPE_EXIT_PLANS};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const file=process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json');
  console.log(JSON.stringify(enablePepeExitComparison(file,process.argv.includes('--dry-run'))));
}
