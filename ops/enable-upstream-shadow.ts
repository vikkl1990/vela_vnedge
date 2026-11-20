#!/usr/bin/env node
/** Install paired native-target studies in experimental shadow. Stop service before writing. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {ConfigStore,loadSpecs,validateConfig} from '../server/src/config.ts';
import {ScannerRegistry} from '../server/src/scanners/registry.ts';
import {upstreamSources} from '../server/src/scanners/upstreamLifecycle.ts';
import {planSnapshot,type ExecutionPlan} from '../server/src/paper/executionPlans.ts';

// Small prospective pilot: nine source runs, eighteen independent exit arms.
// Selected liquid majors, not selected on in-sample P&L. Account admission is unchanged.
export const UPSTREAM_PAIRS=['BTCUSD','ETHUSD','SOLUSD'];
export const UPSTREAM_SHADOW_PLANS:ExecutionPlan[]=Object.keys(upstreamSources).flatMap(scannerId=>UPSTREAM_PAIRS.flatMap(symbol=>{
 const name=scannerId.split('-')[0],group=`upstream-${name}-${symbol.toLowerCase()}-15m-v1`;
 return (['control','candidate'] as const).map(role=>({id:`${group}-${role}`,revision:1,enabled:true,scannerId,symbol,tf:'15m',variant:'current' as const,
  referenceEquity:1000,readingOverride:{version:1,reader:2 as const},comparison:{group,role,kind:'exit-policy' as const},
  ...(role==='control'?{exitPolicy:'account-ladder' as const}:{}),
  label:`${name.toUpperCase()} · ${role==='control'?'Account exits (native initial SL)':'Author exits + hard risk stop'}`}));
}));
export function enableUpstreamShadow(file:string,dryRun=false){
 const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
 if(cfg.execution.mode!=='paper'||cfg.paper.sizingMode!=='margin'||!(cfg.paper.marginPerTrade!>0)||!(cfg.paper.maxStopLossPct!>0)||!cfg.incubator.enabled)
  throw Error('Requires paper mode, existing margin sizing and stop-risk cap, and active incubator');
 const specs=loadSpecs(),registry=new ScannerRegistry();
 for(const p of UPSTREAM_SHADOW_PLANS){
  const sc=cfg.scanners[p.scannerId],expected=specs[p.scannerId],source=registry.get(p.scannerId);
  if(!source||source.status!=='ok'||!sc||!expected)throw Error(`Source unavailable: ${p.scannerId}`);
  if(sc.enabled||Object.entries(expected).some(([k,v])=>!isDeepStrictEqual(sc[k as keyof typeof sc],v)))throw Error(`Reviewed shadow profile differs: ${p.scannerId}`);
  const snap=planSnapshot(cfg,p);
  if(snap.paper.marginPerTrade!==cfg.paper.marginPerTrade||snap.paper.maxStopLossPct!==cfg.paper.maxStopLossPct||snap.paper.scalperOffer?.enabled)throw Error(`Research economics differ: ${p.id}`);
 }
 const next=structuredClone(raw),existing=new Map<string,ExecutionPlan>((raw.executionPlans??[]).map((p:ExecutionPlan)=>[p.id,p]));
 next.executionPlans=[...(raw.executionPlans??[])];
 for(const p of UPSTREAM_SHADOW_PLANS){
  if(existing.has(p.id)){if(!isDeepStrictEqual(existing.get(p.id),p))throw Error(`Edited plan will not be overwritten: ${p.id}`);}
  else next.executionPlans.push(structuredClone(p));
 }
 const errors=validateConfig({...cfg,executionPlans:next.executionPlans});if(errors.length)throw Error(errors.join('; '));
 const changed=!isDeepStrictEqual(next,raw),result={changed,dryRun,totalPlans:next.executionPlans.length,sourceCells:9,comparisonPlans:UPSTREAM_SHADOW_PLANS.length,pairs:UPSTREAM_PAIRS,
  note:'Only experimental executionPlans change. Account scanners remain disabled; existing risk/capital/evidence settings are untouched. Experimental results never count for promotion.'};
 if(dryRun||!changed)return result;
 if(fs.readFileSync(file,'utf8')!==before)throw Error('Configuration changed during migration');
 const backup=`${file}.before-upstream-shadow-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;
 fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
 try{fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{mode:fs.statSync(file).mode&0o777,flag:'wx'});fs.renameSync(tmp,file);}
 finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return {...result,backup};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(enableUpstreamShadow(process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json'),process.argv.includes('--dry-run'))));
