#!/usr/bin/env node
/** Minute-replayed liquid-market candidates; experimental shadow only. Stop service before writing. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {enableAuthorShadow} from './enable-author-shadow.ts';
import {STEALTH_NATIVE,TREND_CONTINUATION} from '../server/src/scanners/plotLifecycle.ts';
import type {ExecutionPlan} from '../server/src/paper/executionPlans.ts';

export const LIQUID_IMPORT_PLANS:ExecutionPlan[]=[
 {scannerId:STEALTH_NATIVE,symbol:'ZECUSD',key:'stealth'},
 {scannerId:TREND_CONTINUATION,symbol:'UNIUSD',key:'trend-continuation'},
].map(({scannerId,symbol,key})=>({
 id:`liquid-${key}-${symbol.toLowerCase()}-1h-v1`,revision:1,enabled:true,
 scannerId,symbol,tf:'1h',variant:'current',referenceEquity:1000,
 label:`Liquid-market study: ${key} (experimental)`,readingOverride:{version:1,reader:2},
}));
export const enableLiquidImportShadow=(file:string,dryRun=false)=>enableAuthorShadow(file,dryRun,LIQUID_IMPORT_PLANS);
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
 console.log(JSON.stringify(enableLiquidImportShadow(process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json'),process.argv.includes('--dry-run'))));
