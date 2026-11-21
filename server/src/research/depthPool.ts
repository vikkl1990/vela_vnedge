import {DeltaFeed} from '../delta/ws.ts';
import {DepthRecorder} from '../execution/depthRecorder.ts';
import type {Db} from '../db.ts';

type Feed=Pick<DeltaFeed,'start'|'stop'|'subscribe'|'unsubscribe'> & {on(event:string|symbol,listener:(...args:any[])=>void):unknown};
/** Advisory sockets never enter the execution feed. Delta limits ob_updates to 100 symbols/socket. */
export class AdvisoryDepthPool {
 readonly recorder:DepthRecorder;
 private shards:Array<{feed:Feed;symbols:string[];connected:boolean}>=[];
 private factory:()=>Feed;private stopped=false;
 constructor(db:Db,factory:()=>Feed=()=>new DeltaFeed()){
  this.factory=factory;
  this.recorder=new DepthRecorder(db,[],s=>{const shard=this.shards.find(x=>x.symbols.includes(s));if(shard){shard.feed.unsubscribe('ob_updates',[s]);shard.feed.subscribe('ob_updates',[s]);}},false);
 }
 setSymbols(input:string[]){
  if(this.stopped)return;
  const symbols=[...new Set(input)].filter(s=>/^[A-Z0-9]{1,24}USD$/.test(s)).sort();
  this.recorder.setSymbols(symbols);
  // Preserve socket ownership for retained symbols. Re-sorting shard boundaries on
  // every addition used to invalidate otherwise healthy books across all sockets.
  const wanted=new Set(symbols),assigned=new Set<string>();
  for(const shard of this.shards){
   const removed=shard.symbols.filter(s=>!wanted.has(s));
   shard.symbols=shard.symbols.filter(s=>wanted.has(s));
   if(removed.length)shard.feed.unsubscribe('ob_updates',removed);
   shard.symbols.forEach(s=>assigned.add(s));
  }
  const added=symbols.filter(s=>!assigned.has(s));
  for(const shard of this.shards){
   const next=added.splice(0,100-shard.symbols.length);
   shard.symbols.push(...next);
   if(next.length)shard.feed.subscribe('ob_updates',next);
  }
  while(added.length){
   const shard={feed:this.factory(),symbols:added.splice(0,100),connected:false};
   this.shards.push(shard);
   // Ignore any late event from a retired socket; ownership is explicit.
   shard.feed.on('depth',(m:any)=>{if(shard.symbols.includes(String(m.sy??m.symbol??'')))this.recorder.onDepth(m);});
   shard.feed.on('status',({connected}:{connected:boolean})=>{shard.connected=connected;if(!connected)this.recorder.invalidateSymbols(shard.symbols);});
   shard.feed.subscribe('ob_updates',shard.symbols);shard.feed.start();
  }
  this.shards=this.shards.filter(shard=>{if(shard.symbols.length)return true;shard.feed.stop();return false;});
 }
 summary(){return {symbols:this.recorder.symbols.length,connections:this.shards.length,connected:this.shards.filter(s=>s.connected).length};}
 stop(){this.stopped=true;for(const s of this.shards)s.feed.stop();this.shards=[];this.recorder.disconnect();}
}
