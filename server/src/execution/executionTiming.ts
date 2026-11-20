import type {Db} from '../db.ts';
import type {ExitPumpEvent} from './paperExitPump.ts';

/** Buffered diagnostics only. Writes never run inside a fill transaction. */
export class ExecutionTiming {
 private queue:ExitPumpEvent[]=[];private dropped=0;private failures=0;private lastPrune=0;
 constructor(privateDb:Db){this.db=privateDb;privateDb.db.exec(`CREATE TABLE IF NOT EXISTS execution_timing(
  id INTEGER PRIMARY KEY,at INTEGER NOT NULL,kind TEXT NOT NULL,symbol TEXT,book INTEGER,ready_at INTEGER,started_at INTEGER,received_at INTEGER,exchange_at INTEGER,delay_ms REAL,error TEXT);
  CREATE INDEX IF NOT EXISTS execution_timing_at ON execution_timing(at);`);}
 private db:Db;
 record(event:ExitPumpEvent){if(this.queue.length>=2000){this.dropped++;return;}this.queue.push({...event});}
 flush(now=Date.now()){
  const rows=this.queue;this.queue=[];
  try{this.db.transaction(()=>{
   for(const e of rows)this.db.run('INSERT INTO execution_timing(at,kind,symbol,book,ready_at,started_at,received_at,exchange_at,delay_ms,error) VALUES(?,?,?,?,?,?,?,?,?,?)',e.at,e.kind,e.symbol??null,e.book??null,e.readyAt??null,e.startedAt??null,e.receivedAt??null,e.exchangeAt??null,e.delayMs??null,e.error??null);
   if(now-this.lastPrune>=60000)this.db.run('DELETE FROM execution_timing WHERE at<? OR id IN (SELECT id FROM execution_timing ORDER BY id DESC LIMIT -1 OFFSET 50000)',now-14*86400000);
  });if(now-this.lastPrune>=60000)this.lastPrune=now;}catch{this.failures++;this.dropped+=rows.length;}
 }
 view(now=Date.now()){
  return {at:now,queued:this.queue.length,dropped:this.dropped,failures:this.failures,retention:'14 days / 50,000 observations; timing only, not promotion evidence',
   summary:this.db.all('SELECT kind,book,count(*) observations,sum(error IS NOT NULL) errors,max(delay_ms) maxLoopDelayMs,max(at-started_at) maxFetchMs,max(started_at-ready_at) maxQueueMs FROM execution_timing WHERE at>=? GROUP BY kind,book',now-86400000),
   recent:this.db.all('SELECT * FROM execution_timing ORDER BY id DESC LIMIT 30')};
 }
}
