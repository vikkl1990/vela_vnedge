import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {FocusedReplay,EXIT_STUDY_SYMBOLS} from './focusedReplay.ts';
import {readReplay} from './replayArchive.ts';
const T=1800000000000;
test('study replay keeps the three pairs and explicit gaps even when the broad universe rotates',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'focused-replay-'));
 const r=new FocusedReplay({dir,now:()=>T,freeBytes:async()=>10*1024**3});t.after(async()=>{await r.close();await fs.rm(dir,{recursive:true,force:true});});
 r.setSymbols(['BTCUSD']);for(const symbol of [...EXIT_STUDY_SYMBOLS,'BTCUSD'])r.record(symbol,'trade',{price:1},T);
 r.setSymbols([]);r.record('PARTIUSD','study_position_sample',{positionId:123,price:1},T+1);r.record('*','gap',{reason:'disconnect'},T+2);
 await r.close();const rows=[];for await(const e of readReplay(r.study.dir))rows.push(e);
 assert.deepEqual(rows.filter(r=>r.kind==='trade').map(r=>r.symbol),[...EXIT_STUDY_SYMBOLS]);assert.ok(rows.some(r=>r.kind==='study_position_sample'));assert.ok(rows.some(r=>(r.payload as any).reason==='disconnect'));
 assert.equal(r.status().entryInvalidationStudy.retention.maxBytes,4*1024**3);assert.equal(r.status().entryInvalidationStudy.retention.targetDays,21);
});
test('focused capture disk reserve fails observably without throwing or stopping the broad archive',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'focused-reserve-'));
 const r=new FocusedReplay({dir,now:()=>T,freeBytes:async()=>3*1024**3});t.after(async()=>{await r.close();await fs.rm(dir,{recursive:true,force:true});});
 r.setSymbols([]);r.record('INITUSD','trade',{price:1},T);await r.flush();
 assert.equal(r.status().failures,0);assert.match(r.status().entryInvalidationStudy.lastError!,/free disk reserve/);assert.ok(r.status().entryInvalidationStudy.failures>0);
});
