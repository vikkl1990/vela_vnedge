import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {compareEventPlans,readPrefix,type RepaintCheck} from './repaint.ts';
import type {ScannerConfig} from '../config.ts';
import type {WorkerJob,WorkerResult} from '../pine/worker.ts';
type Job=Omit<WorkerJob,'id'>;
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const runtimeFiles=['../pine/worker.ts','../pine/provider.ts','../pine/strategyLedger.ts','../pine/libraries.ts','./extractor.ts','./reading.ts','./rules.ts','../../../package-lock.json'];
export const SCANNER_RUNTIME=sha(runtimeFiles.map(f=>readFileSync(new URL(f,import.meta.url),'utf8')).join('\n'));
export function contractIdentity(job:Job,sc:Partial<ScannerConfig>,variantOf?:string){return {
 source:sha(job.source),bars:sha(JSON.stringify(job.bars)),settings:sha(JSON.stringify({sc,inputs:job.inputs,timezone:job.timezone,tickSize:job.tickSize,symbol:job.symbol,tf:job.tf})),runtime:SCANNER_RUNTIME,node:process.version,
 variantOf:variantOf??null,from:job.bars[0]?.time??null,through:job.bars.at(-1)?.time??null,
 externalInputsFrozen:!/(?:request\s*\.\s*\w+|request_footprint)\s*\(/.test(job.source)&&!job.footprints,
};}
/** Research certification only; never mutates scanner health, configuration or promotion.
 * Each prefix ends on a confirmed bar; warm-up checks compare only the common mature interval.
 * Dynamic external series remain unknown until their input snapshots can be pinned too. */
export async function certifyContract(job:Job,sc:Partial<ScannerConfig>,run:(job:Job)=>Promise<WorkerResult>,variantOf?:string,
 opts:{cuts?:number[];warmupDrops?:number[];burnIn?:number}={}){
 const identity=contractIdentity(job,sc,variantOf),burn=opts.burnIn??200;
 const checks:Array<{kind:'prefix'|'warmup';bars:number;from:number;through:number;result?:RepaintCheck;error?:string}>=[];
 const full=await run(job);if(!full.ok||full.dataWarnings?.length)return {version:1,status:'unknown',identity,checks,error:full.error??full.dataWarnings?.join('; ')??'full run failed'};
 const events=readPrefix(full,job.bars,job.scannerId,sc,Infinity,job.source,variantOf);
 const variants=[...(opts.cuts??[1,2,5,60]).map(n=>({kind:'prefix' as const,bars:job.bars.slice(0,-n)})),
  ...(opts.warmupDrops??[Math.floor(job.bars.length/4),Math.floor(job.bars.length/2)]).map(n=>({kind:'warmup' as const,bars:job.bars.slice(n)}))];
 for(const v of variants){
  if(v.bars.length<=burn){checks.push({kind:v.kind,bars:v.bars.length,from:0,through:0,error:'insufficient warm-up bars'});continue;}
  const from=v.kind==='warmup'?v.bars[burn].time:job.bars[0].time,through=v.bars.at(-1)!.time;
  const base={kind:v.kind,bars:v.bars.length,from,through};
  try{const part=await run({...job,bars:v.bars,tailBars:'all',plotTail:v.bars.length});
   if(!part.ok||part.dataWarnings?.length){checks.push({...base,error:part.error??part.dataWarnings?.join('; ')??'prefix run failed'});continue;}
   const observed=readPrefix(part,v.bars,job.scannerId,sc,through,job.source,variantOf).filter(e=>e.barTime>=from);
   checks.push({...base,result:compareEventPlans(events.filter(e=>e.barTime>=from&&e.barTime<=through),observed)});
  }catch(e){checks.push({...base,error:String(e)});}
 }
 const changed=checks.some(c=>c.result&&c.result.changed>0),unknown=!identity.externalInputsFrozen||!checks.length||checks.some(c=>!c.result||c.result.coverage==='insufficient');
 return {version:1,status:changed?'unstable':unknown?'unknown':'stable-in-tested-windows',identity,checks,
  limitation:'Research result for these inputs and windows only. External higher-frame/footprint inputs must also be frozen; no admission or evidence rule changes.'};
}
