/** Bounded, latest-bar-only shadow dispatch. Work not yet submitted to Pine stays cheap. */
export class ShadowDispatch<T> {
 private pending=new Map<string,{value:T;deadline:number;at:number}>();
 private busy=new Set<string>();
 private served=new Map<string,number>();
 private stopped=false;
 private serial=0;
 readonly counts={offered:0,replaced:0,expired:0,removed:0,started:0,finished:0,failed:0,maxPending:0,lastWaitMs:0,maxWaitMs:0,evidenceTurns:0,fairTurns:0,timelyTurns:0};
 private opts:{limit:()=>number;ready:()=>boolean;run:(v:T)=>Promise<void>;now?:()=>number;error?:(e:unknown,v:T)=>void;priority?:(v:T)=>number;timely?:(v:T)=>boolean;dropped?:(v:T,reason:'expired'|'removed')=>void};
 constructor(opts:ShadowDispatch<T>['opts']){this.opts=opts;}
 private now(){return this.opts.now?.()??Date.now();}
 get stats(){return {...this.counts,pending:this.pending.size,inFlight:this.busy.size};}
 enqueue(key:string,value:T,deadline:number){
  if(this.stopped)return;
  this.counts.offered++;
  if(this.pending.has(key))this.counts.replaced++;
  this.pending.set(key,{value,deadline,at:this.now()});
  this.counts.maxPending=Math.max(this.counts.maxPending,this.pending.size);
 }
 prune(keep:Set<string>){for(const key of this.pending.keys())if(!keep.has(key)){const p=this.pending.get(key)!;this.pending.delete(key);this.counts.removed++;this.opts.dropped?.(p.value,'removed');}for(const key of this.served.keys())if(!keep.has(key)&&!this.busy.has(key))this.served.delete(key);}
 drain(){
  if(this.stopped)return;
  const now=this.now();
  for(const [key,p]of this.pending)if(p.deadline<=now){this.pending.delete(key);this.counts.expired++;this.opts.dropped?.(p.value,'expired');}
  const limit=Math.max(1,this.opts.limit());
  while(this.pending.size>0&&this.busy.size<limit&&this.opts.ready()){
   // One of four starts can serve an explicitly watched research cell. Two retain
   // evidence priority; the fourth remains unconditional exploration. Unused turns
   // fall back to the original policy. This changes order, never admission/evidence.
   const timelyTurn=this.counts.started%4===0 && !!this.opts.timely &&
    [...this.pending].some(([key,p])=>!this.busy.has(key)&&this.opts.timely!(p.value));
   const evidenceTurn=!timelyTurn && !!this.opts.priority && this.counts.started%4!==3;
   let chosen:string|undefined,rank=Infinity,best=-Infinity;
   for(const [key,p] of this.pending)if(!this.busy.has(key)){
    if(timelyTurn&&!this.opts.timely!(p.value))continue;
    const r=this.served.get(key)??0;
    const raw=evidenceTurn?this.opts.priority!(p.value):0;
    const score=Number.isFinite(raw)?raw:0;
    if(score>best || (score===best && r<rank)){chosen=key;rank=r;best=score;}
   }
   if(chosen===undefined)break;
   const p=this.pending.get(chosen)!;this.pending.delete(chosen);this.busy.add(chosen);this.served.set(chosen,++this.serial);this.counts.started++;if(timelyTurn)this.counts.timelyTurns++;else if(evidenceTurn)this.counts.evidenceTurns++;else this.counts.fairTurns++;
   this.counts.lastWaitMs=now-p.at;this.counts.maxWaitMs=Math.max(this.counts.maxWaitMs,now-p.at);
   const key=chosen;
   void Promise.resolve().then(()=>this.opts.run(p.value)).then(()=>this.counts.finished++,e=>{this.counts.failed++;this.opts.error?.(e,p.value);}).finally(()=>{this.busy.delete(key);this.drain();});
  }
 }
 stop(){this.stopped=true;this.pending.clear();}
}
