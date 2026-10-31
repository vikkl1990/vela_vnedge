import type { AppConfig } from '../config.ts';
import type { Db } from '../db.ts';
import type { Bar } from '../data/candleStore.ts';
import type { ScanEvent } from '../scanners/extractor.ts';
import type { PaperEngine, MarketInfo } from './engine.ts';
import { lastAtr } from '../data/indicators.ts';
import { planSnapshot, planScannerId, planEvents, type ExecutionPlanSnapshot } from './executionPlans.ts';

/** Fan-out of ONE live source run into isolated plans inside the existing shadow engine. */
export class PlanComparisons {
  private db:Db; private cfg:()=>AppConfig; private paper:PaperEngine; private sourceHash:(id:string)=>string|null;
  constructor(db:Db, cfg:()=>AppConfig, paper:PaperEngine, sourceHash:(id:string)=>string|null) {
    this.db=db;this.cfg=cfg;this.paper=paper;this.sourceHash=sourceHash;
    db.run(`CREATE TABLE IF NOT EXISTS execution_plan_cohorts (
      scanner_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, revision INTEGER NOT NULL, signature TEXT NOT NULL,
      symbol TEXT NOT NULL, tf TEXT NOT NULL, first_at INTEGER NOT NULL, snapshot TEXT NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS execution_plan_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, plan_id TEXT NOT NULL, scanner_id TEXT NOT NULL,
      source_event TEXT NOT NULL, action TEXT NOT NULL, reason TEXT, position_id INTEGER, filled_at INTEGER,
      UNIQUE(plan_id,source_event))`);
    db.run('CREATE INDEX IF NOT EXISTS idx_plan_events_scanner ON execution_plan_events(scanner_id,at)');
    // Recover the join if a process stopped between the atomic position write and the event update.
    db.run(`UPDATE execution_plan_events SET position_id=(SELECT p.id FROM positions p
      WHERE p.bt=2 AND json_extract(p.fills,'$.features.plan_event_id')=execution_plan_events.id LIMIT 1)
      WHERE action='processing' AND position_id IS NULL`);
    db.run("UPDATE execution_plan_events SET action='interrupted', reason='process stopped during admission; inspect linked position' WHERE action='processing'");
    db.run("UPDATE execution_plan_events SET action='cancelled',reason='pending order removed during restart' WHERE action='pending' AND position_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM positions p WHERE p.id=execution_plan_events.position_id)");
    paper.on('order',(o:{positionId:number;reason:string;at:number})=>{
      if(o.reason!=='entry')return;
      const p=paper.position(o.positionId),id=p?.features?.plan_event_id;
      if(id)db.run("UPDATE execution_plan_events SET position_id=?,filled_at=?,action='opened' WHERE id=?",o.positionId,o.at,id);
    });
    paper.on('pending',(e:{type:string;id?:number;reason?:string})=>{
      if(e.type==='cancelled'&&e.id!==undefined)db.run("UPDATE execution_plan_events SET action='cancelled',reason=? WHERE position_id=?",e.reason??'cancelled',e.id);
    });
  }

