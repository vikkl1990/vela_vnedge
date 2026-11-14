#!/usr/bin/env node
/** Install tested author profiles in experimental shadow only. Stop the service before writing. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {ConfigStore,loadSpecs,validateConfig} from '../server/src/config.ts';
import {ScannerRegistry} from '../server/src/scanners/registry.ts';
import {planSnapshot,type ExecutionPlan} from '../server/src/paper/executionPlans.ts';

// Original rollout profiles. Subsequent tested batches use the same guarded installer.
export const AUTHOR_SHADOW_PLANS:ExecutionPlan[]=[
 ['savwap','structure-anchored-vwap-upstream-2-0',3],
 ['synapse','synapse-trail-pro-author-native',3],
 ['liquidity','liquidity-trail-matrix-author-native',3],
 ['pivot-zones','high-volume-pivot-support-resistance-zones-author-signals',2],
 ['dynamic-bands','dynamic-trend-bands-anchored-vwap-signals-author-signals',2],
].map(([key,scannerId,reader])=>({
 id:`author-${key}-eth-15m-v1`,revision:1,enabled:true,scannerId:String(scannerId),symbol:'ETHUSD',tf:'15m',
 variant:'current',referenceEquity:1000,label:`Author review: ${key} (experimental)`,readingOverride:{version:1,reader:reader as 2|3},
}));

export function enableAuthorShadow(file:string,dryRun=false,requestedPlans:ExecutionPlan[]=AUTHOR_SHADOW_PLANS){
 const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
 if(cfg.execution.mode!=='paper'||cfg.paper.sizingMode!=='margin'||cfg.paper.marginPerTrade!==150||cfg.paper.maxStopLossPct!==3||!cfg.incubator.enabled)
  throw Error('Requires paper mode, $150 margin, existing 3% stop ceiling and active incubator');
 const specs=loadSpecs(),registry=new ScannerRegistry();
 for(const p of requestedPlans){
  const sc=cfg.scanners[p.scannerId],expected=specs[p.scannerId],source=registry.get(p.scannerId);
  if(!source||source.status!=='ok'||!sc||!expected)throw Error(`Source unavailable: ${p.scannerId}`);
  // Never paper-enable a library scanner or replace a locally edited treatment.
  if(Object.entries(expected).some(([k,v])=>!isDeepStrictEqual(sc[k as keyof typeof sc],v)))throw Error(`Reviewed profile differs: ${p.scannerId}`);
  const snapshot=planSnapshot(cfg,p);
  if(snapshot.paper.marginPerTrade!==150||snapshot.paper.maxStopLossPct!==cfg.paper.maxStopLossPct||snapshot.paper.scalperOffer?.enabled)
   throw Error(`Research economics differ: ${p.id}`);
 }
 const ids=new Set(requestedPlans.map(p=>p.id));
 for(const p of raw.executionPlans??[])if(ids.has(p.id)&&!isDeepStrictEqual(p,requestedPlans.find(x=>x.id===p.id)))throw Error(`Edited plan will not be overwritten: ${p.id}`);
 const plans=[...(raw.executionPlans??[]).filter((p:ExecutionPlan)=>!ids.has(p.id)),...structuredClone(requestedPlans)];
 const errors=validateConfig({...cfg,executionPlans:plans});if(errors.length)throw Error(errors.join('; '));
 const next={...raw,executionPlans:plans},changed=!isDeepStrictEqual(next,raw);
 const result={changed,dryRun,totalPlans:plans.length,experimentalPlans:requestedPlans.map(p=>({id:p.id,scannerId:p.scannerId,symbol:p.symbol,tf:p.tf})),
  deferred:['triangular-hull-moving-average-volatility-author-signals','liquidity-void-detector-zeiierman-author-direction'],
  note:'Experiments remain excluded from promotion/copying/sizing evidence. No scanner enablement or capital/risk/evidence setting changes.'};
 if(dryRun||!changed)return result;
 if(fs.readFileSync(file,'utf8')!==before)throw Error('Configuration changed during migration');
 const backup=`${file}.before-author-shadow-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;
 fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
 try{fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{mode:fs.statSync(file).mode&0o777,flag:'wx'});fs.renameSync(tmp,file);}
 finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return {...result,backup};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(enableAuthorShadow(process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json'),process.argv.includes('--dry-run'))));
