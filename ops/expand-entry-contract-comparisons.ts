#!/usr/bin/env node
/** Prospective comparisons only; never rewrite existing plans or admit cells to paper. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {enableEntryContracts,makeContractPlans} from './enable-entry-contract-comparisons.ts';

export const EXPANSION_CELLS = [
 {name:'smart-money',contract:'smart-money-retests-v1',symbol:'SOLUSD',tf:'15m'},
 {name:'smart-money',contract:'smart-money-retests-v1',symbol:'DOGEUSD',tf:'15m'},
 {name:'smart-money',contract:'smart-money-retests-v1',symbol:'LINKUSD',tf:'15m'},
 {name:'smart-money',contract:'smart-money-retests-v1',symbol:'BTCUSD',tf:'1h'},
 {name:'smart-money',contract:'smart-money-retests-v1',symbol:'BNBUSD',tf:'1h'},
 {name:'smart-money',contract:'smart-money-retests-v1',symbol:'ETHUSD',tf:'1h'},
 {name:'ml-rsi',contract:'ml-rsi-classifier-v1',symbol:'BTCUSD',tf:'15m'},
 {name:'ml-rsi',contract:'ml-rsi-classifier-v1',symbol:'DOGEUSD',tf:'15m'},
 {name:'ml-rsi',contract:'ml-rsi-classifier-v1',symbol:'BTCUSD',tf:'1h'},
 {name:'ml-rsi',contract:'ml-rsi-classifier-v1',symbol:'ETHUSD',tf:'1h'},
 {name:'ml-rsi',contract:'ml-rsi-classifier-v1',symbol:'AVAXUSD',tf:'1h'},
 {name:'ml-rsi',contract:'ml-rsi-classifier-v1',symbol:'SOLUSD',tf:'1h'},
] satisfies Parameters<typeof makeContractPlans>[0];
export const EXPANSION_PLANS=makeContractPlans(EXPANSION_CELLS);
export function expandEntryContracts(file:string,dryRun=false,expectedHash?:string){
 return enableEntryContracts(file,dryRun,expectedHash,undefined,EXPANSION_PLANS);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const dry=process.argv.includes('--dry-run');
 if(!dry&&spawnSync('systemctl',['is-active','--quiet','vnedge']).status===0)throw Error('Stop service before activating comparisons');
 console.log(JSON.stringify(expandEntryContracts(process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json'),dry,process.env.VNEDGE_EXPECTED_CONFIG_HASH)));
}
