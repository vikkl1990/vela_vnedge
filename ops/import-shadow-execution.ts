/** Stopped-service-only import of reviewed replay cohorts. Never changes config,
 * trades, risk settings or forward restoration enrollment. */
import fs from 'node:fs';
import path from 'node:path';
import {Db} from '../server/src/db.ts';
import {DEFAULT_CONFIG} from '../server/src/config.ts';
import {PaperEngine} from '../server/src/paper/engine.ts';
import {ScannerRegistry} from '../server/src/scanners/registry.ts';
import {sourceHash} from '../server/src/paper/fingerprint.ts';
import {requireReadinessMaintenance} from '../server/src/analytics/readinessReplayImport.ts';
import {importShadowCohorts,type ShadowExecutionCohort} from '../server/src/evidence/shadowExecution.ts';
const args=process.argv.slice(2),arg=(n:string)=>args[args.indexOf(n)+1];
for(const n of ['--db','--report','--sha256'])if(!args.includes(n)||!arg(n)||arg(n).startsWith('--'))throw Error(`Required ${n}`);
if(!fs.existsSync(arg('--db')))throw Error('existing journal required');
const configPath=path.join(path.dirname(arg('--db')),'config.json'),configBytes=fs.readFileSync(configPath);
const cfg={...structuredClone(DEFAULT_CONFIG),...JSON.parse(configBytes.toString())};
if(cfg.execution.mode!=='paper'||cfg.execution.allowProduction!==false)throw Error('paper mode with production disabled required');
const report=JSON.parse(fs.readFileSync(arg('--report'),'utf8')) as {cohorts:ShadowExecutionCohort[]};
requireReadinessMaintenance();
const db=new Db(arg('--db')),policyDb=new Db(':memory:');
try{
 // Policy resolution must not run pending-order recovery on the real journal.
 const engine=new PaperEngine(policyDb,()=>cfg);
 const registry=new ScannerRegistry();engine.sourceHashFor=id=>sourceHash(registry.get(id)?.patched);
 for(const cohort of report.cohorts)if(engine.policyForCell(cohort.policy).strategyId!==cohort.policy.strategyId)throw Error('deployed strategy differs from reviewed replay');
 const result=importShadowCohorts(db,report.cohorts,arg('--sha256'));
 if(!fs.readFileSync(configPath).equals(configBytes))throw Error('configuration changed during import');
 console.log(JSON.stringify({...result,configUnchanged:true}));
}finally{policyDb.db.close();db.db.close();}
