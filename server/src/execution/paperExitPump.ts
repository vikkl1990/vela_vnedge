import type {ExitBook,ExitIntent} from '../paper/exitExecution.ts';
type PumpDeps={pending:()=>ExitIntent[];fetch:(symbol:string,readyAt:number)=>Promise<ExitBook>;apply:(symbol:string,book:ExitBook|null,at:number)=>void;now?:()=>number};

/** Public-read adapter. One request serves both books; no exchange order endpoint is used. */
export class PaperExitPump {
 private stopped=false;private busy=new Set<string>();private last=new Map<string,number>();private nextRequestAt=0;
 private deps:PumpDeps;
 constructor(deps:PumpDeps){this.deps=deps;}
 tick(){
  if(this.stopped||this.busy.size>=2)return;
  const now=this.deps.now?.()??Date.now();if(now<this.nextRequestAt)return;
  const i=this.deps.pending().filter(x=>x.ready_at<=now&&!this.busy.has(x.symbol)&&now-(this.last.get(x.symbol)??0)>=1000)
   .sort((a,b)=>(a.book===0?0:1)-(b.book===0?0:1)||(this.last.get(a.symbol)??0)-(this.last.get(b.symbol)??0)||a.ready_at-b.ready_at)[0];
  if(!i)return;
  this.busy.add(i.symbol);this.last.set(i.symbol,now);this.nextRequestAt=now+250;
  void this.deps.fetch(i.symbol,i.ready_at).then(book=>{if(!this.stopped)this.deps.apply(i.symbol,book,this.deps.now?.()??Date.now());},()=>{if(!this.stopped)this.deps.apply(i.symbol,null,this.deps.now?.()??Date.now());})
   .catch(()=>{/* Engine logs atomic settlement errors; retry retains the intent. */}).finally(()=>this.busy.delete(i.symbol));
 }
 stop(){this.stopped=true;}
}
