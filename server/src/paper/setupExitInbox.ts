/** A failed shadow write must not lose a confirmed close when the scan watermark advances. */
import type {Db} from '../db.ts';
import type {ExecutionPlanSnapshot} from './executionPlans.ts';
import type {ScanEvent} from '../scanners/extractor.ts';
import {logger} from '../log.ts';

const log=logger.scoped('setup-exits');

export interface SetupExitReceipt {
  plan: ExecutionPlanSnapshot;
  event: ScanEvent;
  at: number;
  targets: {positionId:number|null;pendingIds:number[]};
}

export class SetupExitInbox {
  private draining=false;
  constructor(privateDb:Db) { this.db=privateDb;
    this.db.run(`CREATE TABLE IF NOT EXISTS execution_plan_exit_receipts (
      id INTEGER PRIMARY KEY,scanner_id TEXT NOT NULL,event_key TEXT NOT NULL,
      at INTEGER NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,completed_at INTEGER,
      UNIQUE(scanner_id,event_key))`);
    this.db.run('CREATE INDEX IF NOT EXISTS plan_exit_receipts_retry ON execution_plan_exit_receipts(status,attempts,id)');
  }
  private db:Db;
  enqueue(scannerId:string,receipt:SetupExitReceipt):number {
    const e=receipt.event,key=JSON.stringify([e.barTime,e.source,e.label,e.exitType??'close',e.side??null]);
    this.db.run('INSERT OR IGNORE INTO execution_plan_exit_receipts(scanner_id,event_key,at,payload) VALUES(?,?,?,?)',
      scannerId,key,receipt.at,JSON.stringify(receipt));
    return this.db.get<{id:number}>('SELECT id FROM execution_plan_exit_receipts WHERE scanner_id=? AND event_key=?',scannerId,key)!.id;
  }
  summary():Map<string,{pending:number;done:number;maxAttempts:number}> {
    return new Map(this.db.all<{scanner_id:string;pending:number;done:number;maxAttempts:number}>(`
      SELECT scanner_id,sum(status='pending') pending,sum(status='done') done,max(attempts) maxAttempts
      FROM execution_plan_exit_receipts GROUP BY scanner_id`).map(row=>[row.scanner_id,row]));
  }
  /** Bounded retries; the callback owns the account transaction and completes this row inside it. */
  drain(at:number,apply:(receipt:SetupExitReceipt,complete:()=>void)=>void):void {
    if(this.draining || !Number.isFinite(at))return;
    this.draining=true;
    try {
      for(const row of this.db.all<{id:number;payload:string;attempts:number}>("SELECT id,payload,attempts FROM execution_plan_exit_receipts WHERE status='pending' AND at<=? ORDER BY attempts,id LIMIT 20",at)){
        this.db.run('UPDATE execution_plan_exit_receipts SET attempts=attempts+1 WHERE id=?',row.id);
        try {
          const receipt=JSON.parse(row.payload) as SetupExitReceipt;
          apply(receipt,()=>this.db.run("UPDATE execution_plan_exit_receipts SET status='done',completed_at=? WHERE id=?",at,row.id));
        } catch {
          // No payload or credential data in the log; status/attempts remain queryable.
          if(row.attempts%60===0)log.warn(`confirmed exit receipt #${row.id} remains pending after ${row.attempts+1} attempts`);
        }
      }
    } finally { this.draining=false; }
  }
}
