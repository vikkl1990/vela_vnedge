#!/usr/bin/env node
/** Run after the tested code is installed, while vnedge is stopped. Backs up and changes one rule only. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ConfigStore,validateConfig,type PaperConfig} from '../server/src/config.ts';

export const EVAA_RECLAIM:NonNullable<PaperConfig['reclaimTrials']>[number]={enabled:true,
  scannerId:'trend-impulse-channels-zeiierman',symbol:'EVAAUSD',tf:'15m',
  minSignalBarAtr:3,pullbackAtr:.25,setupMinutes:15,orderMinutes:3,
  maxStopLossPct:1.5,sizeScale:1,maxDailyEntries:10};

export function enableEvaaReclaim(file:string,dryRun=false){
  const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
  if(cfg.execution.mode!=='paper')throw Error('EVAA trial requires paper execution');
  if(cfg.paper.marginPerTrade!==150)throw Error('expected the reviewed $150 margin policy');
  const sc=cfg.scanners[EVAA_RECLAIM.scannerId];
  if(!sc?.enabled||!sc.pairs?.some(p=>p.symbol===EVAA_RECLAIM.symbol&&p.tf===EVAA_RECLAIM.tf))throw Error('EVAA cell is not allocated');
  const same=(r:typeof EVAA_RECLAIM)=>r.scannerId===EVAA_RECLAIM.scannerId&&r.symbol===EVAA_RECLAIM.symbol&&r.tf===EVAA_RECLAIM.tf;
  const trials=[...(raw.paper?.reclaimTrials??[]).filter((r:typeof EVAA_RECLAIM)=>!same(r)),EVAA_RECLAIM];
  const errors=validateConfig({...cfg,paper:{...cfg.paper,reclaimTrials:trials}});
  if(errors.length)throw Error('configuration validation failed: '+errors.join('; '));
  const next={...raw,paper:{...raw.paper,reclaimTrials:trials}};
  const changed=JSON.stringify(raw)!==JSON.stringify(next);
  if(dryRun||!changed)return {changed,dryRun,rule:EVAA_RECLAIM};
  if(fs.readFileSync(file,'utf8')!==before)throw Error('config changed during migration; retry with service stopped');
  const backup=`${file}.before-evaa-reclaim-${Date.now()}`;
  fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
  const tmp=`${file}.${process.pid}.tmp`;
  try {fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{mode:fs.statSync(file).mode&0o777,flag:'wx'});fs.renameSync(tmp,file);}
  finally {if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
  return {changed,dryRun,backup,rule:EVAA_RECLAIM};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const file=process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json');
  console.log(JSON.stringify(enableEvaaReclaim(file,process.argv.includes('--dry-run'))));
}
