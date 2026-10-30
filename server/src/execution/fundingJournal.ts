import type {Db} from '../db.ts';
import type {WsFunding,WsMark} from '../delta/ws.ts';
import type {DeltaRest} from '../delta/rest.ts';
/** Durable observations, not an assertion that a funding OHLC close is a settled payment. */
export class FundingJournal {
 private db:Db;
 constructor(db:Db){this.db=db;db.db.exec(`
 CREATE TABLE IF NOT EXISTS funding_schedule(symbol TEXT PRIMARY KEY,next_at INTEGER NOT NULL,interval_ms INTEGER NOT NULL,observed_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS funding_settlements(symbol TEXT NOT NULL,at INTEGER NOT NULL,rate REAL,rate_at INTEGER,mark REAL,mark_at INTEGER,status TEXT NOT NULL DEFAULT 'pending',source TEXT NOT NULL DEFAULT 'unobserved',candidate TEXT,error TEXT,PRIMARY KEY(symbol,at));
 CREATE INDEX IF NOT EXISTS funding_due ON funding_settlements(status,at);
 `);}
 observe(f:WsFunding){
  if(!f.symbol||!Number.isFinite(f.ratePct)||!Number.isFinite(f.timeMs)||!(f.nextAt>0)||!(f.intervalSec>=60&&f.intervalSec<=86400))return;
  const old=this.db.get<any>('SELECT * FROM funding_schedule WHERE symbol=?',f.symbol);
  if(old&&f.timeMs<=old.observed_at)return;
  // Persist at most one observation per 30 seconds per unchanged slot; boundary freshness is 120 seconds.
  if(old&&f.nextAt===old.next_at&&f.timeMs-old.observed_at<30000)return;
  this.db.transaction(()=>{
   // Bound work after a long outage; the range itself remains explicitly unresolved.
   if(old&&f.nextAt>old.next_at){
    const count=Math.ceil((f.nextAt-old.next_at)/old.interval_ms);
    for(let i=0;i<Math.min(count,200);i++)this.db.run("INSERT OR IGNORE INTO funding_settlements(symbol,at,status,source,error) VALUES(?,?,'unresolved','missed-feed',?)",f.symbol,old.next_at+i*old.interval_ms,count>200?'gap exceeds 200 intervals; remaining range needs reconciliation':null);
   }
   this.db.run('INSERT INTO funding_schedule VALUES(?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET next_at=excluded.next_at,interval_ms=excluded.interval_ms,observed_at=excluded.observed_at',f.symbol,f.nextAt,f.intervalSec*1000,f.timeMs);
   this.db.run('INSERT OR IGNORE INTO funding_settlements(symbol,at) VALUES(?,?)',f.symbol,f.nextAt);
   // Never let a later rate replace an earlier settlement's rate.
   if(f.timeMs<=f.nextAt)this.db.run("UPDATE funding_settlements SET rate=?,rate_at=?,source='observed-websocket' WHERE symbol=? AND at=? AND status!='applied' AND source!='verified-import' AND (rate_at IS NULL OR rate_at<?)",f.ratePct,f.timeMs,f.symbol,f.nextAt,f.timeMs);
  });
 }
 mark(m:WsMark){
  if(!(Number.isFinite(m.markPrice)&&m.markPrice>0&&Number.isFinite(m.timeMs)))return;
  this.db.run("UPDATE funding_settlements SET mark=?,mark_at=? WHERE symbol=? AND at BETWEEN ? AND ? AND status!='applied' AND source!='verified-import' AND (mark_at IS NULL OR abs(mark_at-at)>abs(?-at))",m.markPrice,m.timeMs,m.symbol,m.timeMs-10000,m.timeMs+10000,m.timeMs);
 }
 settle(now:number,apply:(symbol:string,rate:number,mark:number,at:number)=>void){
  for(const r of this.db.all<any>("SELECT * FROM funding_settlements WHERE status='pending' AND at<=? ORDER BY at LIMIT 200",now-10000)){
   const observed=r.source==='observed-websocket'&&r.rate_at<=r.at&&r.at-r.rate_at<=120000&&Math.abs(r.mark_at-r.at)<=10000;
   if((!observed&&r.source!=='verified-import')||r.rate===null||r.mark===null||!(r.mark>0)){
    this.db.run("UPDATE funding_settlements SET status='unresolved',error='missing fresh settlement rate or boundary mark; historical candidates are not verified' WHERE symbol=? AND at=?",r.symbol,r.at);continue;
   }
   // Per-position persisted fills make retries safe if one book fails midway.
   apply(r.symbol,r.rate,r.mark,r.at);
   this.db.run("UPDATE funding_settlements SET status='applied',error=NULL WHERE symbol=? AND at=?",r.symbol,r.at);
  }
 }
 verify(symbol:string,at:number,rate:number,mark:number,evidence:string){
  if(!/^[A-Z0-9]+USD$/.test(symbol)||!Number.isSafeInteger(at)||at<=0||!Number.isFinite(rate)||!Number.isFinite(mark)||mark<=0||evidence.trim().length<10)throw Error('verified settlement requires symbol, timestamp, finite rate, positive mark and evidence');
  const r=this.db.get<any>('SELECT * FROM funding_settlements WHERE symbol=? AND at=?',symbol,at);
  if(r?.status==='applied')throw Error('settlement already applied; correction requires a separate accounting adjustment');
  this.db.run("INSERT INTO funding_settlements(symbol,at,rate,mark,source,candidate) VALUES(?,?,?,?,'verified-import',?) ON CONFLICT(symbol,at) DO UPDATE SET rate=excluded.rate,mark=excluded.mark,source=excluded.source,candidate=excluded.candidate,status='pending',error=NULL",symbol,at,rate,mark,JSON.stringify({evidence}));
 }
 async stageHistory(rest:DeltaRest){
  // Small bounded requests; retain exact raw samples and missing coverage, never infer settlement timing.
  for(const r of this.db.all<any>("SELECT symbol,at FROM funding_settlements WHERE status='unresolved' AND candidate IS NULL ORDER BY at DESC LIMIT 3")){
   try{
    const [rates,marks]=await Promise.all([rest.candles(`FUNDING:${r.symbol}`,'1m',r.at/1000-60,r.at/1000+60,5),rest.candles(`MARK:${r.symbol}`,'1m',r.at/1000-60,r.at/1000+60,5)]);
    this.db.run('UPDATE funding_settlements SET candidate=? WHERE symbol=? AND at=?',JSON.stringify({rates,marks,verified:false}),r.symbol,r.at);
   }catch(e:any){this.db.run('UPDATE funding_settlements SET error=? WHERE symbol=? AND at=?',String(e?.message??e).slice(0,200),r.symbol,r.at);}
  }
 }
 summary(){return {method:'Simulated settlements use fresh pre-boundary funding observations and a boundary mark; historical OHLC candidates require independent verification.',counts:this.db.all<any>('SELECT status,count(*) n FROM funding_settlements GROUP BY status'),recent:this.db.all<any>('SELECT * FROM funding_settlements ORDER BY at DESC LIMIT 50')};}
}
