#!/usr/bin/env node
/** Append isolated, paired research readings. No paper scanner or existing cohort is rewritten. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';import {isDeepStrictEqual} from 'node:util';import {spawnSync} from 'node:child_process';
import {ConfigStore,validateConfig} from '../server/src/config.ts';
import {ScannerRegistry} from '../server/src/scanners/registry.ts';
import {ENTRY_CONTRACTS,type SignalContract} from '../server/src/scanners/entryContracts.ts';
import {planSnapshot,type ExecutionPlan} from '../server/src/paper/executionPlans.ts';
const families:Array<{name:string;contract:SignalContract;symbol:string;tf:string}>=[
 {name:'regime',contract:'market-regime-context-v1',symbol:'AAVEUSD',tf:'1h'},
 {name:'smart-money',contract:'smart-money-retests-v1',symbol:'INJUSD',tf:'1h'},
 {name:'ml-rsi',contract:'ml-rsi-classifier-v1',symbol:'ARIAUSD',tf:'15m'},
];
export const makeContractPlans=(cells:typeof families):ExecutionPlan[]=>cells.flatMap(f=>(['control','candidate'] as const).map(role=>({
 id:`contract-${f.name}-${f.symbol.toLowerCase().replace(/usd$/,'')}-${f.tf}-${role}`,revision:1,enabled:true,
 scannerId:ENTRY_CONTRACTS[f.contract].scannerId,symbol:f.symbol,tf:f.tf,variant:'current',referenceEquity:1000,
 comparison:{group:`contract-${f.name}-${f.symbol.toLowerCase().replace(/usd$/,'')}-${f.tf}`,role},
 readingOverride:role==='control'?{version:1}:{version:1,reader:2,signalContract:f.contract,
 ...(f.name==='ml-rsi'?{sources:['alert','alertcondition','shape'],labels:['Long','Short'],sides:{'st flip up':'none','st flip dn':'none','trend flip up':'none','trend flip down':'none','long signal':'long','short signal':'short'}}:f.name==='smart-money'?{sources:['alert'],labels:['Long OB Retest','Short OB Retest','Long FVG Retest','Short FVG Retest']}:{}),
 },label:role==='control'?`${f.name}: unchanged current reader`:`${f.name}: ${f.contract}${f.name==='regime'?' (context only)':''}`,
})));
export const CONTRACT_PLANS=makeContractPlans(families);
export function enableEntryContracts(file:string,dryRun=false,expectedHash?:string,resolve?:(id:string)=>{source:string;patched:string;status:string}|undefined,plans:ExecutionPlan[]=CONTRACT_PLANS){
 const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
 const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
 if(expectedHash&&sha(before)!==expectedHash)throw Error('Configuration changed since preflight');
 if(cfg.execution.mode!=='paper'||cfg.execution.allowProduction||!cfg.incubator.enabled)throw Error('Requires paper-only mode and active shadow');
 const registry=resolve?undefined:new ScannerRegistry(),source=resolve??((id:string)=>registry!.get(id));
 const next={...raw,executionPlans:[...(raw.executionPlans??[])]};
 for(const candidate of plans.filter(p=>p.comparison?.role==='candidate')){
  const contract=candidate.readingOverride?.signalContract;
  if(!contract)throw Error('Missing reviewed entry contract');
  const pin=ENTRY_CONTRACTS[contract],s=source(pin.scannerId);
  if(candidate.scannerId!==pin.scannerId||!cfg.scanners[pin.scannerId]||!s||s.status!=='ok'||sha(s.source)!==pin.source||sha(s.patched)!==pin.runtime)throw Error(`Reviewed source unavailable or changed: ${pin.scannerId}`);
  const definitions=plans.filter(p=>p.comparison?.group===candidate.comparison?.group);
  if(definitions.length!==2||definitions.filter(p=>p.comparison?.role==='control').length!==1)throw Error('Requires a matched control and candidate');
  const snapshots=definitions.map(p=>planSnapshot(cfg,p,pin.runtime));
  if(!isDeepStrictEqual(snapshots[0].paper,snapshots[1].paper)||snapshots[0].exitMode!==snapshots[1].exitMode)throw Error('Contract arms changed execution, fees or risk');
 }
 if(!plans.length||plans.length%2||plans.filter(p=>p.comparison?.role==='candidate').length*2!==plans.length)throw Error('Requires paired reviewed contracts');
 for(const p of plans){
  const saved=next.executionPlans.find((x:ExecutionPlan)=>x.id===p.id);
  if(saved&&!isDeepStrictEqual(saved,p))throw Error(`Edited comparison will not be overwritten: ${p.id}`);
  if(!saved)next.executionPlans.push(structuredClone(p));
 }
 const errors=validateConfig({...cfg,executionPlans:next.executionPlans});if(errors.length)throw Error(errors.join('; '));
 const unchanged=(v:any)=>{const x=structuredClone(v);delete x.executionPlans;return x;};
 if(!isDeepStrictEqual(unchanged(raw),unchanged(next)))throw Error('Account or risk settings changed');
 const changed=!isDeepStrictEqual(next,raw),out={changed,dryRun,totalPlans:next.executionPlans.length,accountSettingsUnchanged:true,priorPlansRetained:true,plans:plans.map(p=>({id:p.id,scanner:p.scannerId,symbol:p.symbol,tf:p.tf}))};
 if(dryRun||!changed)return out;
 if(fs.readFileSync(file,'utf8')!==before)throw Error('Concurrent configuration edit');
 const backup=`${file}.before-entry-contracts-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;fs.writeFileSync(backup,before,{flag:'wx',mode:0o600});
 try{fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return {...out,backup};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const dry=process.argv.includes('--dry-run');if(!dry&&spawnSync('systemctl',['is-active','--quiet','vnedge']).status===0)throw Error('Stop service before activating comparisons');
 console.log(JSON.stringify(enableEntryContracts(process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json'),dry,process.env.VNEDGE_EXPECTED_CONFIG_HASH)));
}
