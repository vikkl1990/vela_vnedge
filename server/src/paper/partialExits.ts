/** Prospective shadow lifecycle: notifications request quantities; only reports complete targets. */
import type {Db} from '../db.ts';
import type {Position} from './logic.ts';
import {stopReason,fillExit,type Fill} from './logic.ts';
import type {PaperConfig} from '../config.ts';
import type {PaperExitExecution} from './exitExecution.ts';

interface Request {position_id:number;target:number;at:number;reference:number;full_reason:string|null;full_at:number|null;full_reference:number|null}
export class PartialExits {
 private db:Db;private ledger:PaperExitExecution;
 constructor(db:Db,ledger:PaperExitExecution){
  this.db=db;this.ledger=ledger;
  db.run('CREATE TABLE IF NOT EXISTS paper_target_prints(position_id INTEGER NOT NULL,print_key TEXT NOT NULL,at INTEGER NOT NULL,qty INTEGER NOT NULL,PRIMARY KEY(position_id,print_key))');
  db.run(`CREATE TABLE IF NOT EXISTS paper_partial_requests(position_id INTEGER NOT NULL,target INTEGER NOT NULL,at INTEGER NOT NULL,reference REAL NOT NULL,full_reason TEXT,full_at INTEGER,full_reference REAL,PRIMARY KEY(position_id,target))`);
 }
 targets(p:Position,index:number,at:number,reference:number){
  if(!Number.isInteger(index)||index<0||index>=p.tp.length||at<p.entryAt||!Number.isFinite(at))return;
  for(let i=0;i<=index;i++)if(!p.tpHit[i])this.db.run(`INSERT OR IGNORE INTO paper_partial_requests(position_id,target,at,reference) VALUES(?,?,?,?)`,p.id,i,at,reference);
 }
 full(p:Position,reason:string,at:number,reference:number){
  this.db.run(`INSERT INTO paper_partial_requests(position_id,target,at,reference,full_reason,full_at,full_reference) VALUES(?,-1,?,?,?,?,?)
   ON CONFLICT(position_id,target) DO UPDATE SET full_reason=coalesce(full_reason,excluded.full_reason),full_at=coalesce(full_at,excluded.full_at),full_reference=coalesce(full_reference,excluded.full_reference)`,p.id,at,reference,reason,at,reference);
 }
 /** Fill ledger is authoritative, including partial depth and earlier resting fills. */
 refresh(p:Position){
  for(let i=0;i<p.tp.length;i++){
   const filled=p.fills.filter(f=>f.reason===`tp${i+1}`).reduce((a,f)=>a+f.qty,0);
   if(filled>=p.legs[i])p.tpHit[i]=true;
  }
 }
 drain(p:Position,latency:number){
  if(p.status!=='open'){this.db.run('DELETE FROM paper_partial_requests WHERE position_id=?',p.id);return;}
  if(this.ledger.active(p.id))return;
  const r=this.db.get<Request>('SELECT * FROM paper_partial_requests WHERE position_id=? ORDER BY target LIMIT 1',p.id);if(!r)return;
  if(r.full_reason){this.ledger.request(p,r.full_reason,p.qtyOpen,r.full_reference!,r.full_at!,latency);return;}
  for(let i=0;i<=r.target;i++){
   const filled=p.fills.filter(f=>f.reason===`tp${i+1}`).reduce((a,f)=>a+f.qty,0);
   const remaining=Math.min(p.qtyOpen,Math.max(0,p.legs[i]-filled));
   if(remaining>0){this.ledger.request(p,`tp${i+1}`,remaining,r.reference,r.at,latency);return;}
  }
  this.db.run('DELETE FROM paper_partial_requests WHERE position_id=? AND target=?',p.id,r.target);
  this.drain(p,latency);
 }
 /** Through-price tape remains a queue approximation, bounded by observed contracts and deduplicated durably. */
 resting(p:Position,price:number,qty:number,at:number,time:number,cfg:PaperConfig,tradeId?:string):Fill[]{
  if(!Number.isSafeInteger(qty)||qty<=0||time<p.entryAt)return [];
  const key=tradeId?`id:${tradeId}`:JSON.stringify([time,price,qty]);
  if(this.db.get('SELECT 1 FROM paper_target_prints WHERE position_id=? AND print_key=?',p.id,key))return [];
  let left=qty;const fills:Fill[]=[];
  for(let i=0;i<p.tp.length&&left>0&&p.qtyOpen>0;i++){
    if(p.tpHit[i])continue;
    const through=(cfg.limitFill??'through')==='through';
    const hit=p.side==='long'?(through?price>p.tp[i]:price>=p.tp[i]):(through?price<p.tp[i]:price<=p.tp[i]);
    if(!hit)break;
    const filled=p.fills.filter(f=>f.reason===`tp${i+1}`).reduce((n,f)=>n+f.qty,0);
    const n=Math.min(left,p.qtyOpen,Math.max(0,p.legs[i]-filled));
    if(n>0){fills.push(fillExit(p,p.tp[i],n,`tp${i+1}`,at,cfg,false));left-=n;}
  }
  if(fills.length){this.refresh(p);this.db.run('INSERT INTO paper_target_prints VALUES(?,?,?,?)',p.id,key,at,qty-left);}
  return fills;
 }
 protect(p:Position,price:number,at:number,latency:number){
  if(p.sl!==null&&(p.side==='long'?price<=p.sl:price>=p.sl))this.full(p,stopReason(p),at,price);
  this.drain(p,latency);
 }
}
