#!/usr/bin/env node
/** Shadow-only rollout. Retain historical cohorts; never retire a plan holding exposure. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {ConfigStore,validateConfig,type AppConfig} from '../server/src/config.ts';
import {planSnapshot,type ExecutionPlan} from '../server/src/paper/executionPlans.ts';
import {SETUP_LIFECYCLE} from '../server/src/paper/setupLifecycle.ts';
import {ScannerRegistry} from '../server/src/scanners/registry.ts';

export const RETIRED_SETUP_PLANS=[
  'mt-garch-ethusd-15m-v1-control','mt-garch-ethusd-15m-v1-candidate',
  'maker-v2-link-impulse-control','maker-v2-link-impulse-candidate',
];
const families=[
  {sourcePlan:'author-strat-eth-15m-v1',key:'setup-strat-eth-15m',symbol:'ETHUSD',tf:'15m'},
  {sourcePlan:'reader-liquidity-aiot-15m-candidate',key:'setup-liquidity-sol-1h',symbol:'SOLUSD',tf:'1h'},
];
export function setupComparisonPlans(cfg:AppConfig):ExecutionPlan[]{
  return families.flatMap(f=>{
    const p=cfg.executionPlans?.find(p=>p.id===f.sourcePlan);
    if(!p)throw Error(`Missing reviewed template ${f.sourcePlan}`);
    return (['control','candidate'] as const).map(role=>({...structuredClone(p),id:`${f.key}-${role}`,revision:1,
      enabled:true,symbol:f.symbol,tf:f.tf,label:`${f.symbol} ${f.tf} · ${role==='control'?'current setup lifecycle':'confirmed-exit lifecycle'}`,
      comparison:{group:f.key,kind:'setup-lifecycle' as const,role},
      ...(role==='candidate'?{setupLifecycle:SETUP_LIFECYCLE}:{})}));
  });
}
export function enableSetupComparisons(file:string,dbFile:string,dryRun=false,expectedHash?:string,
  resolveSource?:(id:string)=>{status:string;patched:string}|undefined){
  const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
  if(expectedHash&&hash(before)!==expectedHash)throw Error('Configuration changed since preflight');
  if(cfg.execution.mode!=='paper'||cfg.execution.allowProduction||!cfg.incubator.enabled)throw Error('Requires paper-only execution and active shadow research');
  const registry=resolveSource?undefined:new ScannerRegistry();
  const source=resolveSource??((id:string)=>registry!.get(id));
  const selected=setupComparisonPlans(cfg),ids=new Set(selected.map(p=>p.id));
  const installed=(raw.executionPlans??[]).filter((p:ExecutionPlan)=>ids.has(p.id));
  if(installed.length&&(!isDeepStrictEqual(installed,selected)||RETIRED_SETUP_PLANS.some(id=>raw.executionPlans.some((p:ExecutionPlan)=>p.id===id))))throw Error('Edited or partial setup rollout will not be overwritten');
  const db=new DatabaseSync(dbFile,{readOnly:true});
  try{
    for(const row of db.prepare("SELECT id,fills FROM positions WHERE bt=2 AND status IN ('open','pending')").all()){
      const f=JSON.parse(String(row.fills??'{}'));
      const p=f.executionPlan??f.limitEntry?.executionPlan??f.pendingEntry?.executionPlan;
      if(p&&RETIRED_SETUP_PLANS.includes(p.id))throw Error(`Cannot retire held plan ${p.id}`);
    }
    if(!installed.length)for(const id of RETIRED_SETUP_PLANS){
      if(!cfg.executionPlans?.some(p=>p.id===id))throw Error(`Retirement plan changed: ${id}`);
      const row=db.prepare('SELECT count(*) n FROM execution_plan_events WHERE plan_id=? AND at>=?').get(id,Date.now()-3*86400_000) as {n:number};
      if(row.n)throw Error(`Retirement plan has recent signal evidence: ${id}`);
    }
  }finally{db.close();}
  for(const p of selected){const s=source(p.scannerId);if(!s||s.status!=='ok'||!s.patched)throw Error(`Source unavailable ${p.scannerId}`);planSnapshot(cfg,p,hash(s.patched));}
  for(const f of families){
    const arms=selected.filter(p=>p.comparison?.group===f.key).map(p=>planSnapshot(cfg,p,hash(source(p.scannerId)!.patched)));
    if(!isDeepStrictEqual(arms[0].paper,arms[1].paper)||!isDeepStrictEqual(arms[0].reading,arms[1].reading)||arms[0].exitMode!==arms[1].exitMode)throw Error('Lifecycle arms changed entry, exit, sizing or reading settings');
  }
  const next={...raw,executionPlans:installed.length?raw.executionPlans:[...(raw.executionPlans??[]).filter((p:ExecutionPlan)=>!RETIRED_SETUP_PLANS.includes(p.id)),...selected]};
  const errors=validateConfig({...cfg,executionPlans:next.executionPlans});if(errors.length)throw Error(errors.join('; '));
  if(!isDeepStrictEqual({...raw,executionPlans:[]},{...next,executionPlans:[]}))throw Error('Unrelated settings changed');
  for(const p of cfg.executionPlans??[]){
    if(RETIRED_SETUP_PLANS.includes(p.id)||ids.has(p.id))continue;
    if(!isDeepStrictEqual(p,next.executionPlans.find((n:ExecutionPlan)=>n.id===p.id)))throw Error('Existing plan changed');
  }
  const changed=!isDeepStrictEqual(raw,next);
  const result={changed,dryRun,retired:RETIRED_SETUP_PLANS,plans:selected.map(p=>({id:p.id,source:p.scannerId,symbol:p.symbol,tf:p.tf,role:p.comparison!.role})),totalPlans:next.executionPlans.length,
    outsidePlanSettingsUnchanged:true,mode:cfg.execution.mode,margin:cfg.paper.marginPerTrade,maxStopLossPct:cfg.paper.maxStopLossPct};
  if(dryRun||!changed)return result;
  if(fs.readFileSync(file,'utf8')!==before)throw Error('Configuration changed during activation');
  const backup=`${file}.before-setup-comparisons-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(backup,before,{flag:'wx',mode:0o600});
  try{fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
  return {...result,backup};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const dryRun=process.argv.includes('--dry-run');
  if(!dryRun&&spawnSync('systemctl',['is-active','--quiet','vnedge']).status===0)throw Error('Stop vnedge before changing research plans');
  const file=process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json');
  console.log(JSON.stringify(enableSetupComparisons(file,process.env.VNEDGE_DB??path.join(path.dirname(file),'vnedge.db'),dryRun,process.env.VNEDGE_EXPECTED_CONFIG_HASH)));
}
