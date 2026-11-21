#!/usr/bin/env node
/** Enable only the four isolated SOL filter/fill arms. Stop the service before applying. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {ConfigStore,validateConfig} from '../server/src/config.ts';
import {planSnapshot} from '../server/src/paper/executionPlans.ts';
import {SOL_FILTER_PLANS} from '../server/src/research/solTrendFilterStudy.ts';
import {SOL_MAKER_FILTER_OFF,SOL_MAKER_FILTER_SOURCE} from '../server/src/scanners/solMakerExperiment.ts';
export function enableSolTrendFilter(file:string,dryRun=false){
 const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
 if(cfg.execution.mode!=='paper'||cfg.execution.allowProduction||!cfg.incubator.enabled)throw Error('Requires paper mode, production disabled and active incubator');
 const source=cfg.scanners[SOL_MAKER_FILTER_SOURCE];
 if(!source||!(cfg.paper.maxStopLossPct>0)||source.inputs?.TrendFilter===false||source.inputs?.['Filter by Trend']!==undefined)throw Error('Requires current filter-on maker policy and stop-risk cap');
 const candidate={...structuredClone(source),enabled:false,hidden:false,symbols:null,timeframes:null,pairs:[],inputs:{...source.inputs,TrendFilter:false}};
 if(raw.scanners?.[SOL_MAKER_FILTER_OFF]&&!isDeepStrictEqual(raw.scanners[SOL_MAKER_FILTER_OFF],candidate))throw Error('Existing filter-off scanner differs; refusing overwrite');
 const plans=[...(raw.executionPlans??[])];let changed=!raw.scanners?.[SOL_MAKER_FILTER_OFF];
 for(const p of SOL_FILTER_PLANS){
  const old=plans.find((x:any)=>x.id===p.id);
  if(old&&!isDeepStrictEqual(old,p))throw Error('Existing filter study plan differs; refusing overwrite');
  if(!old){plans.push(structuredClone(p));changed=true;}
 }
 const next={...raw,scanners:{...raw.scanners,[SOL_MAKER_FILTER_OFF]:candidate},executionPlans:plans};
 const effective={...cfg,scanners:{...cfg.scanners,[SOL_MAKER_FILTER_OFF]:candidate},executionPlans:plans};
 const errors=validateConfig(effective);if(errors.length)throw Error(errors.join('; '));
 const snapshots=SOL_FILTER_PLANS.map(p=>planSnapshot(effective,p));
 if(snapshots.some(p=>!isDeepStrictEqual(p.paper,snapshots[0].paper)||p.exitMode!==snapshots[0].exitMode))throw Error('Filter arms differ in execution, exit or risk policy');
 if(!snapshots[0].paper.limitEntry?.enabled||snapshots[0].paper.limitEntry.atr!==.1)throw Error('Requires unchanged 0.1 ATR maker pricing');
 if(dryRun||!changed)return {changed,dryRun,plans:SOL_FILTER_PLANS.map(p=>p.id),promotionEligible:false};
 if(fs.readFileSync(file,'utf8')!==before)throw Error('Configuration changed during migration');
 const backup=`${file}.before-sol-filter-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;
 fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
 try{fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{mode:fs.statSync(file).mode&0o777,flag:'wx'});fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return {changed,dryRun,backup,plans:SOL_FILTER_PLANS.map(p=>p.id),promotionEligible:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(enableSolTrendFilter(process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json'),process.argv.includes('--dry-run'))));

