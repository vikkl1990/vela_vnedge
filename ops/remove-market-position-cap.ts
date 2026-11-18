#!/usr/bin/env node
/** Remove only the per-market count ceiling. Stop the service before writing. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ConfigStore,validateConfig} from '../server/src/config.ts';

export function removeMarketPositionCap(file:string,dryRun=false){
 const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
 if(cfg.execution.mode!=='paper'||cfg.execution.allowProduction)throw Error('Requires paper mode with production disabled');
 if(![0,1].includes(cfg.risk.maxPositionsPerSymbol))throw Error('Per-market count differs from the reviewed one-position setting');
 const revised={...cfg,risk:{...cfg.risk,maxPositionsPerSymbol:0}},errors=validateConfig(revised);
 if(errors.length)throw Error(errors.join('; '));
 const changed=cfg.risk.maxPositionsPerSymbol!==0;
 const result={changed,dryRun,maxPositionsPerSymbol:0,note:'No per-market count limit. Margin, stop-risk, other limits and evidence requirements remain unchanged.'};
 if(dryRun||!changed)return result;
 if(fs.readFileSync(file,'utf8')!==before)throw Error('Configuration changed during migration');
 const next={...raw,risk:{...raw.risk,maxPositionsPerSymbol:0}};
 const backup=`${file}.before-market-position-cap-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;
 fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
 try{
  fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{mode:fs.statSync(file).mode&0o777,flag:'wx'});
  fs.renameSync(tmp,file);
 }finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return {...result,backup};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
 console.log(JSON.stringify(removeMarketPositionCap(process.env.VNEDGE_CONFIG??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/config.json'),process.argv.includes('--dry-run'))));
