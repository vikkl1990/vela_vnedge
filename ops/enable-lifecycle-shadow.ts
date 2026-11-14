#!/usr/bin/env node
/** Four tested lifecycle profiles in the explicitly expanded research capacity. Stop service before writing. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {enableAuthorShadow} from './enable-author-shadow.ts';
import type {ExecutionPlan} from '../server/src/paper/executionPlans.ts';
export const LIFECYCLE_SHADOW_PLANS:ExecutionPlan[]=[
 ['reactive','reactive-trail-system-author-native',3],
 ['reaction','reaction-level-matrix-author-native',3],
 ['strat','strat-trap-vwap-engine-author-native',3],
 ['swing-retests','smart-swing-vwap-zeiierman-author-retests',2],
].map(([key,scannerId,reader])=>({id:`author-${key}-eth-15m-v1`,revision:1,enabled:true,scannerId:String(scannerId),symbol:'ETHUSD',tf:'15m',variant:'current',referenceEquity:1000,label:`Author lifecycle: ${key} (experimental)`,readingOverride:{version:1,reader:reader as 2|3}}));
export const enableLifecycleShadow=(file:string,dryRun=false)=>enableAuthorShadow(file,dryRun,LIFECYCLE_SHADOW_PLANS);
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(enableLifecycleShadow(process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json'),process.argv.includes('--dry-run'))));
