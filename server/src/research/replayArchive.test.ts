import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ReplayArchive,readReplay,replayManifests,type ReplayEvent} from './replayArchive.ts';
import {DepthRecorder,crc32} from '../execution/depthRecorder.ts';
import {Db} from '../db.ts';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const T=1800000000000;
async function fixture(t:any,opts:Record<string,unknown>={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vnedge-replay-'));let now=T;
 const archive=new ReplayArchive({dir,now:()=>now,minFreeBytes:0,...opts});
 t.after(async()=>{await archive.close();await fs.rm(dir,{recursive:true,force:true});});
 return {dir,archive,advance:(ms:number)=>{now+=ms;},now:()=>now};
}
async function rows(dir:string){const out:ReplayEvent[]=[];for await(const r of readReplay(dir))out.push(r);return out;}
test('sealed replay preserves receipt time, ignores unselected pairs and verifies manifests',async t=>{
 const {dir,archive}=await fixture(t);archive.setSymbols(['INITUSD']);
 archive.record('INITUSD','trade',{timeMs:T-20,price:1,qty:4},T,'execution-feed');
 archive.record('INITUSD','trade_rejected',{reason:'stale trade arrival',eventAt:T-6000,ageMs:6000},T,'execution-feed');
 archive.record('INITUSD','paper_bar',{book:0,bar:{time:T-30000,open:1,high:2,low:.5,close:1,volume:4},historical:false},T,'paper-input');
 archive.record('OTHERUSD','trade',{price:2},T);await archive.flush();
 assert.equal(archive.status().lastSyncAt,T);await archive.close();
 const result=await rows(dir),trade=result.find(r=>r.kind==='trade')!;
 assert.equal(trade.receivedAt,T);assert.equal((trade.payload as any).timeMs,T-20);
 assert.equal(result.find(r=>r.kind==='trade_rejected')!.source,'execution-feed');
 assert.deepEqual(result.find(r=>r.kind==='paper_bar')!.payload,{book:0,bar:{time:T-30000,open:1,high:2,low:.5,close:1,volume:4},historical:false});
 assert.equal(result.filter(r=>r.symbol==='OTHERUSD').length,0);
 assert.equal(result[0].kind,'gap','startup boundary precedes the first captured event');
 const manifest=await replayManifests(dir);assert.equal(manifest.length,1);assert.equal(manifest[0].events,result.length);assert.equal(manifest[0].gaps,2);
});
test('archive and advisory checkpoints reproduce a book without touching execution tape',async t=>{
 const {dir,archive,advance,now}=await fixture(t);archive.setSymbols(['INITUSD']);
 const d=new Db(':memory:');t.after(()=>d.db.close());const original=new DepthRecorder(d,['INITUSD'],()=>{},false);
 original.setCapture((s,k,p,at)=>archive.record(s,k,p,at,'advisory-depth'));
 const snap={sy:'INITUSD',action:'snapshot',seq:1,ts:T*1000,a:[['101','3']],b:[['99','2']],cs:crc32('101:3|99:2')};
 original.onDepth(snap,T);advance(61000);
 original.onDepth({...snap,action:'update',seq:2,ts:now()*1000,a:[['101','0'],['102','5']],b:[],cs:crc32('102:5|99:2')},now());
 const expected=original.bookAt('INITUSD',now());await archive.close();
 const captured=await rows(dir),checkpoints=captured.filter(r=>r.kind==='checkpoint');assert.equal(checkpoints.length,2);
 assert.equal(checkpoints[1].receivedAt,now());assert.equal(d.get<any>('SELECT count(*) n FROM depth_tape')!.n,0);
 const reconstructed=new DepthRecorder(d,['INITUSD'],()=>{},false);
 for(const r of captured)if(['snapshot','update','checkpoint'].includes(r.kind))reconstructed.onDepth(r.payload,r.receivedAt);
 assert.deepEqual(reconstructed.bookAt('INITUSD',now()),expected);
});
test('sequence/checksum gaps are retained and no invented checkpoint makes them valid',async t=>{
 const {dir,archive}=await fixture(t);archive.setSymbols(['PARTIUSD']);const d=new Db(':memory:');t.after(()=>d.db.close());
 const r=new DepthRecorder(d,['PARTIUSD'],()=>{},false);r.setCapture((s,k,p,at)=>archive.record(s,k,p,at,'advisory-depth'));
 r.onDepth({sy:'PARTIUSD',action:'update',seq:2,ts:T*1000,a:[],b:[],cs:0},T);
 await archive.close();const captured=await rows(dir);assert.equal(captured.filter(r=>r.kind==='checkpoint').length,0);
 assert.ok(captured.some(r=>r.kind==='gap'&&r.symbol==='PARTIUSD'));
});
test('crashed journal recovers complete lines and marks its torn tail and downtime',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vnedge-recovery-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const id=`segment-${T}-abcdef`,event={version:1,receivedAt:T,symbol:'INITUSD',kind:'trade',source:'execution-feed',payload:{price:1}};
 await fs.writeFile(path.join(dir,id+'.open'),JSON.stringify(event)+'\n{"torn":');
 const a=new ReplayArchive({dir,now:()=>T+1000,minFreeBytes:0});await a.flush();await a.close();
 const result=await rows(dir);assert.equal(result.filter(r=>r.kind==='trade').length,1);
 assert.ok(result.some(r=>r.kind==='gap'&&String((r.payload as any).reason).includes('unclean shutdown')));
 assert.equal((await replayManifests(dir)).filter(m=>m.recovered).length,1);
 assert.equal((await fs.readdir(dir)).some(n=>n.endsWith('.open')),false);
});
test('a committed manifest prevents duplicate recovery of an orphan open journal',async t=>{
 const {dir,archive}=await fixture(t);archive.setSymbols(['INITUSD']);archive.record('INITUSD','trade',{price:1},T);await archive.close();
 const [m]=await replayManifests(dir);await fs.writeFile(path.join(dir,m.id+'.open'),JSON.stringify({version:1,receivedAt:T,symbol:'INITUSD',kind:'trade',source:'market',payload:{price:1}})+'\n');
 const resumed=new ReplayArchive({dir,now:()=>T+1,minFreeBytes:0});await resumed.flush();await resumed.close();
 assert.equal((await rows(dir)).filter(r=>r.kind==='trade').length,1);
});
test('corrupt archived bytes fail closed, never masquerade as an empty interval',async t=>{
 const {dir,archive}=await fixture(t);await archive.close();const [m]=await replayManifests(dir);
 await fs.appendFile(path.join(dir,m.id+'.ndjson.gz'),'corrupt');await assert.rejects(rows(dir),/checksum mismatch/);
});
test('disk reserve pauses bounded capture and recovery records lost events',async t=>{
 let free=0;const {dir,archive}=await fixture(t,{minFreeBytes:100,freeBytes:async()=>free,maxQueueBytes:2000});archive.setSymbols(['INITUSD']);
 for(let i=0;i<100;i++)archive.record('INITUSD','trade',{price:i},T+i);
 await archive.flush();assert.match(archive.status().lastError!,/free disk reserve/);assert.ok(archive.status().queuedBytes<=2000);assert.ok(archive.status().dropped>0);
 free=10000;await archive.flush();await archive.close();const result=await rows(dir);
 assert.ok(result.some(r=>r.kind==='gap'&&(r.payload as any).dropped>0));assert.equal(archive.status().lastError,null);
});
test('retention prunes complete old segments without deleting unrelated files',async t=>{
 const {dir,archive,advance,now}=await fixture(t,{keepDays:1,segmentMs:1});archive.setSymbols(['INITUSD']);archive.record('INITUSD','trade',{price:1},now());await archive.flush();
 advance(2);archive.record('INITUSD','trade',{price:2},now());await archive.flush();
 await fs.writeFile(path.join(dir,'keep.txt'),'keep');advance(2*86400000);archive.record('INITUSD','trade',{price:3},now());await archive.close();
 assert.ok(archive.status().prunedSegments>=1);assert.equal(await fs.readFile(path.join(dir,'keep.txt'),'utf8'),'keep');
 assert.ok((await replayManifests(dir)).every(m=>m.to>=now()-86400000));
});
test('same-millisecond segments preserve capture order and a throwing sink cannot alter books',async t=>{
 const {dir,archive}=await fixture(t,{maxSegmentBytes:180});archive.setSymbols(['INITUSD']);
 for(let i=0;i<8;i++)archive.record('INITUSD','trade',{n:i},T);await archive.close();
 assert.deepEqual((await rows(dir)).filter(r=>r.kind==='trade').map(r=>(r.payload as any).n),[0,1,2,3,4,5,6,7]);
 const d=new Db(':memory:');t.after(()=>d.db.close());const r=new DepthRecorder(d,['INITUSD'],()=>{},false);r.setCapture(()=>{throw Error('disk');});
 r.onDepth({sy:'INITUSD',action:'snapshot',seq:1,ts:T*1000,a:[['101','3']],b:[['99','2']],cs:crc32('101:3|99:2')},T);
 assert.equal(r.bookAt('INITUSD',T)!.asks[0].price,101);
});

