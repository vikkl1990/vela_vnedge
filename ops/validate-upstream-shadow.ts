/** Offline runtime/causality feasibility, not profitability or promotion evidence. */
import fs from 'node:fs';
import path from 'node:path';
import {PinePool} from '../server/src/pine/pool.ts';
import {ScannerRegistry} from '../server/src/scanners/registry.ts';
import {loadSpecs} from '../server/src/config.ts';
import {readingOf} from '../server/src/scanners/reading.ts';
import {applyRules} from '../server/src/scanners/rules.ts';
import {extractEvents} from '../server/src/scanners/extractor.ts';
import {UPSTREAM_SHADOW_PLANS} from './enable-upstream-shadow.ts';
import type {Bar} from '../server/src/data/candleStore.ts';
const [directory,output]=process.argv.slice(2);
if(!directory||!output)throw Error('usage: node ops/validate-upstream-shadow.ts BARS_DIRECTORY OUTPUT_JSON');
const registry=new ScannerRegistry(),specs=loadSpecs(),pool=new PinePool(1,30000);
const results=[];
try{
 for(const p of UPSTREAM_SHADOW_PLANS.filter(p=>p.comparison!.role==='candidate')){
  const s=registry.get(p.scannerId)!;if(s.status!=='ok')throw Error(s.reason??s.id);
  const bars:Bar[]=JSON.parse(fs.readFileSync(path.join(directory,p.symbol+'.json'),'utf8'));
  const r=await pool.run({scannerId:s.id,source:s.patched,symbol:p.symbol,tf:p.tf,tickSize:p.symbol==='SOLUSD'?.001:.01,bars,tailBars:'all',plotTail:bars.length});
  if(!r.ok)throw Error(s.id+': '+r.error);
  const read=readingOf(specs[s.id],s.id,900000,s.patched);
  const events=extractEvents(r.alerts,r.shapes,{...read.extract,derived:applyRules({...r,scannerId:s.id,bars,mode:'backtest',...read.rule})});
  const row={scannerId:s.id,symbol:p.symbol,tf:p.tf,bars:bars.length,lastClosedBar:bars.at(-1)!.time,ms:r.ms,entries:events.filter(e=>e.kind==='entry').length,exits:events.filter(e=>e.kind==='exit').length,amendments:events.filter(e=>e.exitType==='stop_update').length};
  results.push(row);console.log(JSON.stringify(row));
 }
 fs.writeFileSync(output,JSON.stringify({at:new Date().toISOString(),scope:'Actual closed Delta India bars; compatibility and signal feasibility only. No historical account/shadow writes or profit claim.',results},null,2)+'\n');
}finally{pool.stop();}
