/** Import a reviewed replay report during the existing deployment stop window.
 * Run the expensive replay first, without --record, while paper keeps running. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Db} from '../server/src/db.ts';
import {requireReadinessMaintenance,importReadinessReceipts} from '../server/src/analytics/readinessReplayImport.ts';
import type {TradePolicy} from '../server/src/paper/tradePolicy.ts';

const args=process.argv.slice(2),arg=(name:string)=>args[args.indexOf(name)+1];
for(const key of ['--db','--report','--catalog','--sha256'])if(!args.includes(key)||!arg(key)||arg(key).startsWith('--'))throw Error(`Required ${key}`);
const file=arg('--db');assert.ok(fs.existsSync(file),'existing database required');
const configFile=path.join(path.dirname(file),'config.json'),raw=fs.readFileSync(configFile),cfg=JSON.parse(raw.toString());
assert.equal(cfg.execution?.mode,'paper');assert.equal(cfg.execution?.allowProduction,false);
const report=JSON.parse(fs.readFileSync(arg('--report'),'utf8'));
assert.ok(Array.isArray(report.results));
const catalog=new Map<number,TradePolicy>(JSON.parse(fs.readFileSync(arg('--catalog'),'utf8')).map((r:any)=>[r.id,r.current]));
requireReadinessMaintenance(); // Before Db's schema/migration writes, not merely before import.
const db=new Db(file);
try{
 const result=importReadinessReceipts(db,report.results,catalog,arg('--sha256'));
 assert.ok(fs.readFileSync(configFile).equals(raw),'configuration changed during import');
 console.log(JSON.stringify({at:Date.now(),...result,mode:'paper',configUnchanged:true}));
}finally{db.db.close();}
