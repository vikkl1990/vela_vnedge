/** One-cell paper pricing migration. Run with vnedge stopped; never prints credentials. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ConfigStore,validateConfig} from '../config.ts';

export function enableLabQuoteMaker(file:string,dryRun=false){
 const before=fs.readFileSync(file,'utf8'),raw=JSON.parse(before),cfg=new ConfigStore(file).get();
 if(cfg.execution.mode!=='paper'||cfg.execution.allowProduction||cfg.paper.marginPerTrade!==150||cfg.paper.maxStopLossPct!==3)throw Error('Expected paper mode, production disabled, $150 margin and 3% stop cap');
 const cell={scannerId:'macd',symbol:'LABUSD',tf:'1h'};
 const existing=cfg.paper.makerQuoteCells??[];
 const changed=!existing.some(r=>r.scannerId===cell.scannerId&&r.symbol===cell.symbol&&r.tf===cell.tf);
 const cells=changed?[...existing,cell]:existing;
 const errors=validateConfig({...cfg,paper:{...cfg.paper,makerQuoteCells:cells}});
 if(errors.length)throw Error('Configuration validation failed: '+errors.join('; '));
 if(dryRun||!changed)return {changed,dryRun,cell};
 const next=structuredClone(raw);next.paper.makerQuoteCells=cells;
 if(fs.readFileSync(file,'utf8')!==before)throw Error('Configuration changed during migration; retry with service stopped');
 const backup=`${file}.before-lab-quote-maker-${Date.now()}`,tmp=`${file}.${process.pid}.tmp`;
 fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
 try{fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{mode:fs.statSync(file).mode&0o777,flag:'wx'});fs.renameSync(tmp,file);}
 finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return {changed,dryRun,cell,backup};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const file=process.env.VNEDGE_CONFIG;
 if(!file)throw Error('VNEDGE_CONFIG is required');
 console.log(JSON.stringify(enableLabQuoteMaker(file,process.argv.includes('--dry-run'))));
}
