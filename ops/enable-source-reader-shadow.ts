#!/usr/bin/env node
/** Source/reader corrections are prospective experiments, never migration of old evidence. */
import fs from'node:fs';import path from'node:path';import{fileURLToPath}from'node:url';import{isDeepStrictEqual}from'node:util';import{createHash}from'node:crypto';import{spawnSync}from'node:child_process';
import{ConfigStore,loadSpecs,validateConfig,type AppConfig}from'../server/src/config.ts';import{ScannerRegistry}from'../server/src/scanners/registry.ts';import{PRECISION_NATIVE,NEO_NATIVE,FISHER_UPDATED,sourcePinError}from'../server/src/scanners/sourceReaders.ts';import{SETUP_LIFECYCLE}from'../server/src/paper/setupLifecycle.ts';import{planSnapshot,type ExecutionPlan}from'../server/src/paper/executionPlans.ts';
export const FISHER_CONTROL='fisher-transform-of-williams-r-divergence';
export const READER_PLANS:ExecutionPlan[]=[
 {id:'reader-precision-v23-eth-15m',revision:1,enabled:true,scannerId:PRECISION_NATIVE,symbol:'ETHUSD',tf:'15m',variant:'current',referenceEquity:1000,readingOverride:{version:1,reader:2},setupLifecycle:SETUP_LIFECYCLE,exitPolicy:'own-exits',label:'Precision v2.3 · native full-position lifecycle'},
 {id:'reader-neo-v4-sol-15m',revision:1,enabled:true,scannerId:NEO_NATIVE,symbol:'SOLUSD',tf:'15m',variant:'current',referenceEquity:1000,readingOverride:{version:1,reader:2},label:'IndicatorNeo v4 · native bracket'},
 ...(['control','candidate']as const).map(role=>({id:`reader-fisher-aiot-15m-${role}`,revision:1,enabled:true,scannerId:role==='control'?FISHER_CONTROL:FISHER_UPDATED,symbol:'AIOTUSD',tf:'15m',variant:'current'as const,referenceEquity:1000,readingOverride:{version:1},comparison:{group:'fisher-source-aiot-15m',kind:'source-update'as const,role},label:`Fisher · ${role==='control'?'current source':'updated source'}`})),
];
export function enableSourceReaders(file:string,dryRun=false,expectedHash?:string,resolve?:(id:string)=>{status:string;source:string;patched:string}|undefined){
 const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
 const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
 if(expectedHash&&sha(before)!==expectedHash)throw Error('Configuration changed since preflight');
 if(cfg.execution.mode!=='paper'||cfg.execution.allowProduction||!cfg.incubator.enabled)throw Error('Requires paper-only execution and active shadow');
 const registry=resolve?undefined:new ScannerRegistry(),source=resolve??((id:string)=>registry!.get(id)),specs=loadSpecs();
 const next=structuredClone(raw);next.scanners={...raw.scanners};next.executionPlans=[...(raw.executionPlans??[])];
 for(const id of [PRECISION_NATIVE,NEO_NATIVE,FISHER_UPDATED]){
  const definition=id===FISHER_UPDATED?{...structuredClone(cfg.scanners[FISHER_CONTROL]),enabled:false}:structuredClone(cfg.scanners[id]);
  if(!definition||definition.enabled)throw Error(`New reader must remain account-disabled: ${id}`);
  if(id!==FISHER_UPDATED&&Object.entries(specs[id]).some(([k,v])=>!isDeepStrictEqual(v,definition[k as keyof typeof definition])))throw Error(`Reviewed native reading changed: ${id}`);
  if(raw.scanners?.[id]&&!isDeepStrictEqual(raw.scanners[id],definition))throw Error(`Edited reader will not be overwritten: ${id}`);
  next.scanners[id]=definition;
 }
 const effective={...cfg,scanners:{...cfg.scanners,...next.scanners}};
 for(const p of READER_PLANS){
  const s=source(p.scannerId);if(!s||s.status!=='ok'||sourcePinError(p.scannerId,s.source))throw Error(`Pinned source unavailable: ${p.scannerId}`);
  const existing=next.executionPlans.find((x:ExecutionPlan)=>x.id===p.id);if(existing&&!isDeepStrictEqual(existing,p))throw Error(`Edited plan will not be overwritten: ${p.id}`);
  if(!existing)next.executionPlans.push(structuredClone(p));planSnapshot(effective,p,sha(s.patched));
 }
 const arms=READER_PLANS.filter(p=>p.comparison).map(p=>planSnapshot(effective,p,sha(source(p.scannerId)!.patched)));
 if(!isDeepStrictEqual(arms[0].paper,arms[1].paper)||!isDeepStrictEqual({...arms[0].reading,enabled:false},{...arms[1].reading,enabled:false}))throw Error('Fisher source arms changed exit, reading, fee or capital policy');
 const errors=validateConfig({...effective,executionPlans:next.executionPlans});if(errors.length)throw Error(errors.join('; '));
 const strip=(c:AppConfig)=>{const v=structuredClone(c);v.executionPlans=[];for(const id of [PRECISION_NATIVE,NEO_NATIVE,FISHER_UPDATED])delete v.scanners[id];return v;};
 if(!isDeepStrictEqual(strip(raw),strip(next)))throw Error('Unrelated trading or risk configuration changed');
 const changed=!isDeepStrictEqual(raw,next),result={changed,dryRun,plans:READER_PLANS.map(p=>({id:p.id,source:p.scannerId,symbol:p.symbol,tf:p.tf})),totalPlans:next.executionPlans.length,priorPlansRetained:true,accountSettingsUnchanged:true};
 if(dryRun||!changed)return result;
 if(fs.readFileSync(file,'utf8')!==before)throw Error('Configuration changed during activation');
 const backup=`${file}.before-source-readers-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;fs.writeFileSync(backup,before,{flag:'wx',mode:0o600});
 try{fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return{...result,backup};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const dry=process.argv.includes('--dry-run');if(!dry&&spawnSync('systemctl',['is-active','--quiet','vnedge']).status===0)throw Error('Stop service before activating research');
 console.log(JSON.stringify(enableSourceReaders(process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json'),dry,process.env.VNEDGE_EXPECTED_CONFIG_HASH)));
}
