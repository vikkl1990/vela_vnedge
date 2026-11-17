#!/usr/bin/env node
/** Adds prospective shadow arms only. Stop the service before the non-dry-run migration. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {ConfigStore,validateConfig} from '../server/src/config.ts';
import {planSnapshot,type ExecutionPlan} from '../server/src/paper/executionPlans.ts';
import {TWO_BAR_EXIT} from '../server/src/paper/failedTradeExit.ts';
const scannerId='trend-impulse-channels-zeiierman';
export const TWO_BAR_PLANS:ExecutionPlan[]=[['INITUSD','15m'],['PARTIUSD','1h']].flatMap(([symbol,tf])=>
 (['control','candidate'] as const).map(role=>({id:`tic-two-bar-${symbol.toLowerCase()}-${tf}-${role}`,revision:1,enabled:true,
  scannerId,symbol,tf,variant:'current',referenceEquity:1000,
  label:role==='control'?'Two-bar study · unchanged exits':'Two-bar study · failed-trade exit',
  comparison:{group:`tic-two-bar-${symbol.toLowerCase()}-${tf}`,role,kind:'two-bar'},
  ...(role==='candidate'?{failedTradeExit:TWO_BAR_EXIT}:{})})));
export const EVAA_FLOOR_PLANS:ExecutionPlan[]=(['control','candidate'] as const).map(role=>({
 id:`evaa-early-floor-15m-${role}`,revision:1,enabled:true,scannerId:'supertrend-cluster-zeiierman',symbol:'EVAAUSD',tf:'15m',variant:'current',referenceEquity:1000,
 label:role==='control'?'EVAA protection · unchanged exits':'EVAA protection · +0.1R floor after +0.3R',
 comparison:{group:'evaa-early-floor-15m',role,kind:'profit-floor'},...(role==='candidate'?{profitFloor:{afterR:.3,keepR:.1}}:{})
}));
export const EXIT_STUDY_PLANS=[...TWO_BAR_PLANS,...EVAA_FLOOR_PLANS];
export function enableTwoBarShadow(file:string,dryRun=false){
 const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
 if(cfg.execution.mode!=='paper'||cfg.execution.allowProduction||!cfg.incubator.enabled)throw Error('Requires paper mode, production disabled and an active incubator');
 if(!cfg.scanners[scannerId]||!(cfg.paper.maxStopLossPct!>0))throw Error('Requires the existing source scanner and positive stop-risk cap');
 for(const symbol of ['INITUSD','PARTIUSD']){
  const pair=TWO_BAR_PLANS.filter(p=>p.symbol===symbol).map(p=>planSnapshot(cfg,p));
  if(!isDeepStrictEqual(pair[0].paper,pair[1].paper)||pair[0].exitMode!==pair[1].exitMode)throw Error('Entry, sizing and economics must be identical');
  if(pair[0].paper.trailAfterR!==.5||pair[0].paper.trailGiveBackPct!==10||pair[0].paper.floorAtR!==.5||pair[0].paper.floorKeepR!==.25)throw Error('Exit baseline differs from the reviewed replay');
 }
 const evaa=EVAA_FLOOR_PLANS.map(p=>planSnapshot(cfg,p));
 if(!cfg.scanners[EVAA_FLOOR_PLANS[0].scannerId]||evaa[0].paper.trailAfterR!==.5||evaa[0].paper.floorAtR!==.5||evaa[0].paper.floorKeepR!==.25)throw Error('EVAA baseline differs from reviewed protection');
 const beforeFloor={...evaa[0].paper,floorAtR:.3,floorKeepR:.1};
 if(!isDeepStrictEqual(beforeFloor,evaa[1].paper)||evaa[0].exitMode!==evaa[1].exitMode)throw Error('EVAA must differ only in profit floor');
 const ids=new Set(EXIT_STUDY_PLANS.map(p=>p.id));
 for(const p of raw.executionPlans??[])if(ids.has(p.id)&&!isDeepStrictEqual(p,EXIT_STUDY_PLANS.find(x=>x.id===p.id)))throw Error(`Existing plan ${p.id} differs; no overwrite`);
 const plans=[...(raw.executionPlans??[]).filter((p:ExecutionPlan)=>!ids.has(p.id)),...structuredClone(EXIT_STUDY_PLANS)];
 const errors=validateConfig({...cfg,executionPlans:plans});if(errors.length)throw Error(errors.join('; '));
 const next={...raw,executionPlans:plans},changed=!isDeepStrictEqual(raw,next);
 if(dryRun||!changed)return {changed,dryRun,plans:EXIT_STUDY_PLANS.map(p=>p.id),promotionEligible:false};
 if(fs.readFileSync(file,'utf8')!==before)throw Error('Configuration changed during migration');
 const backup=`${file}.before-two-bar-shadow-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;
 fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
 try{fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{mode:fs.statSync(file).mode&0o777,flag:'wx'});fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return {changed,dryRun,backup,plans:EXIT_STUDY_PLANS.map(p=>p.id),promotionEligible:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(enableTwoBarShadow(process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json'),process.argv.includes('--dry-run'))));
