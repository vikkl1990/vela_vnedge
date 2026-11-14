import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

test('standalone backtest runs a configured retest reader instead of silently reporting no signals',{timeout:30000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'backtest-reading-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const id='zero-lag-ma-trend-levels-author-retests';
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({scanners:{[id]:{timezone:'America/New_York',inputs:{show_levl:true}}}}));
 // Public-data and runtime fixtures only: exercise the actual command without network or credentials.
 // An unnamed crossover diamond must not suppress the separately configured box-retest label.
 const preload=path.join(dir,'fixture.mjs');
 fs.writeFileSync(preload,`
 import assert from 'node:assert/strict';
 import {DeltaRest} from ${JSON.stringify(new URL('../delta/rest.ts',import.meta.url).href)};
 import {PinePool} from ${JSON.stringify(new URL('../pine/pool.ts',import.meta.url).href)};
 DeltaRest.prototype.product=async()=>({symbol:'ETHUSD',contract_value:'.01',tick_size:'.05',taker_commission_rate:'.0005',maker_commission_rate:'.0002',initial_margin:'.5',maintenance_margin:'.25'});
 DeltaRest.prototype.recentCandles=async()=>Array.from({length:50},(_,i)=>({time:1700000100+i*900,open:100,high:101,low:99,close:100,volume:1000}));
 PinePool.prototype.run=async function(job){
  assert.equal(job.inputs.show_levl,true);assert.equal(job.timezone,'America/New_York');
  assert.equal(job.plotTail,job.bars.length,'derivation needs the full historical plot window');
  return {id:1,ok:true,ms:1,bars:job.bars.length,lastBarTime:job.bars.at(-1).time,warnings:0,
   alerts:[],shapes:[{title:'',shape:'diamond',location:'absolute',times:[job.bars[20].time]}],
   labels:[{text:'▲',time:job.bars[19].time,createdAt:job.bars[20].time,y:100,style:'label_up'}],plots:[]};
 };
 `);
 const {stdout}=await promisify(execFile)(process.execPath,['--import',preload,new URL('./backtest.ts',import.meta.url).pathname,id,'ETHUSD','15m','50'],{
  env:{...process.env,VNEDGE_DATA_DIR:dir,LOG_LEVEL:'warn'},timeout:25000,maxBuffer:1024*1024,
 });
 assert.match(stdout,/events: 1 \(entries 1, exits 0\)/);
 assert.match(stdout,/reading [a-f0-9]+; account policy/);
 assert.match(stdout,/"source":"delta-product"/);
 assert.match(stdout,/candle-only research, not tape replay or promotion evidence/);
});
