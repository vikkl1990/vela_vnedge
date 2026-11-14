#!/usr/bin/env node
/** One prospective basket, isolated in shadow. Stop the service before writing. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {enableAuthorShadow} from './enable-author-shadow.ts';
import {BASKET_SCANNER} from '../server/src/paper/basket.ts';
import type {ExecutionPlan} from '../server/src/paper/executionPlans.ts';
export const BASKET_SHADOW_PLAN:ExecutionPlan={
 id:'basket-rsi-volume-eth-15m-v1',revision:1,enabled:true,scannerId:BASKET_SCANNER,
 symbol:'ETHUSD',tf:'15m',variant:'current',referenceEquity:1000,
 basket:'rsi-volume-ladder-v1',readingOverride:{version:1,reader:2},
 label:'RSI Volume Ladder basket · ETH 15m (experimental)',
};
export function enableBasketShadow(file:string,dryRun=false){
 const {deferred:_,...result}=enableAuthorShadow(file,dryRun,[BASKET_SHADOW_PLAN]);
 return {...result,marginBudget:150,maxLegs:3,perLegMarginLimit:50,
  verification:'Fresh production observations only. Scanning is not proof of an entry, add-on or completed exit.'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(enableBasketShadow(process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json'),process.argv.includes('--dry-run'))));
