import type {Db} from '../db.ts';
import type {ExchangeTransport} from './client.ts';
/** Exchange truth stays in a separate ledger; it must never be double-booked as simulated fills. */
export class AccountAudit {
 private db:Db;
 constructor(db:Db){this.db=db;db.db.exec(`
 CREATE TABLE IF NOT EXISTS exchange_history(host TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,order_id TEXT,at INTEGER,amount REAL,asset TEXT,payload TEXT NOT NULL,PRIMARY KEY(host,kind,id));
 CREATE INDEX IF NOT EXISTS exchange_history_order ON exchange_history(host,order_id);
 CREATE TABLE IF NOT EXISTS exchange_history_cursor(host TEXT PRIMARY KEY,from_at INTEGER NOT NULL,through_at INTEGER NOT NULL,error TEXT);
 `);}
 async sync(t:ExchangeTransport,now=Date.now()){
  if(!t.hasAuth||t.dryRun||!t.accountHistory)return;
  const prior=this.db.get<any>('SELECT * FROM exchange_history_cursor WHERE host=?',t.host);
  const start=Math.max(0,(prior?.through_at??now-3600000)-300000),end=Math.min(now,start+3600000);
  if(end<=start)return;
  try{
   const fills=await t.accountHistory('fills',start,end),wallet=await t.accountHistory('wallet',start,end);
   this.db.transaction(()=>{
    for(const [kind,rows] of [['fills',fills],['wallet',wallet]] as const)for(const r of rows){
     if(r?.id===null||r?.id===undefined)throw Error('history identity missing');
     // Save only accounting fields; upstream metadata may contain IP addresses and unrelated account details.
     const p=kind==='fills'?{id:r.id,order_id:r.order_id,product_id:r.product_id,symbol:r.product_symbol??r.product?.symbol,side:r.side,size:r.size,price:r.price,role:r.role,commission:r.commission,asset:r.settling_asset_symbol,created_at:r.created_at}: {id:r.id,product_id:r.product_id,amount:r.amount,asset:r.asset_symbol,transaction_type:r.transaction_type,created_at:r.created_at};
     const ts=Number(r.created_at),at=Number.isFinite(ts)?Math.floor(ts/1000):Date.parse(r.created_at);
     const amount=Number(kind==='fills'?r.commission:r.amount);
     this.db.run('INSERT OR REPLACE INTO exchange_history VALUES(?,?,?,?,?,?,?,?)',t.host,kind,String(r.id),kind==='fills'&&r.order_id!=null?String(r.order_id):null,Number.isFinite(at)?at:null,Number.isFinite(amount)?amount:null,p.asset??null,JSON.stringify(p));
    }
    this.db.run('INSERT INTO exchange_history_cursor VALUES(?,?,?,NULL) ON CONFLICT(host) DO UPDATE SET through_at=excluded.through_at,error=NULL',t.host,prior?.from_at??start,end);
   });
  }catch(e:any){this.db.run('INSERT INTO exchange_history_cursor VALUES(?,?,?,?) ON CONFLICT(host) DO UPDATE SET error=excluded.error',t.host,prior?.from_at??start,prior?.through_at??start,String(e?.message??e).slice(0,200));throw e;}
 }
 summary(){
  // Compare quantities only when history covers the entire local order lifetime; old orders are explicitly incomplete.
  const cursors=this.db.all<any>('SELECT * FROM exchange_history_cursor');
  const comparisons=this.db.all<any>(`SELECT o.id,o.host,o.exchange_id,o.filled_size,o.avg_price,o.fee,c.from_at,c.through_at,o.created_at,o.updated_at
   FROM exchange_orders o JOIN exchange_history_cursor c ON c.host=o.host WHERE o.exchange_id IS NOT NULL AND o.state IN ('filled','cancelled') ORDER BY o.id DESC LIMIT 100`).map(o=>{
    const fills=this.db.all<any>("SELECT payload FROM exchange_history WHERE host=? AND kind='fills' AND order_id=?",o.host,o.exchange_id).map(r=>JSON.parse(r.payload));
    const complete=o.created_at>=o.from_at&&o.updated_at<=o.through_at;
    const qty=fills.reduce((n,f)=>n+Number(f.size||0),0),notional=fills.reduce((n,f)=>n+Number(f.size||0)*Number(f.price||0),0);
    return {orderId:o.id,host:o.host,complete,recordedQty:o.filled_size,fillQty:qty,fillPrice:qty?notional/qty:null,quantityMatches:complete?Math.abs(qty-o.filled_size)<1e-9:null,commissions:fills.map(f=>({amount:f.commission,asset:f.asset,role:f.role})),feeStatus:'raw exchange amounts; currency/tax/promotion reconciliation required'};
   });
  return {cursors,comparisons,rows:this.db.all<any>('SELECT host,kind,count(*) n FROM exchange_history GROUP BY host,kind'),recent:this.db.all<any>('SELECT host,kind,id,order_id,at,amount,asset,payload FROM exchange_history ORDER BY at DESC LIMIT 50')};
 }
}
