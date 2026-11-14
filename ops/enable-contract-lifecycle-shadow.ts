#!/usr/bin/env node
/** Two source-pinned readiness corrections, in isolated prospective shadow. Stop before writing. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {enableAuthorShadow} from './enable-author-shadow.ts';
import {BREAKOUT_NATIVE,ML_RSI_NATIVE} from '../server/src/scanners/plotLifecycle.ts';
import type {ExecutionPlan} from '../server/src/paper/executionPlans.ts';
export const CONTRACT_LIFECYCLE_PLANS:ExecutionPlan[]=[BREAKOUT_NATIVE,ML_RSI_NATIVE].map((scannerId,i)=>({
 id:`native-contract-${i===0?'breakout':'ml-rsi'}-eth-15m-v1`,revision:1,enabled:true,scannerId,symbol:'ETHUSD',tf:'15m',
 variant:'current',referenceEquity:1000,label:`Native contract: ${i===0?'Breakout':'ML RSI'} (experimental)`,readingOverride:{version:1,reader:2,...(scannerId===ML_RSI_NATIVE?{sides:{'ST Flip Up':'none','ST Flip Dn':'none','Trend Flip Up':'none','Trend Flip Down':'none'} as const}:{})},
}));
export const enableContractLifecycleShadow=(file:string,dryRun=false)=>enableAuthorShadow(file,dryRun,CONTRACT_LIFECYCLE_PLANS);
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(enableContractLifecycleShadow(process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json'),process.argv.includes('--dry-run'))));
