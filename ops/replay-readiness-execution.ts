/** Offline first. Optional --record writes audit receipts only, never orders or policies.
 * Input bundle: a read-only journal export plus filtered, checksum-verified archive
 * events with their original segment ordinal / line index. No candle synthesis. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {Db} from '../server/src/db.ts';
import {DEFAULT_CONFIG} from '../server/src/config.ts';
import {PaperEngine} from '../server/src/paper/engine.ts';
import {FundingJournal} from '../server/src/execution/fundingJournal.ts';
import type {TradePolicy} from '../server/src/paper/tradePolicy.ts';
import {executionPolicyCompatible,replayReadinessExecution,recordExecutionReplay,type ExecutionReplayEvent} from '../server/src/analytics/readinessExecutionReplay.ts';

const args=process.argv.slice(2),arg=(name:string)=>args[args.indexOf(name)+1];
for(const name of ['--snapshot','--events','--manifest','--catalog','--output'])if(!args.includes(name)||!arg(name)||arg(name).startsWith('--'))throw Error(`Required ${name}`);
const snapshot=JSON.parse(zlib.gunzipSync(fs.readFileSync(arg('--snapshot'))).toString());
const manifest=JSON.parse(fs.readFileSync(arg('--manifest'),'utf8'));
const compressed=fs.readFileSync(arg('--events'));
if(createHash('sha256').update(compressed).digest('hex')!==manifest.outputSha256)throw Error('filtered archive checksum mismatch');
if(!manifest.segments?.length||manifest.segments.some((s:any,i:number)=>! /^[a-f0-9]{64}$/.test(s.sha256)||!Number.isSafeInteger(s.ordinal)||(i&&s.ordinal!==manifest.segments[i-1].ordinal+1)))throw Error('invalid or non-consecutive archive manifests');
const catalog=JSON.parse(fs.readFileSync(arg('--catalog'),'utf8')) as Array<{id:number;current:TradePolicy}>;
if(snapshot.config.execution.mode!=='paper')throw Error('paper snapshot required');
const db=new Db(':memory:');new PaperEngine(db,()=>structuredClone(DEFAULT_CONFIG));
new FundingJournal(db);
const allowed=new Set(['positions','trade_policies','orders','entry_fill_evidence','entry_execution','paper_execution_positions','paper_stop_amendments','paper_exit_intents','decision_trace','evidence_flags','paper_basket_entries','position_path','paper_exit_reports','signals','readiness_execution_replays','funding_settlements']);
for(const [table,rows] of Object.entries(snapshot.tables) as [string,Record<string,any>[]][]){
 if(!allowed.has(table))throw Error('unsupported snapshot table');if(!rows.length)continue;
 const columns=db.all<{name:string}>(`PRAGMA table_info(${table})`).map(c=>c.name),keys=Object.keys(rows[0]);
 if(keys.some(k=>!columns.includes(k)))throw Error('unsupported snapshot columns');
 const statement=db.db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`);
 db.transaction(()=>{for(const row of rows)statement.run(...keys.map(k=>row[k]??null));});
}
const bySymbol=new Map<string,ExecutionReplayEvent[]>(),globals:ExecutionReplayEvent[]=[],gaps:Array<{from:number;to:number}>=[];
let count=0,sequence=-1,previousAt=manifest.segments[0].from;
for await(const line of readline.createInterface({input:fs.createReadStream(arg('--events')).pipe(zlib.createGunzip())})){
 const e=JSON.parse(line) as ExecutionReplayEvent;
 if(!Number.isSafeInteger(e.archiveSequence)||e.archiveSequence<=sequence)throw Error('missing archive order');sequence=e.archiveSequence;count++;
 if(e.kind==='gap'&&e.source==='archive')gaps.push({from:Math.min(previousAt,e.receivedAt),to:Math.max(previousAt,e.receivedAt)});
 previousAt=e.receivedAt;
 if(!['trade','mark','paper_bar','gap','selection'].includes(e.kind))continue;
 if(e.kind==='paper_bar'&&(e.source!=='paper-input'||e.payload.book!==0))continue;
 if(e.symbol==='*')globals.push(e);else{const rows=bySymbol.get(e.symbol)??[];rows.push(e);bySymbol.set(e.symbol,rows);}
}
if(count!==manifest.events)throw Error('filtered event count mismatch');
const coverage={from:manifest.segments[0].from,to:Math.min(previousAt,manifest.segments.at(-1).to),sha256:manifest.outputSha256,segments:manifest.segments.length,verified:true,gaps};
let live:Db|undefined;
if(args.includes('--record')){
 const file=arg('--record');if(!file||!fs.existsSync(file))throw Error('existing database required');
 const cfg=JSON.parse(fs.readFileSync(path.join(path.dirname(file),'config.json'),'utf8'));
 if(cfg.execution?.mode!=='paper'||cfg.execution?.allowProduction!==false)throw Error('recording requires paper mode and disabled production');
 live=new Db(file);
}
const results=[];
try{
 for(const item of catalog){
  const r=db.get<any>('SELECT * FROM positions WHERE id=?',item.id);if(!r)continue;
  const row=db.get<{snapshot:string}>('SELECT snapshot FROM trade_policies WHERE id=?',r.policy_id);if(!row)continue;
  const old=JSON.parse(row.snapshot) as TradePolicy;
  if(!executionPolicyCompatible(db,r.id,old,item.current))continue;
  const events=[...(bySymbol.get(r.symbol)??[]),...globals].filter(e=>e.receivedAt>=r.entry_at-60000&&e.receivedAt<=r.exit_at).sort((a,b)=>a.archiveSequence-b.archiveSequence);
  const window=manifest.windows?.[r.symbol]?.find((w:any)=>Array.isArray(w)&&w.length===2&&Number.isFinite(w[0])&&Number.isFinite(w[1])&&w[0]<=r.entry_at-60000&&w[1]>=r.exit_at);
  const selected={...coverage,verified:!!window,selectionWindow:window?{symbol:r.symbol,from:window[0],to:window[1]}:undefined};
  const result=replayReadinessExecution(db,r.id,old,item.current,events,selected);
  if(live)recordExecutionReplay(live,result);
  results.push(result);
  if(results.length%25===0)process.stderr.write(JSON.stringify({processed:results.length})+'\n');
 }
 const grouped=Object.fromEntries(Object.entries(Object.groupBy(results,r=>r.reason)).map(([reason,rows])=>[reason,rows!.length]));
 fs.writeFileSync(arg('--output'),JSON.stringify({at:Date.now(),coverage,grouped,results},null,2),{mode:0o600});
 console.log(JSON.stringify({processed:results.length,recorded:!!live,grouped,output:arg('--output')}));
}finally{live?.db.close();db.db.close();}
