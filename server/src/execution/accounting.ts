import type { Db } from '../db.ts';
import type { PaperEngine } from '../paper/engine.ts';
import type { OrderLedger } from './ledger.ts';

export type AccountingState = 'pending' | 'missing-price' | 'missing-fee' | 'overfilled' | 'complete';

/** Quantities, prices and commissions are cumulative per exchange order, not per lookup. */
export class ExecutionAccounting {
  private db:Db;
  private scope:string;
  private now:()=>number;
  constructor(db:Db,scope:string,now:()=>number=Date.now){this.db=db;this.scope=scope;this.now=now;}

  register(sourceOrderId:number):void {
    this.db.run(`INSERT OR IGNORE INTO execution_accounting(source_order_id,scope,position_id,expected_qty,updated_at)
      SELECT id,?,position_id,qty,? FROM orders WHERE id=? AND bt=0 AND reason!='funding'`,this.scope,this.now(),sourceOrderId);
  }

  /** Recompute from durable evidence, then commit journal cash and coverage together. */
  sync(paper:PaperEngine,ledger:OrderLedger):void {
    for(const a of this.db.all<any>(`SELECT a.*,o.qty,o.reason FROM execution_accounting a JOIN orders o ON o.id=a.source_order_id WHERE a.scope=? AND o.bt=0 AND (a.state!='complete' OR a.expected_qty!=o.qty)`,this.scope)) {
      const rows=ledger.forPosition(a.position_id).filter(r=>r.sourceOrderId===a.source_order_id);
      const fills=rows.filter(r=>r.filledSize>0), qty=fills.reduce((s,r)=>s+r.filledSize,0);
      const priced=fills.every(r=>r.avgPrice!==null && Number.isFinite(r.avgPrice) && r.avgPrice>0);
      const charged=fills.every(r=>r.fee!==null && Number.isFinite(r.fee)); // rebates may be negative
      const price=qty>0 && priced ? fills.reduce((s,r)=>s+r.filledSize*r.avgPrice!,0)/qty : null;
      const fee=qty>0 && charged ? fills.reduce((s,r)=>s+r.fee!,0) : null;
      const live=rows.some(r=>['intent','submitted','acknowledged','unknown'].includes(r.state));
      const state:AccountingState=qty>a.qty?'overfilled':qty!==a.qty || live?'pending':!priced?'missing-price':!charged?'missing-fee':'complete';
      if(a.state===state && a.expected_qty===a.qty && a.confirmed_qty===qty && a.price===price && a.fee===fee)continue;
      // Restatement owns the outer transaction so it can restore its in-memory position on failure.
      const save=()=>this.db.run('UPDATE execution_accounting SET expected_qty=?,confirmed_qty=?,state=?,price=?,fee=?,updated_at=? WHERE source_order_id=? AND scope=?',a.qty,qty,state,price,fee,this.now(),a.source_order_id,this.scope);
      if(state==='complete')paper.restateOrderFill(a.source_order_id,{price:price!,fee:fee!},save);
      else save();
    }
  }

  /** A retry belongs to the oldest uncompleted exit, never to the text label "stranded". */
  remainder(positionId:number):{sourceOrderId:number;qty:number}|undefined {
    return this.db.get<{sourceOrderId:number;qty:number}>(`SELECT a.source_order_id sourceOrderId,a.expected_qty-a.confirmed_qty qty
      FROM execution_accounting a JOIN orders o ON o.id=a.source_order_id
      WHERE a.scope=? AND a.position_id=? AND o.bt=0 AND o.reason NOT IN ('entry','funding') AND a.expected_qty>a.confirmed_qty ORDER BY a.source_order_id LIMIT 1`,this.scope,positionId);
  }

  missing(ledger:OrderLedger) {
    const ids=new Set(this.db.all<{id:number}>(`SELECT source_order_id id FROM execution_accounting WHERE scope=? AND state IN ('missing-price','missing-fee')`,this.scope).map(r=>r.id));
    // Bounded refresh; older missing rows rotate as their observation timestamps advance.
    return this.db.all<{id:number}>(`SELECT id FROM exchange_orders WHERE host=? AND source_order_id IN (SELECT source_order_id FROM execution_accounting WHERE scope=? AND state IN ('missing-price','missing-fee')) ORDER BY updated_at,id LIMIT 20`,this.scope,this.scope)
      .map(r=>ledger.get(r.id)!).filter(r=>r && ids.has(r.sourceOrderId!));
  }
  status(){
    const rows=this.db.all<any>(`SELECT a.source_order_id sourceOrderId,a.position_id positionId,o.symbol,o.reason,a.expected_qty expectedQty,a.confirmed_qty confirmedQty,a.state,a.price,a.fee,a.updated_at updatedAt
      FROM execution_accounting a JOIN orders o ON o.id=a.source_order_id WHERE a.scope=? AND o.bt=0 ORDER BY (a.state='complete'),a.updated_at DESC LIMIT 50`,this.scope);
    const counts=this.db.get<{total:number;incomplete:number}>(`SELECT count(*) total,coalesce(sum(a.state!='complete'),0) incomplete FROM execution_accounting a JOIN orders o ON o.id=a.source_order_id WHERE a.scope=? AND o.bt=0`,this.scope)!;
    return {...counts,rows};
  }
}
