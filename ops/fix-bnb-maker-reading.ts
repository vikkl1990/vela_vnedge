#!/usr/bin/env node
/** Stop service before applying. Retire only the two unused BNB maker-study revisions. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {ConfigStore,loadSpecs,validateConfig} from '../server/src/config.ts';
import {planSnapshot} from '../server/src/paper/executionPlans.ts';
import {MAKER_UNIVERSE_PLANS} from '../server/src/research/makerUniverseStudy.ts';

export const BNB_MAKER_READER='half-trend-channel-maker-reversals';
export function fixBnbMakerReading(file:string,dryRun=false){
 const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
 if(cfg.execution.mode!=='paper'||cfg.execution.allowProduction||!cfg.incubator.enabled)throw Error('Requires paper-only research');
 const originals=MAKER_UNIVERSE_PLANS.filter(p=>p.comparison?.group==='maker-v2-bnb-channel');
 const plans=structuredClone(raw.executionPlans??[]);
 const corrected=originals.map(p=>({...p,scannerId:BNB_MAKER_READER,revision:2}));
 const scanner={...cfg.scanners['half-trend-channel'],...loadSpecs()[BNB_MAKER_READER],hidden:true,symbols:null,timeframes:null};
 delete scanner.pairs;
 if(scanner.reader!==2)throw Error('Missing corrected reader contract');
 if(raw.scanners?.[BNB_MAKER_READER]&&!isDeepStrictEqual(raw.scanners[BNB_MAKER_READER],scanner))throw Error('Corrected reader was edited');
 const already=corrected.every(p=>isDeepStrictEqual(plans.find((x:{id:string})=>x.id===p.id),p));
 if(already){
  if(!isDeepStrictEqual(cfg.scanners[BNB_MAKER_READER],scanner))throw Error('Corrected reader was edited');
  return {changed:false,dryRun,paperChanged:false,promotionEligible:false};
 }
 for(let i=0;i<originals.length;i++){
  const index=plans.findIndex((p:{id:string})=>p.id===originals[i].id);
  if(index<0||!isDeepStrictEqual(plans[index],originals[i]))throw Error('Existing BNB maker plan differs; refusing overwrite');
  plans[index]=corrected[i];
 }
 const next={...raw,scanners:{...raw.scanners,[BNB_MAKER_READER]:scanner},executionPlans:plans};
 const effective={...cfg,scanners:{...cfg.scanners,[BNB_MAKER_READER]:scanner},executionPlans:plans};
 const errors=validateConfig(effective);if(errors.length)throw Error(errors.join('; '));
 for(let i=0;i<originals.length;i++){
  const old=planSnapshot(cfg,originals[i]),now=planSnapshot(effective,corrected[i]);
  if(!isDeepStrictEqual(old.paper,now.paper)||old.exitMode!==now.exitMode)throw Error('Entry, fee, exit or risk settings would change');
 }
 for(const p of cfg.executionPlans??[]){
  if(originals.some(x=>x.id===p.id))continue;
  if(planSnapshot(cfg,p).signature!==planSnapshot(effective,p).signature)throw Error('Unrelated evidence would change');
 }
 const report={changed:true,dryRun,revisedPlans:corrected.map(p=>p.id),paperChanged:false,promotionEligible:false};
 if(dryRun)return report;
 if(fs.readFileSync(file,'utf8')!==before)throw Error('Config changed during migration');
 const backup=`${file}.before-bnb-reader-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;
 fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
 try{fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{mode:fs.statSync(file).mode&0o777,flag:'wx'});fs.renameSync(tmp,file);}
 finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return {...report,backup};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
 console.log(JSON.stringify(fixBnbMakerReading(process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json'),process.argv.includes('--dry-run'))));
