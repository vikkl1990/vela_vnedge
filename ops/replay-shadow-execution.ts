/** Offline shadow execution replay. Keeps a bounded per-symbol working set and
 * emits only complete, equivalent cohorts for a separately reviewed import. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {Db} from '../server/src/db.ts';
import {DEFAULT_CONFIG} from '../server/src/config.ts';
import {PaperEngine} from '../server/src/paper/engine.ts';
import {FundingJournal} from '../server/src/execution/fundingJournal.ts';
import {replayShadowExecution,validateShadowCohort,shadowReplayDigest,importShadowCohorts,type ShadowExecutionCohort} from '../server/src/evidence/shadowExecution.ts';
import {readEvidence,qualifiedEvidence} from '../server/src/evidence/trades.ts';
import {mirrorRefusal} from '../server/src/incubator/gate.ts';
import type {TradePolicy} from '../server/src/paper/tradePolicy.ts';
import type {ExecutionReplayEvent} from '../server/src/analytics/readinessExecutionReplay.ts';

function group<T>(rows:T[],key:(r:T)=>string):Record<string,T[]> {
 const out:Record<string,T[]>=Object.create(null);
 for(const row of rows)(out[key(row)]??=[]).push(row);
 return out;
}
const args=process.argv.slice(2),arg=(n:string)=>args[args.indexOf(n)+1];
for(const n of ['--snapshot','--events','--manifest','--catalog','--output'])if(!args.includes(n)||!arg(n)||arg(n).startsWith('--'))throw Error(`Required ${n}`);
const snapshot=JSON.parse(zlib.gunzipSync(fs.readFileSync(arg('--snapshot'))).toString());
const manifest=JSON.parse(fs.readFileSync(arg('--manifest'),'utf8'));
const digest=createHash('sha256');for await(const chunk of fs.createReadStream(arg('--events')))digest.update(chunk);
if(digest.digest('hex')!==manifest.outputSha256)throw Error('filtered archive checksum mismatch');
if(!manifest.segments?.length||manifest.segments.some((s:any,i:number)=>! /^[a-f0-9]{64}$/.test(s.sha256)||!Number.isSafeInteger(s.ordinal)||(i&&s.ordinal!==manifest.segments[i-1].ordinal+1)))throw Error('invalid archive manifests');
const catalog=JSON.parse(fs.readFileSync(arg('--catalog'),'utf8')) as Array<{id:number;symbol:string;current:TradePolicy}>;
if(snapshot.config.execution.mode!=='paper'||snapshot.config.execution.allowProduction!==false)throw Error('paper snapshot required');
const db=new Db(':memory:');new PaperEngine(db,()=>structuredClone(DEFAULT_CONFIG));new FundingJournal(db);
const allowed=new Set(['positions','trade_policies','orders','entry_fill_evidence','entry_execution','paper_execution_positions','paper_stop_amendments','paper_exit_intents','decision_trace','evidence_flags','paper_basket_entries','paper_exit_reports','signals','readiness_execution_replays','funding_settlements','incubator_pairs','evidence_restorations']);
for(const [table,rows] of Object.entries(snapshot.tables) as [string,Record<string,any>[]][]){
 if(!allowed.has(table))throw Error(`unsupported snapshot table ${table}`);if(!rows.length)continue;
 const columns=db.all<{name:string}>(`PRAGMA table_info(${table})`).map(c=>c.name),keys=Object.keys(rows[0]);
 if(keys.some(k=>!columns.includes(k)))throw Error('unsupported snapshot columns');
 const statement=db.db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`);
 db.transaction(()=>{for(const row of rows)statement.run(...keys.map(k=>row[k]??null));});
}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vnedge-shadow-replay-')),files=new Map<string,{file:string;fd:number}>();
const globals:ExecutionReplayEvent[]=[],gaps:Array<{from:number;to:number}>=[];
let count=0,sequence=-1,previousAt=manifest.segments[0].from;
const results=[];
try {
 for await(const line of readline.createInterface({input:fs.createReadStream(arg('--events')).pipe(zlib.createGunzip())})){
  const e=JSON.parse(line) as ExecutionReplayEvent;
  // Capture order is global; timestamps are checked per affected trade by the kernel.
  if(!Number.isSafeInteger(e.archiveSequence)||e.archiveSequence<=sequence||!Number.isFinite(e.receivedAt))throw Error('invalid archive order');sequence=e.archiveSequence;count++;
  if(e.kind==='gap'&&e.source==='archive')gaps.push({from:Math.min(previousAt,e.receivedAt),to:e.receivedAt});previousAt=e.receivedAt;
  if(!['trade','mark','paper_bar','gap','selection'].includes(e.kind))continue;
  if(e.kind==='paper_bar'&&(e.source!=='paper-input'||e.payload.book!==2))continue;
  if(e.symbol==='*'){globals.push(e);continue;}
  let out=files.get(e.symbol);if(!out){const file=path.join(dir,String(files.size));out={file,fd:fs.openSync(file,'wx',0o600)};files.set(e.symbol,out);}
  fs.writeSync(out.fd,line+'\n');
 }
 for(const f of files.values()){fs.closeSync(f.fd);f.fd=-1;}
 if(count!==manifest.events)throw Error('filtered event count mismatch');
 const coverage={from:manifest.segments[0].from,to:manifest.segments.at(-1).to,sha256:manifest.outputSha256,segments:manifest.segments.length,verified:true,gaps};
 for(const [symbol,items] of Object.entries(group(catalog,c=>c.symbol))){
  const file=files.get(symbol)?.file,rows:ExecutionReplayEvent[]=file?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  for(const item of items!){
   const r=db.get<any>('SELECT * FROM positions WHERE id=?',item.id);if(!r)throw Error('missing subject');
   const old=JSON.parse(db.get<{snapshot:string}>('SELECT snapshot FROM trade_policies WHERE id=?',r.policy_id)!.snapshot) as TradePolicy;
   const events=[...rows.filter(e=>e.receivedAt>=r.entry_at-60000&&e.receivedAt<=r.exit_at),...globals.filter(e=>e.receivedAt>=r.entry_at-60000&&e.receivedAt<=r.exit_at)].sort((a,b)=>a.archiveSequence-b.archiveSequence);
   const window=manifest.windows?.[symbol]?.find((w:any)=>Array.isArray(w)&&w.length===2&&w[0]<=r.entry_at-60000&&w[1]>=r.exit_at);
   results.push(replayShadowExecution(db,r.id,old,item.current,events,{...coverage,verified:!!window,selectionWindow:window?{symbol,from:window[0],to:window[1]}:undefined}));
   if(results.length%50===0)process.stderr.write(JSON.stringify({processed:results.length,total:catalog.length})+'\n');
  }
 }
 const policies=new Map(catalog.map(c=>[c.current.id,c.current])),cohorts:ShadowExecutionCohort[]=[],held=[];
 const from=snapshot.manifests[0].from+60000,to=snapshot.manifests.at(-1).to;
 for(const [id,rs] of Object.entries(group(results,r=>r.currentId))){
  const policy=policies.get(id)!;
  const cohort:ShadowExecutionCohort={version:1,from,to,policy,results:rs!};
  const ids=validateShadowCohort(db,cohort,policy,to);
  if(ids.length)cohorts.push(cohort);else held.push({scannerId:policy.scannerId,symbol:policy.symbol,tf:policy.tf,trades:rs!.length,reasons:Object.fromEntries(Object.entries(group(rs!,r=>r.reason)).map(([k,v])=>[k,v!.length]))});
 }
 const before=new Map(cohorts.map(c=>{const p=c.policy;return [p.strategyId,qualifiedEvidence(db,p,p,{at:to})];}));
 importShadowCohorts(db,cohorts,shadowReplayDigest(cohorts),()=>{},to);
 const restored=cohorts.map(c=>{const p=c.policy,after=qualifiedEvidence(db,p,p,{at:to}),beforeTrades=before.get(p.strategyId)!;
  return {scannerId:p.scannerId,symbol:p.symbol,tf:p.tf,restored:c.results.length,before:beforeTrades.length,after:after.length,
   netR:after.reduce((n,t)=>n+t.r,0),beforeReason:mirrorRefusal(snapshot.config.incubator.mirror,beforeTrades,null),afterReason:mirrorRefusal(snapshot.config.incubator.mirror,after,null),
   restoredButForwardHeld:!after.length&&readEvidence(db,p,p,{at:to}).length>0};});
 const report={at:Date.now(),from,to,coverage,grouped:Object.fromEntries(Object.entries(group(results,r=>r.reason)).map(([k,v])=>[k,v!.length])),results,held,restored,cohorts,cohortsSha256:shadowReplayDigest(cohorts)};
 fs.writeFileSync(arg('--output'),JSON.stringify(report),{mode:0o600});
 console.log(JSON.stringify({processed:results.length,grouped:report.grouped,cohorts:cohorts.length,restoredTrades:cohorts.reduce((n,c)=>n+c.results.length,0),qualityPass:restored.filter(r=>!r.afterReason&&!r.restoredButForwardHeld).length,output:arg('--output')}));
}finally{for(const f of files.values())if(f.fd>=0)fs.closeSync(f.fd);fs.rmSync(dir,{recursive:true,force:true});db.db.close();}
