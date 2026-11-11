/** Offline pinned input bundle: {job: WorkerJob without id, scanner: ScannerConfig, variantOf?}.
 * node server/src/cli/certify-scanner.ts input.json result.json
 * Keeps the exact input bundle with its result. No bot DB/configuration writes. */
import fs from 'node:fs';
import {PinePool,processWorker} from '../pine/pool.ts';
import {certifyContract} from '../scanners/certification.ts';
const [input,out]=process.argv.slice(2);if(!input||!out)throw Error('usage: input.json result.json');
const bundle=JSON.parse(fs.readFileSync(input,'utf8'));
if(!bundle.job?.bars?.length||typeof bundle.job.source!=='string')throw Error('missing source/bars');
const pool=new PinePool(1,120000,processWorker);
try{
 const result=await certifyContract({...bundle.job,tailBars:'all',plotTail:bundle.job.bars.length},bundle.scanner??{},job=>pool.run(job),bundle.variantOf);
 fs.writeFileSync(out,JSON.stringify({at:new Date().toISOString(),input:bundle,result},null,2),{flag:'wx',mode:0o600});
 console.log(JSON.stringify({output:out,status:result.status,checks:result.checks.length}));
}finally{await pool.stop();}