test('a second writer cannot recover or overwrite the running writer journal',async t=>{
 const {dir,archive}=await fixture(t);archive.setSymbols(['INITUSD']);archive.record('INITUSD','trade',{price:1},T);await archive.flush();
 const second=new ReplayArchive({dir,now:()=>T,minFreeBytes:0});await second.flush();assert.match(second.status().lastError!,/active writer/);
 await second.close();assert.equal((await fs.readdir(dir)).filter(f=>f.endsWith('.open')).length,1);
 archive.record('INITUSD','trade',{price:2},T+1);await archive.close();assert.equal((await rows(dir)).filter(r=>r.kind==='trade').length,2);
});
test('missing interior segments are an error and byte retention removes oldest complete segments',async t=>{
 const {dir,archive}=await fixture(t,{maxSegmentBytes:180,maxBytes:900});archive.setSymbols(['INITUSD']);
 for(let i=0;i<20;i++)archive.record('INITUSD','trade',{n:i},T);await archive.close();
 assert.ok(archive.status().bytes<=900);assert.ok(archive.status().prunedSegments>0);
 const ms=await replayManifests(dir);assert.ok(ms.length>=3);await fs.unlink(path.join(dir,ms[1].id+'.json'));
 await assert.rejects(rows(dir),/missing or duplicate replay segment/);
});
test('an idle archive seals its durable journal at the segment deadline',async t=>{
 const {archive,advance}=await fixture(t,{segmentMs:100});archive.setSymbols(['INITUSD']);archive.record('INITUSD','trade',{price:1},T);await archive.flush();
 assert.equal(archive.status().segments,0);advance(101);await archive.flush();assert.equal(archive.status().segments,1);
});
test('overflow gap follows the retained prefix and precedes any resumed checkpoint',async t=>{
 const {dir,archive,advance,now}=await fixture(t,{maxQueueBytes:1500});archive.setSymbols(['INITUSD']);
 archive.record('INITUSD','checkpoint',{seq:1},now());
 for(let i=0;i<100;i++)archive.record('INITUSD','trade',{n:i},now());
 // Even a small checkpoint after an oversized event cannot sneak ahead of the loss boundary.
 archive.record('INITUSD','checkpoint',{seq:2},now());await archive.flush();advance(1);
 archive.record('INITUSD','checkpoint',{seq:3},now());await archive.close();const captured=await rows(dir);
 const lost=captured.findIndex(r=>r.kind==='gap'&&(r.payload as any).dropped>0);
 assert.ok(lost>captured.findIndex(r=>r.kind==='checkpoint'&&(r.payload as any).seq===1));
 assert.ok(lost>captured.findLastIndex(r=>r.kind==='trade'));
 assert.equal(captured.some(r=>r.kind==='checkpoint'&&(r.payload as any).seq===2),false);
 assert.ok(captured.findIndex(r=>r.kind==='checkpoint'&&(r.payload as any).seq===3)>lost);
});
test('export CLI preserves gap warnings, refuses overwrite and removes a corrupt partial export',async t=>{
 const {dir,archive}=await fixture(t);archive.setSymbols(['INITUSD']);archive.record('INITUSD','trade',{price:1},T);await archive.close();
 const out=dir+'-export.ndjson';t.after(()=>fs.rm(out,{force:true}));
 const cli=new URL('../cli/replay-export.ts',import.meta.url).pathname,args=[cli,dir,out,new Date(T).toISOString(),new Date(T+1000).toISOString(),'INITUSD'];
 await promisify(execFile)(process.execPath,args);const lines=(await fs.readFile(out,'utf8')).trim().split('\n').map(s=>JSON.parse(s));
 assert.match(lines[0].coverage,/Not asserted/);assert.equal(lines.filter(r=>r.kind==='trade').length,1);
 await assert.rejects(promisify(execFile)(process.execPath,args),/output already exists/);await fs.unlink(out);
 const [m]=await replayManifests(dir);await fs.appendFile(path.join(dir,m.id+'.ndjson.gz'),'corrupt');
 await assert.rejects(promisify(execFile)(process.execPath,args),/checksum mismatch/);await assert.rejects(fs.access(out));
});
