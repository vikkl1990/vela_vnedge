import {depthBookKey} from './depthLiquidity.ts';
import type {Db} from '../db.ts';
import type {Position} from './logic.ts';

export const CAUSAL_EXIT_VERSION = 211;
/** New trades only. Keep 211 bound positions on their original causal model. */
export const CAUSAL_CANDLE_VERSION = 212;
export interface ExitBook {receivedAt:number;exchangeAt:number;bids:Array<{price:number;size:number}>;asks:Array<{price:number;size:number}>}
export interface ExitIntent {id:number;position_id:number;book:number;symbol:string;side:string;reason:string;trigger_at:number;ready_at:number;reference:number;qty:number;filled_qty:number;market_qty:number;market_filled:number;status:string;last_error:string|null}
export interface ExitState {position_id:number;version:number;market_qty:number;desired_stop:number|null;ack_at:number|null;queued_stop:number|null;queued_ack_at:number|null;stop_active_at:number|null}

/** Pure executable-price model. Incomplete books produce partial reports, never invented size. */
export function priceExit(book:ExitBook|null,side:'long'|'short',qty:number,at:number,maxAgeMs:number,consumed=0) {
 const fail=(error:string)=>({error,qty:0,price:null as number|null});
 if(!book)return fail('missing depth');
 if(!Number.isSafeInteger(qty)||qty<=0||!Number.isFinite(at)||!(maxAgeMs>0)||!Number.isFinite(maxAgeMs))return fail('invalid execution input');
 if([book.receivedAt,book.exchangeAt].some(t=>!Number.isFinite(t)||t<=0||t>at||at-t>maxAgeMs))return fail('stale or non-causal depth');
 if(!book.bids.length||!book.asks.length||[...book.bids,...book.asks].some(x=>!Number.isFinite(x.price)||x.price<=0||!Number.isSafeInteger(x.size)||x.size<=0))return fail('malformed depth');
 if([book.bids,book.asks].some(xs=>new Set(xs.map(x=>x.price)).size!==xs.length))return fail('duplicate depth levels');
 if(Math.max(...book.bids.map(x=>x.price))>=Math.min(...book.asks.map(x=>x.price)))return fail('crossed depth');
 const levels=[...(side==='long'?book.bids:book.asks)].sort((a,b)=>side==='long'?b.price-a.price:a.price-b.price);
 let skip=consumed,filled=0,value=0;
 for(const l of levels){const used=Math.min(skip,l.size);skip-=used;const n=Math.min(qty-filled,l.size-used);filled+=n;value+=n*l.price;if(filled===qty)break;}
 return filled?{error:null,qty:filled,price:value/filled}:fail('observed depth already consumed');
}

