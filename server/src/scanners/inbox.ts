import { createHash } from 'node:crypto';
import type { Db, SignalRow } from '../db.ts';
import type { Bar } from '../data/candleStore.ts';
import type { ExitMode } from '../config.ts';
import type { MarketInfo } from '../paper/engine.ts';
import type { ScanEvent } from './extractor.ts';

export interface Delivery {
  version: 1; scannerId: string; scannerName: string; symbol: string; tf: string;
  ev: ScanEvent; bars: Bar[]; market: MarketInfo; exitMode: ExitMode; lastBar: Bar;
  copied: boolean; pilotRequested: boolean; fingerprint: string;
  accountResetAt: number | null;
  targetPositionId: number | null; targetPendingIds: number[];
}
export interface InboxRow { event_key: string; signal_id: number; received_at: number; state: 'pending'|'done'; payload: string | null; attempts: number }
export const eventKey=(d:Delivery)=>createHash('sha256').update(JSON.stringify([
  d.scannerId,d.symbol,d.tf,d.ev.barTime,d.ev.kind,d.ev.side??null,d.ev.label,d.ev.exitType??null,
])).digest('hex');

/** A receipt is durable before any asynchronous preparation. Completed payloads are discarded. */
export class SignalInbox {
  private db: Db;
  constructor(db: Db) {
    this.db=db;
    db.run(`CREATE TABLE IF NOT EXISTS signal_inbox (
      event_key TEXT PRIMARY KEY, signal_id INTEGER NOT NULL UNIQUE, kind TEXT NOT NULL,
      received_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','done')),
      payload TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER,
      last_error TEXT, completed_at INTEGER, outcome TEXT
    )`);
    db.run('CREATE INDEX IF NOT EXISTS signal_inbox_state ON signal_inbox(state,received_at)');
  }
  accept(d:Delivery,signal:Omit<SignalRow,'id'>):InboxRow|null {
    const key=eventKey(d);
    return this.db.transaction(()=>{
      const existing=this.db.get<InboxRow>('SELECT * FROM signal_inbox WHERE event_key=?',key);
      if(existing)return existing;
      // Pre-inbox rows cannot be replayed safely: preserve their historical duplicate identity.
      if([d.ev.label,`${d.ev.label} (shadow mirror)`.slice(0,80)].some(label=>this.db.signalExists(d.scannerId,d.symbol,d.tf,d.ev.barTime,d.ev.kind,d.ev.side??null,label)))return null;
      const id=this.db.insertSignal(signal);if(id===null)return null;
      this.db.run("INSERT INTO signal_inbox(event_key,signal_id,kind,received_at,state,payload) VALUES(?,?,?,?,'pending',?)",key,id,d.ev.kind,signal.at,JSON.stringify(d));
      return this.db.get<InboxRow>('SELECT * FROM signal_inbox WHERE event_key=?',key)!;
    });
  }
  pending():InboxRow[]{return this.db.all("SELECT * FROM signal_inbox WHERE state='pending' ORDER BY CASE kind WHEN 'exit' THEN 0 ELSE 1 END,COALESCE(last_attempt_at,0),received_at LIMIT 100");}
  attempt(r:InboxRow){this.db.run('UPDATE signal_inbox SET attempts=attempts+1,last_attempt_at=? WHERE event_key=? AND state=\'pending\'',Date.now(),r.event_key);}
  fail(r:InboxRow,error:unknown){this.db.run("UPDATE signal_inbox SET last_error=? WHERE event_key=? AND state='pending'",String((error as Error)?.message??error).slice(0,300),r.event_key);}
  complete(r:InboxRow,action:string,positionId:number|null){
    this.db.updateSignalAction(r.signal_id,action,positionId);
    this.db.run("UPDATE signal_inbox SET state='done',payload=NULL,completed_at=?,outcome=?,last_error=NULL WHERE event_key=?",Date.now(),action,r.event_key);
  }
  status(){
    return { ...this.db.get<{pending:number;oldest:number|null;failed:number}>("SELECT COUNT(*) pending,MIN(received_at) oldest,COALESCE(SUM(last_error IS NOT NULL),0) failed FROM signal_inbox WHERE state='pending'"),
      recent:this.db.all("SELECT i.signal_id,i.kind,i.received_at,i.attempts,i.last_error,s.scanner_id,s.symbol,s.tf FROM signal_inbox i JOIN signals s ON s.id=i.signal_id WHERE state='pending' ORDER BY received_at LIMIT 10") };
  }
}
