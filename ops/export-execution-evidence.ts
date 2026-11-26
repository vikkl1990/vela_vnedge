/** node ops/export-execution-evidence.ts --db FILE --from ISO --as-of ISO --out FILE
 * Produces a durable snapshot, with no database migrations, config writes or runtime changes. */
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {exportExecutionEvidence,snapshotHash} from '../server/src/research/executionEvidence.ts';
export function exportArgs(args:string[]){
 const accepted=new Set(['--db','--from','--as-of','--out']),options:Record<string,string>={};
 for(let i=0;i<args.length;i+=2){const k=args[i],v=args[i+1];if(!accepted.has(k)||!v||v.startsWith('--')||options[k])throw Error('Required: --db FILE --from UTC_ISO --as-of UTC_ISO --out NEW_FILE');options[k]=v;}
 if(Object.keys(options).length!==4)throw Error('All four options are required; no rolling/current-time defaults');
 const time=(s:string)=>{if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(s)||!Number.isFinite(Date.parse(s)))throw Error('Use an explicit UTC ISO timestamp');return Date.parse(s);};
 return {db:path.resolve(options['--db']),out:path.resolve(options['--out']),from:time(options['--from']),asOf:time(options['--as-of'])};
}
export function checkoutDirty(cwd:string|URL=new URL('..',import.meta.url)){
 const r=spawnSync('git',['diff','--quiet','HEAD'],{cwd,stdio:['ignore','ignore','pipe'],encoding:'utf8'});
 if(r.error||r.status!==0&&r.status!==1)throw Error('Cannot verify exporter checkout state');
 return r.status===1;
}
export function main(args=process.argv.slice(2)){
 const a=exportArgs(args);if(fs.existsSync(a.out))throw Error('Output exists; choose a new immutable snapshot filename');
 const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:new URL('..',import.meta.url),encoding:'utf8'}).trim();
 const dirty=checkoutDirty();
 const db=new DatabaseSync(a.db,{readOnly:true});
 try{
  const data=exportExecutionEvidence(db,{from:a.from,asOf:a.asOf,repositoryCommit:commit});
  if(dirty){data.manifest.warnings.push('Exporter checkout has uncommitted changes; save the accompanying patch with this run');}
  data.manifest.snapshotHash=snapshotHash(data);
  fs.mkdirSync(path.dirname(a.out),{recursive:true});
  const temp=`${a.out}.${process.pid}.tmp`;
  try{fs.writeFileSync(temp,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});fs.linkSync(temp,a.out);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  console.log(JSON.stringify({out:a.out,...data.summary,dataHash:data.manifest.dataHash}));
 }finally{db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main();
