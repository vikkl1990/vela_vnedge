#!/usr/bin/env node
/** Tested import profiles in experimental shadow only; stop service before writing. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {enableAuthorShadow} from './enable-author-shadow.ts';
import {STEALTH_NATIVE,TREND_CONTINUATION} from '../server/src/scanners/plotLifecycle.ts';
import type {ExecutionPlan} from '../server/src/paper/executionPlans.ts';

// Chosen for liquid market coverage, never selected by historical P&L.
export const VNEDGE_IMPORT_PLANS:ExecutionPlan[]=['BTCUSD','ETHUSD','SOLUSD'].flatMap(symbol=>[
 {scannerId:STEALTH_NATIVE,tf:'15m',key:'stealth'},
 {scannerId:TREND_CONTINUATION,tf:'1h',key:'trend-continuation'},
].map(({scannerId,tf,key})=>({
 id:`import-${key}-${symbol.toLowerCase()}-${tf}-v1`,revision:1,enabled:true,
 scannerId,symbol,tf,variant:'current',referenceEquity:1000,
 label:`VNEDGE import: ${key} (experimental)`,readingOverride:{version:1,reader:2},
})));
export const enableVnedgeImportShadow=(file:string,dryRun=false)=>enableAuthorShadow(file,dryRun,VNEDGE_IMPORT_PLANS);
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
 console.log(JSON.stringify(enableVnedgeImportShadow(process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json'),process.argv.includes('--dry-run'))));
