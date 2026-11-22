import {createHash} from 'node:crypto';
import type {Db} from '../db.ts';
import {priceExit,type ExitBook} from './exitExecution.ts';
import type {EntryAdmissionDepth} from './entryExecution.ts';

export type TickDepthMakerModel='tick-depth-v1'|'tick-depth-v2';
export function tickDepthMaker(model:unknown):model is TickDepthMakerModel {
 return model==='tick-depth-v1'||model==='tick-depth-v2';
}

/** Use the exact verified WS book observed now, never a later REST reconstruction. */
export function makerDepthEvidence(book:ExitBook|null,at:number,qty:number,contractValue:number):EntryAdmissionDepth|null {
 if(!book||!Number.isSafeInteger(qty)||qty<1||!(contractValue>0))return null;
 for(const side of ['long','short'] as const){const check=priceExit(book,side,qty,at,1000);if(check.error||check.qty!==qty)return null;}
 return {source:'l2-ws',receivedAt:book.receivedAt,exchangeAt:book.exchangeAt,evaluatedAt:at,checkedQty:qty,contractValue,bids:structuredClone(book.bids),asks:structuredClone(book.asks)};
}

/** A public print is a quantity ceiling, not proof of our queue position. */
export interface MakerProgress {
  targetQty:number; targetMarketQty:number; filledQty:number; filledMarketQty:number;
  riskAmount:number; leverage:number; marginLeverage:number;
}
export function makerSlice(p:MakerProgress,available:number) {
  if(!Number.isSafeInteger(available)||available<=0)return null;
  const marketQty=Math.min(available,p.targetMarketQty-p.filledMarketQty);
  const total=p.filledMarketQty+marketQty;
  const qty=(total===p.targetMarketQty?p.targetQty:Math.floor(p.targetQty*total/p.targetMarketQty))-p.filledQty;
  return qty>0&&marketQty>0?{qty,marketQty}:null;
}
export function makerPrintKey(time:number,price:number,qty:number,id?:string|number) {
  // Without a venue ID identical observations conservatively share one budget.
  return createHash('sha256').update(JSON.stringify(id===undefined?[time,price,qty]:['id',String(id)])).digest('hex');
}
export class PartialMakerLedger {
  readonly db:Db;readonly book:number;
  constructor(db:Db,book:number){
    this.db=db;this.book=book;
    db.db.exec(`CREATE TABLE IF NOT EXISTS paper_maker_orders(position_id INTEGER PRIMARY KEY,book INTEGER NOT NULL,state TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS paper_maker_reports(order_id INTEGER PRIMARY KEY,position_id INTEGER NOT NULL,book INTEGER NOT NULL,at INTEGER NOT NULL,market_qty INTEGER NOT NULL,qty INTEGER NOT NULL,print_key TEXT NOT NULL,evidence TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS paper_maker_liquidity(scope TEXT NOT NULL,symbol TEXT NOT NULL,print_key TEXT NOT NULL,consumed INTEGER NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(scope,symbol,print_key));`);
  }
  scope(id:number){return this.book===2?`2:${id}`:String(this.book);}
  available(id:number,symbol:string,key:string,qty:number){
    if(!Number.isSafeInteger(qty)||qty<=0)return 0;
    const used=this.db.get<{consumed:number}>('SELECT consumed FROM paper_maker_liquidity WHERE scope=? AND symbol=? AND print_key=?',this.scope(id),symbol,key)?.consumed??0;
    return Math.max(0,qty-used);
  }
  consume(id:number,symbol:string,key:string,qty:number,at:number){
    this.db.run('INSERT INTO paper_maker_liquidity(scope,symbol,print_key,consumed,at) VALUES(?,?,?,?,?) ON CONFLICT(scope,symbol,print_key) DO UPDATE SET consumed=consumed+excluded.consumed,at=excluded.at',this.scope(id),symbol,key,qty,at);
    this.db.run('DELETE FROM paper_maker_liquidity WHERE at<?',at-86400000);
  }
  save(id:number,state:unknown,status:string,at:number,reason?:string){
    this.db.run('INSERT INTO paper_maker_orders(position_id,book,state,status,reason,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(position_id) DO UPDATE SET state=excluded.state,status=excluded.status,reason=excluded.reason,updated_at=excluded.updated_at',id,this.book,JSON.stringify(state),status,reason??null,at);
  }
}
