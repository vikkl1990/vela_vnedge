import type {ExitBook,ExitIntent} from '../paper/exitExecution.ts';
export interface ExitPumpEvent {kind:'loop-delay'|'cache'|'fetch';at:number;symbol?:string;book?:number;readyAt?:number;startedAt?:number;receivedAt?:number;exchangeAt?:number;delayMs?:number;error?:string}
type PumpDeps={pending:()=>ExitIntent[];fetch:(symbol:string,readyAt:number)=>Promise<ExitBook>;apply:(symbol:string,book:ExitBook|null,at:number)=>void;now?:()=>number;
 cached?:(symbol:string,readyAt:number,at:number)=>ExitBook|null;paperExposure?:()=>boolean;observe?:(event:ExitPumpEvent)=>void};

/** Public-read adapter. One request serves both books; no exchange order endpoint is used. */
export class PaperExitPump {
 private stopped=false;private busy=new Map<string,number>();private last=new Map<string,number>();private nextRequestAt=0;private lastTick:number|null=null;
 private cachedApplied=new Map<string,string>();
 private deps:PumpDeps;
 constructor(deps:PumpDeps){this.deps=deps;}
 private observe(event:ExitPumpEvent){try{this.deps.observe?.(event);}catch{/* Diagnostics cannot prevent a protective exit. */}}
 tick(){
  if(this.stopped)return;
  const now=this.deps.now?.()??Date.now();
  if(this.lastTick!==null&&now-this.lastTick>1000)this.observe({kind:'loop-delay',at:now,delayMs:now-this.lastTick-100});
  this.lastTick=now;
  // A verified stream does not consume a REST slot. In particular, a slow public
  // request for research must not hold an already executable account exit.
  const due=this.deps.pending().filter(i=>i.ready_at<=now).sort((a,b)=>(a.book===0?0:1)-(b.book===0?0:1)||a.ready_at-b.ready_at);
  const symbols=new Set<string>();
  for(const i of due){
   if(symbols.has(i.symbol))continue;symbols.add(i.symbol);
   let b:ExitBook|null|undefined;
   try{b=this.deps.cached?.(i.symbol,i.ready_at,now);}catch{continue;}
   if(!b||b.receivedAt<i.ready_at||[b.receivedAt,b.exchangeAt].some(t=>!Number.isFinite(t)||t<=0||t>now||now-t>1000))continue;
   // Distinct depth updates can share a millisecond; timestamps alone would
   // suppress replenishment needed by a partially filled exit.
   const key=JSON.stringify([b.receivedAt,b.exchangeAt,b.bids,b.asks]);
   if(this.cachedApplied.get(i.symbol)===key)continue;
   this.cachedApplied.set(i.symbol,key);
   this.observe({kind:'cache',at:now,symbol:i.symbol,book:i.book,readyAt:i.ready_at,receivedAt:b.receivedAt,exchangeAt:b.exchangeAt});
   try{this.deps.apply(i.symbol,b,now);}catch{/* Durable engine intent remains available for retry. */}
  }
  for(const s of this.cachedApplied.keys())if(!symbols.has(s))this.cachedApplied.delete(s);
  if(this.busy.size>=2||now<this.nextRequestAt)return;
  const i=this.deps.pending().filter(x=>x.ready_at<=now&&!this.busy.has(x.symbol)&&now-(this.last.get(x.symbol)??0)>=1000)
   // Keep one slot available while account exposure exists; total concurrency and
   // request rate stay bounded. Without exposure, research may use both slots.
   .filter(x=>x.book===0||!this.deps.paperExposure?.()||![...this.busy.values()].includes(2))
   .sort((a,b)=>(a.book===0?0:1)-(b.book===0?0:1)||(this.last.get(a.symbol)??0)-(this.last.get(b.symbol)??0)||a.ready_at-b.ready_at)[0];
  if(!i)return;
  this.busy.set(i.symbol,i.book);this.last.set(i.symbol,now);this.nextRequestAt=now+250;
  void this.deps.fetch(i.symbol,i.ready_at).then(book=>{if(!this.stopped){const at=this.deps.now?.()??Date.now();this.observe({kind:'fetch',at,symbol:i.symbol,book:i.book,readyAt:i.ready_at,startedAt:now,receivedAt:book.receivedAt,exchangeAt:book.exchangeAt});this.deps.apply(i.symbol,book,at);}},error=>{if(!this.stopped){const at=this.deps.now?.()??Date.now();this.observe({kind:'fetch',at,symbol:i.symbol,book:i.book,readyAt:i.ready_at,startedAt:now,error:String(error?.message??error).slice(0,200)});this.deps.apply(i.symbol,null,at);}})
   .catch(()=>{/* Engine logs atomic settlement errors; retry retains the intent. */}).finally(()=>this.busy.delete(i.symbol));
 }
 stop(){this.stopped=true;}
}