/** Durable intent/report journal. The engine owns the enclosing position transaction. */
export class PaperExitExecution {
 readonly db:Db;readonly book:number;
 constructor(db:Db,book:number){
  this.db=db;this.book=book;
  db.db.exec(`CREATE TABLE IF NOT EXISTS paper_execution_positions(position_id INTEGER PRIMARY KEY,book INTEGER NOT NULL,version INTEGER NOT NULL,market_qty INTEGER NOT NULL,desired_stop REAL,ack_at INTEGER);
   CREATE TABLE IF NOT EXISTS paper_exit_intents(id INTEGER PRIMARY KEY,position_id INTEGER NOT NULL,book INTEGER NOT NULL,symbol TEXT NOT NULL,side TEXT NOT NULL,reason TEXT NOT NULL,trigger_at INTEGER NOT NULL,ready_at INTEGER NOT NULL,reference REAL NOT NULL,qty REAL NOT NULL,filled_qty REAL NOT NULL DEFAULT 0,market_qty INTEGER NOT NULL,market_filled INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,last_error TEXT,updated_at INTEGER NOT NULL);
   CREATE UNIQUE INDEX IF NOT EXISTS paper_exit_active ON paper_exit_intents(position_id) WHERE status IN ('waiting','partial');
   CREATE INDEX IF NOT EXISTS paper_exit_due ON paper_exit_intents(book,status,ready_at);
   CREATE TABLE IF NOT EXISTS paper_exit_reports(id INTEGER PRIMARY KEY,intent_id INTEGER NOT NULL,at INTEGER NOT NULL,qty REAL NOT NULL,market_qty INTEGER NOT NULL,price REAL NOT NULL,book_key TEXT NOT NULL,depth TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS paper_exit_liquidity(scope TEXT NOT NULL,symbol TEXT NOT NULL,side TEXT NOT NULL,book_key TEXT NOT NULL,consumed INTEGER NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(scope,symbol,side,book_key));
   CREATE TABLE IF NOT EXISTS paper_stop_amendments(position_id INTEGER NOT NULL,active_at INTEGER NOT NULL,stop REAL NOT NULL,PRIMARY KEY(position_id,active_at));`);
  const columns=new Set(db.all<{name:string}>('PRAGMA table_info(paper_execution_positions)').map(c=>c.name));
  for(const [name,type] of [['queued_stop','REAL'],['queued_ack_at','INTEGER'],['stop_active_at','INTEGER']]){
   if(!columns.has(name))db.db.exec(`ALTER TABLE paper_execution_positions ADD COLUMN ${name} ${type}`);
  }
 }
 register(p:Position,marketQty:number){
  if(!Number.isSafeInteger(marketQty)||marketQty<=0)throw Error('invalid paper executable quantity');
  this.db.run('INSERT OR IGNORE INTO paper_execution_positions(position_id,book,version,market_qty,stop_active_at) VALUES(?,?,?,?,?)',p.id,this.book,p.executionPlan?.executionVersion??p.policy?.sim??CAUSAL_EXIT_VERSION,marketQty,p.entryAt);
  if(p.sl!==null)this.db.run('INSERT OR IGNORE INTO paper_stop_amendments VALUES(?,?,?)',p.id,p.entryAt,p.sl);
 }
 /** The stop known to be active for an entire candle, not a later intrabar amendment. */
 stopAt(id:number,at:number){return this.db.get<{stop:number}>('SELECT stop FROM paper_stop_amendments WHERE position_id=? AND active_at<=? ORDER BY active_at DESC LIMIT 1',id,at)?.stop??null;}
 state(id:number){return this.db.get<ExitState>('SELECT * FROM paper_execution_positions WHERE position_id=? AND book=?',id,this.book);}
 active(id:number){return this.db.get<ExitIntent>("SELECT * FROM paper_exit_intents WHERE position_id=? AND book=? AND status IN ('waiting','partial')",id,this.book);}
 pending(){return this.db.all<ExitIntent>("SELECT * FROM paper_exit_intents WHERE book=? AND status IN ('waiting','partial') ORDER BY ready_at,id",this.book);}
 request(p:Position,reason:string,qty:number,reference:number,at:number,latency:number){
  const held=this.active(p.id);if(held)return held;
  const state=this.state(p.id);if(!state)throw Error('missing paper execution state');
  if(!(qty>0)||qty>p.qtyOpen||!Number.isFinite(at)||at<p.entryAt||!(reference>0)||!Number.isFinite(reference))throw Error('invalid exit intent');
  const marketQty=Math.max(1,Math.ceil(state.market_qty*qty/p.qty));
  const row=this.db.run("INSERT INTO paper_exit_intents(position_id,book,symbol,side,reason,trigger_at,ready_at,reference,qty,market_qty,status,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'waiting',?)",p.id,this.book,p.symbol,p.side,reason,at,at+Math.max(0,latency),reference,qty,marketQty,at);
  return this.db.get<ExitIntent>('SELECT * FROM paper_exit_intents WHERE id=?',Number(row.lastInsertRowid))!;
 }
 acknowledge(p:Position,at:number){
  const s=this.state(p.id);if(s?.ack_at==null||s.ack_at>at)return false;
  // Each price has its own arrival time. A later request cannot inherit the first deadline.
  const queuedDue=s.queued_ack_at!=null&&s.queued_ack_at<=at;
  if(s.desired_stop!=null)this.db.run('INSERT OR REPLACE INTO paper_stop_amendments VALUES(?,?,?)',p.id,s.ack_at,s.desired_stop);
  if(queuedDue&&s.queued_stop!=null)this.db.run('INSERT OR REPLACE INTO paper_stop_amendments VALUES(?,?,?)',p.id,s.queued_ack_at,s.queued_stop);
  p.sl=queuedDue?s.queued_stop:s.desired_stop;
  this.db.run('UPDATE paper_execution_positions SET desired_stop=?,ack_at=?,queued_stop=NULL,queued_ack_at=NULL,stop_active_at=? WHERE position_id=?',
   queuedDue?null:s.queued_stop,queuedDue?null:s.queued_ack_at,queuedDue?s.queued_ack_at:s.ack_at,p.id);
  return true;
 }
 amend(p:Position,desired:number|null,at:number,latency:number){
  if(desired===null||desired===p.sl)return;
  const s=this.state(p.id);if(!s)return;
  const tighter=(a:number,b:number|null)=>b===null||(p.side==='long'?a>b:a<b);
  if(s.ack_at!==null){
    // Version 211 left an in-flight request alone. Preserve that held-position contract.
    // The new model retains a tighter successor, durably, with its own latency.
    if(s.version>=CAUSAL_CANDLE_VERSION&&tighter(desired,s.queued_stop??s.desired_stop))
     this.db.run('UPDATE paper_execution_positions SET queued_stop=?,queued_ack_at=? WHERE position_id=?',desired,Math.max(s.ack_at,at+Math.max(0,latency)),p.id);
    return;
  }
  if(!tighter(desired,p.sl))return;
  this.db.run('UPDATE paper_execution_positions SET desired_stop=?,ack_at=? WHERE position_id=?',desired,at+Math.max(0,latency),p.id);
 }
 /** Resolve a single report, including shared account liquidity consumption, atomically with its fill. */
 settle(p:Position,book:ExitBook|null,at:number,maxAgeMs:number,apply:(qty:number,price:number,reason:string)=>void):boolean {
  const i=this.active(p.id);if(!i||at<i.ready_at)return false;
  // A restarted engine may only use observations obtained after the intent became executable.
  if(book&&book.receivedAt<i.ready_at){this.error(i,'depth predates exit arrival',at);return false;}
  const key=book?depthBookKey(book):'';
  // Shadow cells are independent trials. Account positions compete for the same observed liquidity.
  const scope=this.book===2?`2:${p.id}`:String(this.book);
  const used=this.db.get<{consumed:number}>('SELECT consumed FROM paper_exit_liquidity WHERE scope=? AND symbol=? AND side=? AND book_key=?',scope,p.symbol,p.side,key)?.consumed??0;
  const r=priceExit(book,p.side,i.market_qty-i.market_filled,at,maxAgeMs,used);
  if(r.error||r.price===null){this.error(i,r.error??'unpriced depth',at);return false;}
  const complete=i.market_filled+r.qty===i.market_qty;
  const qty=Math.min(p.qtyOpen,complete?i.qty-i.filled_qty:Math.floor(i.qty*(i.market_filled+r.qty)/i.market_qty)-i.filled_qty);
  if(!(qty>0)){this.error(i,'depth insufficient for one simulated contract',at);return false;}
  apply(qty,r.price,i.reason);
  const status=complete||p.qtyOpen===0?'filled':'partial';
  this.db.run('UPDATE paper_exit_intents SET filled_qty=filled_qty+?,market_filled=market_filled+?,status=?,last_error=NULL,updated_at=? WHERE id=?',qty,r.qty,status,at,i.id);
  this.db.run('INSERT INTO paper_exit_reports(intent_id,at,qty,market_qty,price,book_key,depth) VALUES(?,?,?,?,?,?,?)',i.id,at,qty,r.qty,r.price,key,JSON.stringify({...book,consumedQty:used}));
  this.db.run('INSERT INTO paper_exit_liquidity(scope,symbol,side,book_key,consumed,at) VALUES(?,?,?,?,?,?) ON CONFLICT(scope,symbol,side,book_key) DO UPDATE SET consumed=consumed+excluded.consumed,at=excluded.at',scope,p.symbol,p.side,key,r.qty,at);
  this.db.run('DELETE FROM paper_exit_liquidity WHERE at<?',at-86400000);
  return true;
 }
 private error(i:ExitIntent,error:string,at:number){if(i.last_error!==error)this.db.run('UPDATE paper_exit_intents SET last_error=?,updated_at=? WHERE id=?',error,at,i.id);}
 view(id:number){const state=this.state(id);if(!state)return undefined;return {version:state.version,marketQty:state.market_qty,desiredStop:state.desired_stop,ackAt:state.ack_at,queuedStop:state.queued_stop,queuedAckAt:state.queued_ack_at,pending:this.active(id)??null};}
}
