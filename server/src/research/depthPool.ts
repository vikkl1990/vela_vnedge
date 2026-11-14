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
  const symbols=[...new Set(input)].filter(s=>/^[A-Z0-9]{2,24}USD$/.test(s)).sort();
  this.recorder.setSymbols(symbols);
  const count=Math.ceil(symbols.length/100);
  while(this.shards.length>count)this.shards.pop()!.feed.stop();
  for(let i=0;i<count;i++){
   const wanted=symbols.slice(i*100,(i+1)*100);let shard=this.shards[i];
   if(!shard){
    shard={feed:this.factory(),symbols:[],connected:false};this.shards.push(shard);
    const current=shard;
    shard.feed.on('depth',(m:unknown)=>this.recorder.onDepth(m));
    shard.feed.on('status',({connected}:{connected:boolean})=>{current.connected=connected;if(!connected)this.recorder.invalidateSymbols(current.symbols);});
    shard.symbols=wanted;shard.feed.subscribe('ob_updates',wanted);shard.feed.start();
   }else{
    const removed=shard.symbols.filter(s=>!wanted.includes(s)),added=wanted.filter(s=>!shard.symbols.includes(s));
    this.recorder.invalidateSymbols([...removed,...added]);
    if(removed.length)shard.feed.unsubscribe('ob_updates',removed);
    if(added.length)shard.feed.subscribe('ob_updates',added);
    shard.symbols=wanted;
   }
  }
 }
 summary(){return {symbols:this.recorder.symbols.length,connections:this.shards.length,connected:this.shards.filter(s=>s.connected).length};}
 stop(){this.stopped=true;for(const s of this.shards)s.feed.stop();this.shards=[];this.recorder.disconnect();}
}
