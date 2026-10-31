import { randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';

export type CommandState = 'pending' | 'dispatching' | 'delivered' | 'cancelled' | 'blocked';
export interface ExecutionCommand {
  id: number; sourceOrderId: number; positionId: number; symbol: string;
  side: 'buy' | 'sell'; qty: number; reason: string; clientOrderId: string;
  state: CommandState; createdAt: number; updatedAt: number; note: string | null;
}

/** Durable handoff, not a second order ledger. Delivered means the ledger owns recovery. */
export class ExecutionOutbox {
  private db: Db;
  readonly scope: string;
  private now: () => number;
  constructor(db: Db, scope: string, now: () => number = Date.now) { this.db=db;this.scope=scope;this.now=now; }

  record(sourceOrderId: number, o: { positionId: number; symbol: string; side: string; qty: number; reason: string }): void {
    if (o.reason === 'funding' || !(o.qty > 0) || (o.side !== 'buy' && o.side !== 'sell')) return;
    if (!this.db.inTransaction) throw new Error('execution intent must share the paper fill transaction');
    const at = this.now();
    this.db.run(`INSERT INTO execution_commands(source_order_id,scope,position_id,symbol,side,qty,reason,client_order_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,sourceOrderId,this.scope,o.positionId,o.symbol,o.side,o.qty,o.reason,
      `vnedge-cmd-${randomUUID().replaceAll('-','').slice(0,20)}`,at,at);
  }
  pending(): ExecutionCommand[] {
    return this.db.all<any>("SELECT * FROM execution_commands WHERE scope=? AND state IN ('pending','dispatching') ORDER BY id",this.scope).map(command);
  }
  set(id: number, state: CommandState, note: string | null = null): void {
    this.db.run('UPDATE execution_commands SET state=?,note=?,updated_at=? WHERE id=? AND scope=?',state,note?.slice(0,300)??null,this.now(),id,this.scope);
  }
  status() {
    const counts = Object.fromEntries(this.db.all<{state:string;n:number}>('SELECT state,count(*) n FROM execution_commands WHERE scope=? GROUP BY state',this.scope).map(r=>[r.state,r.n]));
    const pending=this.pending();
    return { scope:this.scope, pending:pending.length, blocked:counts.blocked??0, delivered:counts.delivered??0,
      cancelled:counts.cancelled??0, oldest:pending[0]?.createdAt??null,
      recent:this.db.all<any>('SELECT * FROM execution_commands WHERE scope=? ORDER BY id DESC LIMIT 30',this.scope).map(command) };
  }
}
function command(r:any):ExecutionCommand {
  return {id:r.id,sourceOrderId:r.source_order_id,positionId:r.position_id,symbol:r.symbol,side:r.side,qty:r.qty,
    reason:r.reason,clientOrderId:r.client_order_id,state:r.state,createdAt:r.created_at,updatedAt:r.updated_at,note:r.note};
}
