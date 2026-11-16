import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {turnoverAlignment} from '../server/src/incubator/turnoverAlignment.ts';
import type {AppConfig} from '../server/src/config.ts';

export function alignResearchTurnover(file:string,dryRun=false) {
  const before=fs.readFileSync(file,'utf8'),cfg=JSON.parse(before) as AppConfig;
  const result=turnoverAlignment(cfg);
  if(dryRun||!result.changes.length)return {dryRun,changed:!!result.changes.length,floor:result.floor,changes:result.changes};
  const backup=`${file}.before-turnover-alignment-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
  fs.writeFileSync(tmp,JSON.stringify(result.config,null,2)+'\n',{mode:0o600,flag:'wx'});
  try {
    if(fs.readFileSync(file,'utf8')!==before)throw Error('Configuration changed during alignment');
    fs.renameSync(tmp,file);
  } finally {if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
  return {dryRun,changed:true,floor:result.floor,changes:result.changes,backup};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const file=process.argv.find(a=>a.startsWith('--config='))?.slice(9)??'data/config.json';
  console.log(JSON.stringify(alignResearchTurnover(file,process.argv.includes('--dry-run')),null,2));
}
