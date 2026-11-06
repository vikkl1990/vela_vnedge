import {createHash} from 'node:crypto';
import type {Db} from '../db.ts';

export interface EntryCandidate {key:string;scannerId:string;symbol:string;tf:string;barTime:number}
/** Stable within the same ready-set/window; changes across windows to avoid lexical starvation. */
export function orderEntries<T extends EntryCandidate>(items:T[],window:number):T[] {
 const rank=(c:T)=>createHash('sha256').update(`${window}|${c.scannerId}|${c.symbol}|${c.tf}|${c.key}`).digest('hex');
 return items.map(c=>({c,rank:rank(c)})).sort((a,b)=>a.rank.localeCompare(b.rank)||a.c.key.localeCompare(b.c.key)).map(r=>r.c);
}
type Task={candidate:EntryCandidate;run:()=>unknown;resolve:(v:any)=>void;reject:(e:unknown)=>void};
/** Depth/feature preparation happens before submission. Protection never enters this queue. */
export class EntryCoordinator {
 private db:Db;private delay:()=>number;private now:()=>number;
 private windows=new Map<number,{timer:ReturnType<typeof setTimeout>;tasks:Task[]}>();private stopped=false;
 constructor(db:Db,delay:()=>number,now:()=>number=Date.now){
  this.db=db;this.delay=delay;this.now=now;
  db.run('CREATE TABLE IF NOT EXISTS entry_batches(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,window_at INTEGER NOT NULL,width_ms INTEGER NOT NULL,candidates TEXT NOT NULL,outcomes TEXT NOT NULL)');
 }
 enqueue<T>(candidate:EntryCandidate,run:()=>T):Promise<T>{
  if(this.stopped)return Promise.reject(Error('entry coordinator stopped; receipt retained'));
  const width=Math.max(0,Math.min(5000,this.delay()));
  if(!width)return Promise.resolve().then(run);
  const now=this.now(),window=Math.floor(now/width)*width;
  return new Promise((resolve,reject)=>{
   let group=this.windows.get(window);
   if(!group){group={timer:setTimeout(()=>this.flush(window,width),Math.max(1,window+width-now)),tasks:[]};this.windows.set(window,group);}
   group.tasks.push({candidate,run,resolve,reject});
  });
 }
 private flush(window:number,width:number){
  const group=this.windows.get(window);if(!group)return;this.windows.delete(window);
  const tasks=orderEntries(group.tasks.map(t=>({...t.candidate,task:t})),window);
  const outcomes:unknown[]=[];
  for(const {task,...c} of tasks){
   try{const result=task.run();outcomes.push({key:c.key,result});task.resolve(result);}
   catch(e){outcomes.push({key:c.key,error:String((e as Error)?.message??e)});task.reject(e);}
  }
  // Decisions already have their own atomic journals. Batch diagnostics must not turn
  // a committed entry into a failed delivery when an advisory write fails.
  try{this.db.run('INSERT INTO entry_batches(at,window_at,width_ms,candidates,outcomes) VALUES(?,?,?,?,?)',this.now(),window,width,
    JSON.stringify(tasks.map(({task,...c})=>c)),JSON.stringify(outcomes));
   this.db.run('DELETE FROM entry_batches WHERE id < (SELECT MAX(id)-10000 FROM entry_batches)');
  }catch{/* source receipts and decisions remain authoritative */}
 }
 status(){return {pending:[...this.windows.values()].reduce((n,g)=>n+g.tasks.length,0),widthMs:this.delay(),
  recent:this.db.all('SELECT id,at,window_at,width_ms,candidates,outcomes FROM entry_batches ORDER BY id DESC LIMIT 10')};}
 stop(){this.stopped=true;for(const g of this.windows.values()){clearTimeout(g.timer);for(const t of g.tasks)t.reject(Error('entry coordinator stopped; receipt retained'));}this.windows.clear();}
}