  observe(input:{scannerId:string;scannerName:string;symbol:string;tf:string;event:ScanEvent;bars:Bar[];market:MarketInfo;at:number;refPrice:number;refusal?:string|null}) {
    const {event:ev}=input;
    if(ev.kind==='exit') {
      // Retired or reconfigured plans still receive the exits promised by their entry snapshot.
      for(const pos of this.paper.openPositions()) {
        const p=pos.executionPlan;
        if(p?.sourceScannerId===input.scannerId&&pos.symbol===input.symbol&&pos.tf===input.tf)
          this.paper.onScriptExit(pos.scannerId,pos.symbol,pos.tf,ev.exitType??'close',ev.price,input.at,p.exitMode,ev.side);
      }
      return;
    }
    if(ev.kind!=='entry'||!ev.side)return;
    const cfg=this.cfg();
    for(const definition of cfg.executionPlans??[]) {
      if(!definition.enabled||definition.scannerId!==input.scannerId||definition.symbol!==input.symbol||definition.tf!==input.tf)continue;
      const p=planSnapshot(cfg,definition,this.sourceHash(input.scannerId)), scannerId=planScannerId(p);
      this.db.run('INSERT OR IGNORE INTO execution_plan_cohorts VALUES(?,?,?,?,?,?,?,?)',scannerId,p.id,p.revision,p.signature,p.symbol,p.tf,input.at,JSON.stringify(p));
      const eventKey=JSON.stringify([input.scannerId,input.symbol,input.tf,ev.barTime,ev.side,ev.label]);
      const added=this.db.run("INSERT OR IGNORE INTO execution_plan_events(at,plan_id,scanner_id,source_event,action) VALUES(?,?,?,?,'processing')",input.at,p.id,scannerId,eventKey);
      if(!added.changes)continue;
      const id=Number(added.lastInsertRowid);
      // A new revision must not overlap an older position or pending order for this plan.
      const occupied=[...this.paper.openPositions(),...this.paper.pendingEntries()].some(x=>x.executionPlan?.id===p.id&&x.scannerId!==scannerId);
      if(input.refusal||occupied){this.db.run("UPDATE execution_plan_events SET action='rejected',reason=? WHERE id=?",input.refusal??'previous plan version still holds an order or position',id);continue;}
      try {
        const event=planEvents([ev],input.bars,p)[0];
        const d=this.paper.onEntry(event,{scannerId,scannerName:`${input.scannerName} · ${p.variant} v${p.revision}`,symbol:p.symbol,tf:p.tf,
          market:input.market,at:input.at,refPrice:input.refPrice,atr:lastAtr(input.bars,14),exitMode:p.exitMode,signalId:null,executionPlan:p,features:{plan_event_id:id}});
        this.db.run('UPDATE execution_plan_events SET action=?,reason=?,position_id=? WHERE id=?',d.action,d.reason??null,d.position?.id??d.pendingId??null,id);
      } catch(error) {
        this.db.run("UPDATE execution_plan_events SET action='error',reason='admission failed; inspect service log' WHERE id=?",id);
        throw error;
      }
    }
  }

  view() {
    const configured=(this.cfg().executionPlans??[]).map(p=>({...p,signature:planSnapshot(this.cfg(),p,this.sourceHash(p.scannerId)).signature}));
    const cohorts=this.db.all<any>('SELECT * FROM execution_plan_cohorts ORDER BY first_at DESC').map(row=>{
      const p=JSON.parse(row.snapshot) as ExecutionPlanSnapshot;
      const events=this.db.all<any>('SELECT e.*,p.status,p.realized_pnl,p.fees,p.risk_amount,p.exit_reason,p.exit_at FROM execution_plan_events e LEFT JOIN positions p ON p.id=e.position_id AND p.bt=2 WHERE e.scanner_id=? ORDER BY e.at',row.scanner_id);
      const closed=events.filter(e=>e.status==='closed').sort((a,b)=>a.exit_at-b.exit_at);
      let balance=0,peak=0,drawdown=0;
      for(const e of closed){balance+=e.realized_pnl-e.fees;peak=Math.max(peak,balance);drawdown=Math.max(drawdown,peak-balance);}
      const reasons:Record<string,number>={};
      for(const e of events)if(e.reason)reasons[e.reason]=(reasons[e.reason]??0)+1;
      return {id:p.id,revision:p.revision,signature:p.signature,symbol:p.symbol,tf:p.tf,variant:p.variant,firstAt:row.first_at,
        referenceEquity:p.referenceEquity,margin:p.paper.marginPerTrade,leverage:p.paper.marginLeverage?.base,
        signals:events.length,placed:events.filter(e=>e.position_id!==null).length,
        filled:events.filter(e=>e.status==='open'||e.status==='closed').length,
        pending:events.filter(e=>e.status==='pending').length,open:events.filter(e=>e.status==='open').length,
        closed:closed.length,stops:closed.filter(e=>e.exit_reason==='sl').length,net:balance,fees:closed.reduce((n,e)=>n+e.fees,0),
        avgR:closed.length?closed.reduce((n,e)=>n+(e.risk_amount>0?(e.realized_pnl-e.fees)/e.risk_amount:0),0)/closed.length:null,
        drawdown,reasons,positionIds:events.filter(e=>e.status==='open'||e.status==='closed').slice(-5).reverse().map(e=>e.position_id as number)};
    });
    return {configured,cohorts};
  }
}
