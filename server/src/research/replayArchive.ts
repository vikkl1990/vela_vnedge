import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';

const compress=promisify(gzip),decompress=promisify(gunzip);
const DAY=86400000,GiB=1024**3;
const NAME=/^segment-\d+-[a-f0-9-]+$/;
export interface ReplayEvent {version:1;receivedAt:number;symbol:string;kind:string;source:string;payload:unknown}
export interface ReplaySegment {version:1;id:string;ordinal:number;from:number;to:number;events:number;bytes:number;rawBytes:number;sha256:string;symbols:string[];checkpoints:Record<string,number>;gaps:number;recovered:boolean}
export interface ReplayArchiveOptions {
 dir:string;keepDays?:number;maxBytes?:number;minFreeBytes?:number;maxQueueBytes?:number;segmentMs?:number;maxSegmentBytes?:number;
 now?:()=>number;freeBytes?:()=>Promise<number>;
}
type Active={id:string;handle:Awaited<ReturnType<typeof fs.open>>;rows:ReplayEvent[];bytes:number;openedAt:number};
/** Observation only. Bounded memory; async I/O/compression; fsynced open journals survive a crash.
 * Immutable gzip segments have a checksum manifest. Retention is a bound, not promised coverage. */
export class ReplayArchive {
 readonly dir:string;private cfg:Required<Omit<ReplayArchiveOptions,'freeBytes'>>;private freeBytes:()=>Promise<number>;
 private selected=new Set<string>();private queue:string[]=[];private queueBytes=0;private active:Active|null=null;
 private chain:Promise<void>;private stopping=false;private dropped=0;private lost=0;private failures=0;private lastError:string|null=null;
 private lastSyncAt:number|null=null;private lastEventAt:number|null=null;private segments:ReplaySegment[]=[];private pruned=0;
 private initialized=false;private lastPrune=0;
 private nextOrdinal=0;
 private lockNonce=randomUUID();private hasLock=false;
 private writeGap=0;private closing:Promise<void>|null=null;private closed=false;
 constructor(o:ReplayArchiveOptions){
  this.dir=o.dir;this.cfg={dir:o.dir,keepDays:o.keepDays??14,maxBytes:o.maxBytes??16*GiB,minFreeBytes:o.minFreeBytes??2*GiB,
   maxQueueBytes:o.maxQueueBytes??16*1024**2,segmentMs:o.segmentMs??60000,maxSegmentBytes:o.maxSegmentBytes??8*1024**2,now:o.now??Date.now};
  this.freeBytes=o.freeBytes??(async()=>{const s=await fs.statfs(this.dir);return s.bavail*s.bsize;});
  this.enqueue({version:1,receivedAt:this.cfg.now(),symbol:'*',kind:'gap',source:'archive',payload:{reason:'process start; replay requires a new observed checkpoint'}});
  this.chain=this.initialize().catch(e=>this.failure(e));
 }
 private failure(e:unknown){this.failures++;this.lastError=String((e as Error)?.message??e).slice(0,300);}
 private enqueue(e:ReplayEvent){
  if(this.stopping)return;
  const line=JSON.stringify(e)+'\n',bytes=Buffer.byteLength(line);
  // After a loss, retain only the prefix: a later checkpoint must not hide the gap.
  if(this.lost||bytes>1024**2||this.queueBytes+bytes>this.cfg.maxQueueBytes){this.dropped++;this.lost++;return;}
  this.queue.push(line);this.queueBytes+=bytes;
 }
 setSymbols(symbols:string[],at=this.cfg.now()){
  const next=new Set(symbols.filter(s=>/^[A-Z0-9]{2,24}USD$/.test(s)));
  const added=[...next].filter(s=>!this.selected.has(s)),removed=[...this.selected].filter(s=>!next.has(s));
  this.selected=next;
  if(added.length||removed.length)this.enqueue({version:1,receivedAt:at,symbol:'*',kind:'selection',source:'archive',payload:{added,removed}});
 }
 record(symbol:string,kind:string,payload:unknown,receivedAt=this.cfg.now(),source='market'){
  if(!this.selected.has(symbol)&&symbol!=='*')return;
  if(!Number.isFinite(receivedAt)||receivedAt<=0){this.dropped++;this.lost++;return;}
  try{this.enqueue({version:1,receivedAt,symbol,kind,source,payload});}catch(e){this.dropped++;this.lost++;this.failure(e);}
 }
 private async atomic(file:string,data:string|Buffer){
  const h=await fs.open(file+'.part','w',0o600);
  try{await h.writeFile(data);await h.sync();}finally{await h.close();}
  await fs.rename(file+'.part',file);
 }
 private async seal(id:string,rows:ReplayEvent[],recovered=false){
  if(!rows.length){await fs.unlink(path.join(this.dir,id+'.open')).catch(()=>{});return;}
  const raw=Buffer.from(rows.map(r=>JSON.stringify(r)+'\n').join('')),data=await compress(raw);
  const checkpoints:Record<string,number>={};for(const r of rows)if(['snapshot','checkpoint'].includes(r.kind))checkpoints[r.symbol]=(checkpoints[r.symbol]??0)+1;
  const m:ReplaySegment={version:1,id,ordinal:this.nextOrdinal+1,from:rows.reduce((v,r)=>Math.min(v,r.receivedAt),Infinity),to:rows.reduce((v,r)=>Math.max(v,r.receivedAt),0),events:rows.length,
   bytes:data.length,rawBytes:raw.length,sha256:createHash('sha256').update(data).digest('hex'),symbols:[...new Set(rows.map(r=>r.symbol))].sort(),checkpoints,gaps:rows.filter(r=>r.kind==='gap').length,recovered};
  await this.atomic(path.join(this.dir,id+'.ndjson.gz'),data);
  await this.atomic(path.join(this.dir,id+'.json'),JSON.stringify(m)+'\n');
  // A committed manifest is authoritative if a crash leaves its old .open journal behind.
  const dir=await fs.open(this.dir,'r');try{await dir.sync();}finally{await dir.close();}
  this.nextOrdinal=m.ordinal;
  this.segments=this.segments.filter(s=>s.id!==id);this.segments.push(m);
  await fs.unlink(path.join(this.dir,id+'.open')).catch(()=>{});
 }
 private async initialize(){
  await fs.mkdir(this.dir,{recursive:true,mode:0o700});
  if(!this.hasLock)await this.acquireLock();
  this.segments=await replayManifests(this.dir);
  this.nextOrdinal=this.segments.reduce((v,s)=>Math.max(v,s.ordinal),0);
  for(const file of (await fs.readdir(this.dir)).sort()){
   const id=file.replace(/\.open$/,'');if(!file.endsWith('.open')||!NAME.test(id))continue;
   if(this.segments.some(s=>s.id===id)){await fs.unlink(path.join(this.dir,file));continue;}
   const stat=await fs.stat(path.join(this.dir,file));if(stat.size>64*1024**2)throw Error(`oversized replay recovery journal: ${file}`);
   const text=await fs.readFile(path.join(this.dir,file),'utf8'),rows:ReplayEvent[]=[];
   for(const line of text.split('\n')){if(!line)continue;try{const r=JSON.parse(line);validateEvent(r);rows.push(r);}catch{break;}}
   rows.push({version:1,receivedAt:this.cfg.now(),symbol:'*',kind:'gap',source:'archive',payload:{reason:'unclean shutdown; incomplete journal tail and downtime are not reconstructed'}});
   await this.seal(id,rows,true);
  }
  await this.prune();this.initialized=true;
 }
 private async acquireLock(){
  const file=path.join(this.dir,'writer.lock');
  try{
   const h=await fs.open(file,'wx',0o600);
   try{await h.writeFile(JSON.stringify({pid:process.pid,nonce:this.lockNonce}));await h.sync();this.hasLock=true;}finally{await h.close();}
  }catch(e:any){
   if(e.code!=='EEXIST')throw e;
   const previous=await fs.readFile(file,'utf8'),owner=JSON.parse(previous);
   if(!Number.isSafeInteger(owner.pid)||owner.pid<=0)throw Error('replay writer lock is invalid; requires inspection');
   let alive=true;try{process.kill(owner.pid,0);}catch(error:any){if(error.code==='ESRCH')alive=false;else throw error;}
   if(alive)throw Error(`replay archive already has an active writer (pid ${owner.pid})`);
   if(await fs.readFile(file,'utf8')!==previous)throw Error('replay writer lock changed during recovery');
   await fs.unlink(file);await this.acquireLock();
  }
 }
 private async prune(){
  const now=this.cfg.now(),cut=now-this.cfg.keepDays*DAY;
  this.segments.sort((a,b)=>a.ordinal-b.ordinal);let bytes=this.segments.reduce((n,s)=>n+s.bytes,0);
  while(this.segments.length&&(this.segments[0].to<cut||bytes>this.cfg.maxBytes)){
   const s=this.segments[0];await fs.unlink(path.join(this.dir,s.id+'.json'));
   await fs.unlink(path.join(this.dir,s.id+'.ndjson.gz')).catch(e=>{if(e.code!=='ENOENT')throw e;});
   bytes-=s.bytes;this.segments.shift();this.pruned++;
  }
  this.lastPrune=now;
 }
 /** Serializes flushes. Recording never awaits disk and cannot interrupt an execution decision. */
 flush():Promise<void>{
  if(this.closed)return this.chain;
  this.chain=this.chain.then(async()=>{
   if(!this.initialized)await this.initialize();
   if(this.cfg.now()-this.lastPrune>=60000)await this.prune();
   if(this.active&&this.cfg.now()-this.active.openedAt>=this.cfg.segmentMs)await this.closeSegment();
   if(!this.queue.length&&!this.lost&&!this.writeGap)return;
   if(await this.freeBytes()<this.cfg.minFreeBytes)throw Error('replay capture paused: free disk reserve reached');
   if(this.writeGap){const e:ReplayEvent={version:1,receivedAt:this.cfg.now(),symbol:'*',kind:'gap',source:'archive',payload:{reason:'previous write failed; continuity unverified',unconfirmed:this.writeGap}};this.queue.unshift(JSON.stringify(e)+'\n');this.writeGap=0;}
   if(this.lost){const e:ReplayEvent={version:1,receivedAt:this.cfg.now(),symbol:'*',kind:'gap',source:'archive',payload:{reason:'capture buffer overflow or invalid event; continuity ends after retained prefix',dropped:this.lost}};this.queue.push(JSON.stringify(e)+'\n');this.lost=0;}
   // Detach only after checking disk; retries cannot accumulate unbounded batches.
   const lines=this.queue;this.queue=[];this.queueBytes=0;
   try{
    for(let i=0;i<lines.length;){
     if(this.active&&(this.cfg.now()-this.active.openedAt>=this.cfg.segmentMs||this.active.bytes>=this.cfg.maxSegmentBytes))await this.closeSegment();
     if(!this.active){const id=`segment-${this.cfg.now()}-${randomUUID()}`;this.active={id,handle:await fs.open(path.join(this.dir,id+'.open'),'wx',0o600),rows:[],bytes:0,openedAt:this.cfg.now()};}
     const batch:string[]=[],rows:ReplayEvent[]=[];let bytes=0;
     while(i<lines.length){const line=lines[i],n=Buffer.byteLength(line);if(batch.length&&this.active.bytes+bytes+n>this.cfg.maxSegmentBytes)break;
      batch.push(line);rows.push(JSON.parse(line));bytes+=n;i++;}
     await this.active.handle.writeFile(batch.join(''));for(const row of rows)this.active.rows.push(row);this.active.bytes+=bytes;this.lastEventAt=rows.at(-1)!.receivedAt;
     if(i<lines.length)await this.closeSegment();
    }
    if(this.active)await this.active.handle.sync();this.lastSyncAt=this.cfg.now();this.lastError=null;
   }catch(e){
    // A write can have an unknown partial tail. Preserve the journal for recovery,
    // close it and explicitly invalidate continuity before the next checkpoint.
    this.writeGap+=lines.length;this.dropped+=lines.length;this.initialized=false;
    if(this.active){await this.active.handle.close().catch(()=>{});this.active=null;}
    throw e;
   }
  }).catch(e=>this.failure(e));return this.chain;
 }
 private async closeSegment(){
  const a=this.active;if(!a)return;await a.handle.sync();await a.handle.close();this.active=null;
  await this.seal(a.id,a.rows);await this.prune();
 }
 close():Promise<void>{return this.closing??=this.finishClose();}
 private async finishClose(){
  this.record('*','gap',{reason:'capture stopped; subsequent market events are unobserved'},this.cfg.now(),'archive');
  this.stopping=true;await this.flush();await this.chain;
  try{await this.closeSegment();}catch(e){this.failure(e);if(this.active){await this.active.handle.close().catch(()=>{});this.active=null;}}
  if(this.hasLock){try{const file=path.join(this.dir,'writer.lock'),owner=JSON.parse(await fs.readFile(file,'utf8'));if(owner.nonce===this.lockNonce)await fs.unlink(file);}catch(e){this.failure(e);}this.hasLock=false;}
  this.closed=true;
 }
 status(){
  const ordered=[...this.segments].sort((a,b)=>a.from-b.from);
  return {enabled:true,ready:this.initialized,symbols:[...this.selected].sort(),queuedBytes:this.queueBytes,dropped:this.dropped,failures:this.failures,lastError:this.lastError,
   lastSyncAt:this.lastSyncAt,lastEventAt:this.lastEventAt,segments:ordered.length,bytes:ordered.reduce((n,s)=>n+s.bytes,0),oldest:ordered[0]?.from??null,newest:ordered.at(-1)?.to??null,
   openEvents:this.active?.rows.length??0,prunedSegments:this.pruned,retention:{targetDays:this.cfg.keepDays,maxBytes:this.cfg.maxBytes,minFreeBytes:this.cfg.minFreeBytes},
   coverage:'Observed events only; check checkpoints and gap records. Retention is bounded by age and bytes. Open journal fsynced on flush.'};
 }
}
function validateEvent(r:any):asserts r is ReplayEvent{
 if(r?.version!==1||!Number.isFinite(r.receivedAt)||r.receivedAt<=0||typeof r.symbol!=='string'||typeof r.kind!=='string'||typeof r.source!=='string'||!('payload' in r))throw Error('invalid replay event');
}
export async function replayManifests(dir:string):Promise<ReplaySegment[]>{
 const out:ReplaySegment[]=[];
 for(const f of await fs.readdir(dir)){
  const id=f.replace(/\.json$/,'');if(!f.endsWith('.json')||!NAME.test(id))continue;
  const m=JSON.parse(await fs.readFile(path.join(dir,f),'utf8'));
  if(m.version!==1||m.id!==id||!Number.isSafeInteger(m.ordinal)||m.ordinal<1||!Number.isFinite(m.from)||!Number.isFinite(m.to)||m.to<m.from||!Number.isSafeInteger(m.events)||m.events<1||!Number.isSafeInteger(m.bytes)||m.bytes<1||!Number.isSafeInteger(m.rawBytes)||m.rawBytes>64*1024**2||! /^[a-f0-9]{64}$/.test(m.sha256))throw Error(`invalid replay manifest: ${f}`);
  out.push(m);
 }
 out.sort((a,b)=>a.ordinal-b.ordinal||a.id.localeCompare(b.id));
 for(let i=1;i<out.length;i++)if(out[i].ordinal!==out[i-1].ordinal+1)throw Error(`missing or duplicate replay segment between ordinals ${out[i-1].ordinal} and ${out[i].ordinal}`);
 return out;
}
/** Strict reader for sealed segments. Never pretends a corrupt or missing segment is empty. */
export async function* readReplay(dir:string,{from=0,to=Infinity,symbols=[]}:{from?:number;to?:number;symbols?:string[]}={}){
 for(const m of await replayManifests(dir)){
  if(m.to<from||m.from>to)continue;
  const data=await fs.readFile(path.join(dir,m.id+'.ndjson.gz'));
  if(data.length!==m.bytes||createHash('sha256').update(data).digest('hex')!==m.sha256)throw Error(`replay checksum mismatch: ${m.id}`);
  const raw=await decompress(data,{maxOutputLength:64*1024**2});if(raw.length!==m.rawBytes)throw Error(`replay length mismatch: ${m.id}`);
  const rows=raw.toString().trimEnd().split('\n');if(rows.length!==m.events)throw Error(`replay event count mismatch: ${m.id}`);
  for(const line of rows){const r=JSON.parse(line);validateEvent(r);if(r.receivedAt>=from&&r.receivedAt<=to&&(!symbols.length||r.symbol==='*'||symbols.includes(r.symbol)))yield r as ReplayEvent;}
 }
}
