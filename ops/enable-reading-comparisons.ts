#!/usr/bin/env node
/**
 * Decision 242: enable four reading comparisons in the shadow book. Each pairs a scanner with a variant that reads the
 * same source differently, on one market and timeframe, under one policy: same exits, sizing and costs. The account
 * and every other scanner are untouched. Run with the service stopped; `--dry-run` shows the plans without writing.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {ConfigStore,validateConfig,type ScannerConfig} from '../server/src/config.ts';
import {loadVariants} from '../server/src/scanners/registry.ts';
import type {ExecutionPlan} from '../server/src/paper/executionPlans.ts';

const pair=(group:string,label:string,control:string,candidate:string,symbol:string,tf:string):ExecutionPlan[]=>[
  {id:`${group}-control`,label:`${label} · current reading`,revision:1,enabled:true,scannerId:control,symbol,tf,variant:'current',referenceEquity:1000,comparison:{group,role:'control',axis:'reading'}},
  {id:`${group}-candidate`,label:`${label} · corrected reading`,revision:1,enabled:true,scannerId:candidate,symbol,tf,variant:'current',referenceEquity:1000,comparison:{group,role:'candidate',axis:'reading'}},
];
export const READING_PLANS:ExecutionPlan[]=[
  ...pair('read-tic-initusd-15m','Trend Impulse retests','trend-impulse-channels-zeiierman','trend-impulse-channels-zeiierman-native','INITUSD','15m'),
  ...pair('read-ltm-aiotusd-15m','Liquidity Trail reversal exits','liquidity-trail-matrix','liquidity-trail-matrix-reader2','AIOTUSD','15m'),
  ...pair('read-mlrsi-jctusd-15m','ML RSI classifier entries','machine-learning-rsi-ai-classification-ranking-zeiierman','machine-learning-rsi-ai-classification-ranking-zeiierman-entries','JCTUSD','15m'),
  ...pair('read-stc-evaausd-15m','SuperTrend Cluster consensus','supertrend-cluster-zeiierman','supertrend-cluster-zeiierman-consensus','EVAAUSD','15m'),
];

/** What may differ between the two scanners of a reading comparison: how outputs are read, and where a scanner trades. */
const READING_KEYS=new Set(['sources','labels','sides','invert','edge','rule','rulePin','reader','enabled','symbols','timeframes','pairs','hidden']);
const policyOf=(sc:ScannerConfig|undefined)=>Object.fromEntries(Object.entries(sc??{}).filter(([k])=>!READING_KEYS.has(k)));

export function enableReadingComparisons(file:string,dryRun=false){
  const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
  if(cfg.execution.mode!=='paper')throw Error('reading comparisons require paper execution');
  if(!cfg.incubator.enabled)throw Error('reading comparisons require the incubator source scheduler');
  if(cfg.paper.marginPerTrade!==150)throw Error('expected the reviewed $150 margin policy');
  const variants=new Map(loadVariants().map(v=>[v.id,v.base]));
  for(const p of READING_PLANS.filter(x=>x.comparison?.role==='candidate')){
    const control=READING_PLANS.find(x=>x.comparison?.group===p.comparison?.group&&x.comparison?.role==='control')!;
    if(variants.get(p.scannerId)!==control.scannerId)throw Error(`${p.scannerId} is not a variant of ${control.scannerId}`);
    if(!cfg.scanners[control.scannerId]||!cfg.scanners[p.scannerId])throw Error(`scanner configuration missing for ${p.comparison?.group}`);
    // only the reading may differ: a changed exit, protection or entry setting would confound the comparison
    if(!isDeepStrictEqual(policyOf(cfg.scanners[control.scannerId]),policyOf(cfg.scanners[p.scannerId])))throw Error(`${p.comparison?.group}: the two scanners differ in more than their reading`);
  }
  const ids=new Set(READING_PLANS.map(p=>p.id));
  // never overwrite an independently edited or newer experiment under the same id
  for(const p of raw.executionPlans??[])if(ids.has(p.id)&&!isDeepStrictEqual(p,READING_PLANS.find(x=>x.id===p.id)))throw Error(`existing ${p.id} differs from the reviewed experiment`);
  const plans=[...(raw.executionPlans??[]).filter((p:ExecutionPlan)=>!ids.has(p.id)),...structuredClone(READING_PLANS)];
  const errors=validateConfig({...cfg,executionPlans:plans});
  if(errors.length)throw Error('configuration validation failed: '+errors.join('; '));
  const next={...raw,executionPlans:plans},changed=JSON.stringify(raw)!==JSON.stringify(next);
  if(dryRun||!changed)return {changed,dryRun,plans:READING_PLANS};
  if(fs.readFileSync(file,'utf8')!==before)throw Error('config changed during migration; retry with service stopped');
  const backup=`${file}.before-reading-comparisons-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
  try{fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{mode:fs.statSync(file).mode&0o777,flag:'wx'});fs.renameSync(tmp,file);}
  finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
  return {changed,dryRun,backup,plans:READING_PLANS};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const file=process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json');
  console.log(JSON.stringify(enableReadingComparisons(file,process.argv.includes('--dry-run'))));
}
