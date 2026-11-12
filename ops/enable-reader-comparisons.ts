#!/usr/bin/env node
/** Four interpretation comparisons only. Run with service stopped; dry-run never writes. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {ConfigStore,validateConfig} from '../server/src/config.ts';
import {planSnapshot,type ExecutionPlan,type ReadingOverride} from '../server/src/paper/executionPlans.ts';
const families:Array<{id:string;scannerId:string;label:string;candidate:ReadingOverride}>=[
 {id:'impulse',scannerId:'trend-impulse-channels-zeiierman',label:'Native retest directions',candidate:{version:2,reader:2,sides:{'lower retest':'long','upper retest':'short'}}},
 {id:'liquidity',scannerId:'liquidity-trail-matrix-atr-maker',label:'Correct reversal side',candidate:{version:2,reader:2}},
 {id:'ml-rsi',scannerId:'machine-learning-rsi-ai-classification-ranking-zeiierman',label:'Confirmed entries only',candidate:{version:2,reader:2,sources:['alertcondition','shape'],labels:['Long','Short'],sides:{'st flip up':'none','st flip dn':'none','trend flip up':'none','trend flip down':'none','long signal':'long','short signal':'short'}}},
 {id:'cluster',scannerId:'supertrend-cluster-zeiierman',label:'Cluster votes only',candidate:{version:2,reader:2,sources:['shape'],labels:['Major Long','Major Short'],sides:{'major long':'long','major short':'short','base st long':'none','base st short':'none'}}},
];
export const READER_COMPARISONS:ExecutionPlan[]=families.flatMap(f=>(['control','candidate'] as const).map(role=>({
 id:`reader-${f.id}-eth-15m-${role}`,revision:1,enabled:true,scannerId:f.scannerId,symbol:'ETHUSD',tf:'15m',variant:'current',referenceEquity:1000,
 label:role==='control'?`${f.id}: current reading`:`${f.id}: ${f.label}`,comparison:{group:`reader-${f.id}-eth-15m`,role},
 readingOverride:role==='control'?{version:1,reader:1}:f.candidate,
})));
/** Research coverage selection, not promotion or a claim that these markets are profitable. */
const activeMarkets:Record<string,string>={impulse:'INITUSD',liquidity:'AIOTUSD','ml-rsi':'JCTUSD',cluster:'EVAAUSD'};
export const ACTIVE_READER_COMPARISONS:ExecutionPlan[]=READER_COMPARISONS.map(p=>{
 const family=families.find(f=>f.scannerId===p.scannerId)!,symbol=activeMarkets[family.id],suffix=symbol.toLowerCase().replace(/usd$/,'');
 return {...structuredClone(p),id:p.id.replace('-eth-',`-${suffix}-`),symbol,comparison:{...p.comparison!,group:p.comparison!.group.replace('-eth-',`-${suffix}-`)}};
});
export function enableReaderComparisons(file:string,dryRun=false,selectActiveMarkets=false){
 const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
 const selected=selectActiveMarkets?ACTIVE_READER_COMPARISONS:READER_COMPARISONS;
 if(cfg.execution.mode!=='paper'||cfg.paper.marginPerTrade!==150||cfg.paper.maxStopLossPct!==3||!cfg.incubator.enabled)throw Error('Requires paper mode, $150 margin, existing 3% stop cap and active incubator');
 for(const f of families)if(!cfg.scanners[f.scannerId])throw Error(`Missing source ${f.scannerId}`);
 for(const f of families){
  const pair=selected.filter(p=>p.scannerId===f.scannerId).map(p=>planSnapshot(cfg,p));
  if(!isDeepStrictEqual(pair[0].paper,pair[1].paper)||pair[0].exitMode!==pair[1].exitMode)throw Error('Interpretation arms must share execution and economics');
 }
 if(!selectActiveMarkets&&(raw.executionPlans??[]).some((p:ExecutionPlan)=>ACTIVE_READER_COMPARISONS.some(x=>x.id===p.id)))throw Error('Reading comparisons already relocated; use --active-markets, do not duplicate');
 const known=selectActiveMarkets?[...READER_COMPARISONS,...ACTIVE_READER_COMPARISONS]:READER_COMPARISONS;
 const ids=new Set(known.map(p=>p.id));
 for(const p of raw.executionPlans??[])if(ids.has(p.id)&&!isDeepStrictEqual(p,known.find(x=>x.id===p.id)))throw Error(`Existing plan ${p.id} differs; no overwrite`);
 const plans=[...(raw.executionPlans??[]).filter((p:ExecutionPlan)=>!ids.has(p.id)),...structuredClone(selected)];
 const errors=validateConfig({...cfg,executionPlans:plans});if(errors.length)throw Error(errors.join('; '));
 const next={...raw,executionPlans:plans},changed=!isDeepStrictEqual(next,raw);
 if(dryRun||!changed)return {changed,dryRun,plans:selected.map(p=>({id:p.id,source:p.scannerId,symbol:p.symbol,reading:p.readingOverride}))};
 if(fs.readFileSync(file,'utf8')!==before)throw Error('Configuration changed during migration');
 const backup=`${file}.before-reader-comparisons-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;
 fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
 try{fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{mode:fs.statSync(file).mode&0o777,flag:'wx'});fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return {changed,dryRun,backup,comparisons:4,arms:8};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(enableReaderComparisons(process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json'),process.argv.includes('--dry-run'),process.argv.includes('--active-markets'))));
