import type {Db} from '../db.ts';
import {toMs,type WsTrade} from '../delta/ws.ts';
const MAX_LEVELS=10000,MAX_BYTES=128*1024;
export function crc32(s:string):number {let c=0xffffffff;for(const v of Buffer.from(s)){c^=v;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
type Book={seq:number;asks:Map<number,[string,string]>;bids:Map<number,[string,string]>};
/** Bounded diagnostic ring, independent of the execution path. A replay must start at a retained snapshot. */
export class DepthRecorder {
 private books=new Map<string,Book>();private queue:Array<[number,string,string,string,number]>=[];private dropped=0;private failures=0;private lastRetry=new Map<string,number>();
 private db:Db; readonly symbols:string[]; private retry:(symbol:string)=>void;
 constructor(db:Db,symbols=['BTCUSD','ETHUSD','SOLUSD'],retry:(symbol:string)=>void=()=>{}){this.db=db;this.symbols=symbols;this.retry=retry;db.db.exec(`CREATE TABLE IF NOT EXISTS depth_tape(id INTEGER PRIMARY KEY AUTOINCREMENT,received_at INTEGER NOT NULL,symbol TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,bytes INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS depth_tape_at ON depth_tape(received_at);`);}
 private record(symbol:string,kind:string,value:unknown,now:number){const payload=JSON.stringify(value),bytes=Buffer.byteLength(payload);if(bytes>MAX_BYTES||this.queue.length>=2000){this.dropped++;return;}this.queue.push([now,symbol,kind,payload,bytes]);}
 private invalid(symbol:string,why:string,now:number){this.books.delete(symbol);this.failures++;this.record(symbol,'gap',{why},now);if(now-(this.lastRetry.get(symbol)??0)>=5000){this.lastRetry.set(symbol,now);this.retry(symbol);}}
 disconnect(now=Date.now()){for(const s of this.symbols){this.books.delete(s);this.record(s,'gap',{why:'disconnect or restart'},now);}}
 onDepth(m:any,now=Date.now()){
  const symbol=String(m.sy??m.symbol??'');if(!this.symbols.includes(symbol))return;
  if(m.action==='error'){this.invalid(symbol,'exchange snapshot error',now);return;}
  if(!['snapshot','update'].includes(m.action)||!Number.isSafeInteger(m.seq)||!Number.isInteger(m.cs)||!Array.isArray(m.a)||!Array.isArray(m.b)){this.invalid(symbol,'invalid envelope',now);return;}
  const old=this.books.get(symbol);
  if(m.action==='update'&&(!old||m.seq!==old.seq+1)){this.invalid(symbol,'sequence gap',now);return;}
  const book:Book=m.action==='snapshot'?{seq:m.seq,asks:new Map(),bids:new Map()}:old!;
  for(const [rows,side] of [[m.a,book.asks],[m.b,book.bids]] as const)for(const pair of rows){
   if(!Array.isArray(pair)||pair.length!==2||!Number.isFinite(Number(pair[0]))||!(Number(pair[0])>0)||!Number.isFinite(Number(pair[1]))||Number(pair[1])<0){this.invalid(symbol,'invalid level',now);return;}
   const [p,q]=pair.map(String);if(Number(q)===0)side.delete(Number(p));else side.set(Number(p),[p,q]);
   if(side.size>MAX_LEVELS){this.invalid(symbol,'depth exceeds memory cap',now);return;}
  }
  const asks=[...book.asks.entries()].sort((a,b)=>a[0]-b[0]),bids=[...book.bids.entries()].sort((a,b)=>b[0]-a[0]);
  const encode=(v:typeof asks)=>v.slice(0,10).map(([,x])=>x.join(':')).join(',');
  if((asks.length&&bids.length&&asks[0][0]<=bids[0][0])||crc32(encode(asks)+'|'+encode(bids))!==(m.cs>>>0)){this.invalid(symbol,'checksum or crossed book',now);return;}
  if(!toMs(m.ts,0)||Math.abs(now-toMs(m.ts,0))>10000){this.invalid(symbol,'stale depth',now);return;}
  book.seq=m.seq;this.books.set(symbol,book);this.record(symbol,m.action,m,now);
 }
 onTrade(t:WsTrade,now=Date.now()){if(this.symbols.includes(t.symbol))this.record(t.symbol,'trade',t,now);}
 flush(now=Date.now()){
  if(this.dropped){this.queue.unshift([now,'*','gap',JSON.stringify({dropped:this.dropped}),64]);this.dropped=0;}
  const batch=this.queue;this.queue=[];
  try{this.db.transaction(()=>{
   for(const row of batch)this.db.run('INSERT INTO depth_tape(received_at,symbol,kind,payload,bytes) VALUES(?,?,?,?,?)',...row);
   this.db.run('DELETE FROM depth_tape WHERE received_at<? OR id<=(SELECT max(id)-50000 FROM depth_tape)',now-86400000);
   const size=this.db.get<any>('SELECT coalesce(sum(bytes),0) n FROM depth_tape')!.n;
   if(size>32*1024*1024){const rows=this.db.all<any>('SELECT id,bytes FROM depth_tape ORDER BY id');let left=size,cut=0;for(const r of rows){if(left<=24*1024*1024)break;left-=r.bytes;cut=r.id;}if(cut)this.db.run('DELETE FROM depth_tape WHERE id<=?',cut);}
  });}catch(e){this.dropped+=batch.length;throw e;}
 }
 summary(){return {symbols:this.symbols,validBooks:[...this.books.keys()],failures:this.failures,queued:this.queue.length,droppedPending:this.dropped,retention:'24h / 50k events / 32MiB payload ring; replay starts at first retained snapshot',stored:this.db.get<any>('SELECT count(*) n,min(received_at) oldest,max(received_at) newest,sum(bytes) bytes FROM depth_tape')};}
}
