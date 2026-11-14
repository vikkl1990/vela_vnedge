/** Offline compatibility measurement. No accounts, orders, configuration or promotion writes. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PinePool,processWorker} from '../server/src/pine/pool.ts';
import {applyPatches} from '../server/src/pine/patches.ts';
const [cache,barsFile]=process.argv.slice(2);
if(!cache||!barsFile)throw new Error('usage: node ops/validate-markittick.ts CACHE_ROOT BARS_JSON');
const rows=JSON.parse(fs.readFileSync(path.join(cache,'markittick-fetch.json'),'utf8')).filter((r:any)=>r.status==='downloaded');
const raw=JSON.parse(fs.readFileSync(barsFile,'utf8')),bars=(raw.bars??raw).slice(-1000);
const pool=new PinePool(2,15000,i=>processWorker(i,512),6),results:any[]=[];
try{
 let next=0;
 await Promise.all(Array.from({length:2},async()=>{
  while(next<rows.length){
   const r=rows[next++],source=fs.readFileSync(path.join(cache,'author-cache',r.id+'.pine'),'utf8');
   const actual=createHash('sha256').update(source).digest('hex');if(actual!==r.sha256)throw new Error('source hash mismatch '+r.id);
   const patched=applyPatches(source,r.name+'.pine');
   const t=performance.now();const out=await pool.run({scannerId:'markittick-review-'+r.id,source:patched.source,symbol:'ETHUSD',tf:'15m',tickSize:.01,bars,tailBars:'all',plotTail:0});
   const row={id:r.id,name:r.name,sourceHash:actual,patchedHash:createHash('sha256').update(patched.source).digest('hex'),patches:patched.patches,ok:out.ok,error:out.error??null,ms:performance.now()-t,alerts:out.alerts?.length??0,shapes:out.shapes?.map(s=>({title:s.title,count:s.times.length})),alertTitles:[...new Set(out.alerts?.map(a=>a.title??a.type))]};
   results.push(row);console.log(JSON.stringify({id:r.id,ok:row.ok,ms:row.ms,error:row.error}));
   const file=path.join(cache,'markittick-runtime.json'),temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify({at:new Date().toISOString(),scope:'1000 real ETHUSD 15m closed bars; runtime only, not profitability or entry/exit certification',rows:results},null,2));fs.renameSync(temp,file);
  }
 }));
}finally{pool.stop();}
