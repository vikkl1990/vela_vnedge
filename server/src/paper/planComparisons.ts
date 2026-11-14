import type { AppConfig } from '../config.ts';
import type { Db } from '../db.ts';
import type { Bar } from '../data/candleStore.ts';
import {extractEvents, type ScanEvent} from '../scanners/extractor.ts';
import type {WorkerResult} from '../pine/worker.ts';
import {readingOf} from '../scanners/reading.ts';
import {applyRules} from '../scanners/rules.ts';
import {TF_SECONDS} from '../config.ts';
import type { PaperEngine, MarketInfo } from './engine.ts';
import { lastAtr } from '../data/indicators.ts';
import { planSnapshot, planScannerId, planEvents, takeProfitLabel, type ExecutionPlanSnapshot } from './executionPlans.ts';

type Observation={scannerId:string;scannerName:string;symbol:string;tf:string;event:ScanEvent;bars:Bar[];market:MarketInfo;at:number;refPrice:number;refusal?:string|null};
export type ComparisonScan=Omit<Observation,'event'|'refusal'> & {result:WorkerResult;patched:string;variantOf?:string;since:number;newLabelKeys:Set<string>;refusal:(event:ScanEvent)=>string|null|undefined};

/** Reporting only: these titles are the same Pine condition on different output channels.
 * Preserve the stored marker and admission identity. Never pair unrelated flips just because
 * they happened on the same bar, and leave opposite retest readings paired by their raw marker.
 */
function matchedReadingKey(raw:string):string {
  let parts:unknown;try{parts=JSON.parse(raw);}catch{return raw;}
  if(!Array.isArray(parts)||parts.length!==6)return raw;
  const [scanner,symbol,tf,bar,channel,label]=parts;
  if(typeof label!=='string')return raw;
  const title=label.replace(/^[🟢🔴]\s*/u,'').trim().toLowerCase();
  let match:RegExpMatchArray|null=null,kind='';
  if(scanner==='machine-learning-rsi-ai-classification-ranking-zeiierman'){
    match=channel==='alertcondition'?title.match(/^(long|short) signal$/):
      channel==='alert'||channel==='shape'?title.match(/^(long|short)$/):null;
    kind='classifier-entry';
  }else if(scanner==='supertrend-cluster-zeiierman'){
    match=channel==='alertcondition'?title.match(/^(long|short)$/):
      channel==='shape'?title.match(/^major (long|short)$/):null;
    kind='cluster-vote';
  }
  return match?JSON.stringify([scanner,symbol,tf,bar,kind,match[1]]):raw;
}

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
    db.run('CREATE TABLE IF NOT EXISTS execution_plan_scans(scanner_id TEXT NOT NULL,bar_at INTEGER NOT NULL,at INTEGER NOT NULL,entries INTEGER NOT NULL,exits INTEGER NOT NULL,drops TEXT NOT NULL,PRIMARY KEY(scanner_id,bar_at))');
    // A basket add fills into its existing position, not the temporary pending id.
    // Recover its event join from the same-transaction per-leg ledger after a crash.
    db.run(`UPDATE execution_plan_events SET position_id=(SELECT b.position_id FROM paper_basket_entries b WHERE b.plan_event_id=execution_plan_events.id),
      filled_at=(SELECT b.at FROM paper_basket_entries b WHERE b.plan_event_id=execution_plan_events.id),action='opened',reason=NULL
      WHERE action IN ('processing','pending') AND id IN (SELECT plan_event_id FROM paper_basket_entries WHERE plan_event_id IS NOT NULL)`);
    // Recover the join if a process stopped between the atomic position write and the event update.
    db.run(`UPDATE execution_plan_events SET position_id=(SELECT p.id FROM positions p
      WHERE p.bt=2 AND json_extract(p.fills,'$.features.plan_event_id')=execution_plan_events.id LIMIT 1)
      WHERE action='processing' AND position_id IS NULL`);
    db.run("UPDATE execution_plan_events SET action='interrupted', reason='process stopped during admission; inspect linked position' WHERE action='processing'");
    db.run("UPDATE execution_plan_events SET action='cancelled',reason='pending order removed during restart' WHERE action='pending' AND position_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM positions p WHERE p.id=execution_plan_events.position_id)");
    paper.on('order',(o:{positionId:number;reason:string;at:number;planEventId?:number})=>{
      if(o.reason!=='entry')return;
      const p=paper.position(o.positionId),id=o.planEventId??p?.features?.plan_event_id;
      if(id)db.run("UPDATE execution_plan_events SET position_id=?,filled_at=?,action='opened',reason=NULL WHERE id=?",o.positionId,o.at,id);
    });
    paper.on('pending',(e:{type:string;id?:number;reason?:string})=>{
      if(e.type==='cancelled'&&e.id!==undefined)db.run("UPDATE execution_plan_events SET action='cancelled',reason=? WHERE position_id=?",e.reason??'cancelled',e.id);
    });
  }

  /** Legacy exit/TP experiments consume the current interpretation only. */
  observe(input:Observation) {
    if(input.event.kind==='exit'){
      for(const pos of this.paper.openPositions()){
        const p=pos.executionPlan;
        if(p&&!p.readingOverride&&p.sourceScannerId===input.scannerId&&pos.symbol===input.symbol&&pos.tf===input.tf&&p.sourceHash===this.sourceHash(input.scannerId))this.execute(input,p);
      }
      return;
    }
    for(const d of this.cfg().executionPlans??[]){
      if(!d.enabled||d.readingOverride||d.scannerId!==input.scannerId||d.symbol!==input.symbol||d.tf!==input.tf)continue;
      this.execute(input,planSnapshot(this.cfg(),d,this.sourceHash(input.scannerId),input.market.productFees??this.paper.marketFeesFor?.(input.symbol)));
    }
  }

  /** Read both arms from the same raw run, before the control can discard a marker. */
  observeScan(input:ComparisonScan){
    const snapshots=new Map<string,{p:ExecutionPlanSnapshot;enabled:boolean}>();
    for(const d of this.cfg().executionPlans??[]){
      if(!d.enabled||!d.readingOverride||d.scannerId!==input.scannerId||d.symbol!==input.symbol||d.tf!==input.tf)continue;
      const p=planSnapshot(this.cfg(),d,this.sourceHash(d.scannerId),input.market.productFees??this.paper.marketFeesFor?.(input.symbol));
      snapshots.set(planScannerId(p),{p,enabled:true});
    }
    // A retired reading still supplies the exits promised to its held positions.
    for(const pos of this.paper.openPositions()){
      const p=pos.executionPlan;
      if(p?.readingOverride&&p.sourceScannerId===input.scannerId&&pos.symbol===input.symbol&&pos.tf===input.tf&&p.sourceHash===this.sourceHash(input.scannerId)&&!snapshots.has(pos.scannerId))snapshots.set(pos.scannerId,{p,enabled:false});
    }
    for(const [scannerId,{p,enabled}] of snapshots){
      const read=readingOf(p.reading??undefined,input.scannerId,TF_SECONDS[input.tf]*1000,input.patched,input.variantOf);
      const derived=applyRules({scannerId:input.scannerId,...input.result,bars:input.bars,mode:'live',newLabelKeys:input.newLabelKeys,...read.rule});
      const drops:Record<string,number>={};
      const events=extractEvents(input.result.alerts,input.result.shapes,{...read.extract,drawn:input.result.labels,derived,sinceBarTime:input.since,drops})
        .filter(e=>e.kind!=='entry'||e.barTime>=input.bars.at(-1)!.time);
      this.remember(input,p);
      if(enabled)this.db.run('INSERT OR IGNORE INTO execution_plan_scans VALUES(?,?,?,?,?,?)',scannerId,input.bars.at(-1)!.time,input.at,events.filter(e=>e.kind==='entry').length,events.filter(e=>e.kind==='exit').length,JSON.stringify(drops));
      for(const event of events){
        if(event.kind==='info'||(!enabled&&event.kind==='entry'))continue;
        this.execute({...input,event,refusal:event.kind==='entry'?input.refusal(event):null},p);
      }
    }
  }

  private remember(input:Observation|ComparisonScan,p:ExecutionPlanSnapshot){
    this.db.run('INSERT OR IGNORE INTO execution_plan_cohorts VALUES(?,?,?,?,?,?,?,?)',planScannerId(p),p.id,p.revision,p.signature,p.symbol,p.tf,input.at,JSON.stringify(p));
  }
  private execute(input:Observation,p:ExecutionPlanSnapshot){
    const ev=input.event,scannerId=planScannerId(p);
    if(ev.kind==='exit'){
      this.paper.onScriptExit(scannerId,p.symbol,p.tf,ev.exitType??'close',ev.price,input.at,p.exitMode,ev.side);
      return;
    }
    if(ev.kind!=='entry'||!ev.side)return;
    this.remember(input,p);
    // Reading arms can take opposite sides of the same raw marker; the marker still pairs.
    const eventKey=JSON.stringify([input.scannerId,input.symbol,input.tf,ev.barTime,p.readingOverride?ev.source:ev.side,ev.label]);
    const added=this.db.run("INSERT OR IGNORE INTO execution_plan_events(at,plan_id,scanner_id,source_event,action) VALUES(?,?,?,?,'processing')",input.at,p.id,scannerId,eventKey);
    if(!added.changes)return;
    const id=Number(added.lastInsertRowid);
    const occupied=[...this.paper.openPositions(),...this.paper.pendingEntries()].some(x=>x.executionPlan?.id===p.id&&x.scannerId!==scannerId);
    if(input.refusal||occupied){this.db.run("UPDATE execution_plan_events SET action='rejected',reason=? WHERE id=?",input.refusal??'previous plan version still holds an order or position',id);return;}
    try{
      const event=planEvents([ev],input.bars,p)[0];
      const d=this.paper.onEntry(event,{scannerId,scannerName:`${input.scannerName} · ${p.label??p.variant} v${p.revision}`,symbol:p.symbol,tf:p.tf,
        market:input.market,at:input.at,refPrice:input.refPrice,atr:lastAtr(input.bars,14),signalBar:input.bars.at(-1),exitMode:p.exitMode,signalId:null,executionPlan:p,features:{plan_event_id:id}});
      this.db.run('UPDATE execution_plan_events SET action=?,reason=?,position_id=? WHERE id=?',d.action,d.reason??null,d.position?.id??d.pendingId??null,id);
    }catch(error){this.db.run("UPDATE execution_plan_events SET action='error',reason='admission failed; inspect service log' WHERE id=?",id);throw error;}
  }

  view() {
    const cfg=this.cfg();
    const configured=(cfg.executionPlans??[]).map(p=>{
      try{
        const snapshot=planSnapshot(cfg,p,this.sourceHash(p.scannerId),this.paper.marketFeesFor?.(p.symbol));
        return {...p,signature:snapshot.signature,takeProfitLabel:takeProfitLabel(snapshot),configurationError:null};
      }catch(error){
        // Legacy/manual config edits must not hide other plans or historical results.
        return {...p,signature:null,takeProfitLabel:'Policy unavailable',configurationError:error instanceof Error?error.message:'Invalid effective plan policy'};
      }
    });
    const valid=configured.filter((p):p is typeof p & {signature:string}=>p.signature!==null);
    const eventsByCohort=new Map<string,any[]>();
    const cohorts=this.db.all<any>('SELECT * FROM execution_plan_cohorts ORDER BY first_at DESC').map(row=>{
      const p=JSON.parse(row.snapshot) as ExecutionPlanSnapshot;
      const events=this.db.all<any>('SELECT e.*,p.status,p.realized_pnl,p.fees,p.risk_amount,p.exit_reason,p.exit_at FROM execution_plan_events e LEFT JOIN positions p ON p.id=e.position_id AND p.bt=2 WHERE e.scanner_id=? ORDER BY e.at',row.scanner_id);
      eventsByCohort.set(row.scanner_id,events);
      const positions=[...new Map(events.filter(e=>e.status==='open'||e.status==='closed').map(e=>[e.position_id,e])).values()];
      const closed=positions.filter(e=>e.status==='closed').sort((a,b)=>a.exit_at-b.exit_at);
      let balance=0,peak=0,drawdown=0;
      for(const e of closed){balance+=e.realized_pnl-e.fees;peak=Math.max(peak,balance);drawdown=Math.max(drawdown,peak-balance);}
      const reasons:Record<string,number>={};
      for(const e of events)if(e.reason)reasons[e.reason]=(reasons[e.reason]??0)+1;
      const gains=closed.map(e=>e.realized_pnl-e.fees).filter(n=>n>0),losses=closed.map(e=>e.realized_pnl-e.fees).filter(n=>n<0);
      const avgWin=gains.length?gains.reduce((a,b)=>a+b,0)/gains.length:null,avgLoss=losses.length?losses.reduce((a,b)=>a+b,0)/losses.length:null;
      const scans=this.db.get<{n:number;last:number|null}>('SELECT count(*) n,max(at) last FROM execution_plan_scans WHERE scanner_id=?',row.scanner_id)!;
      return {partialExitVersion:p.partialExitVersion??null,executionVersion:p.executionVersion??null,readingVersion:p.readingOverride?.version??null,scans:scans.n,lastScanAt:scans.last,id:p.id,label:p.label??p.id,comparison:p.comparison,revision:p.revision,signature:p.signature,sourceScannerId:p.sourceScannerId,takeProfitLabel:takeProfitLabel(p),symbol:p.symbol,tf:p.tf,variant:p.variant,firstAt:row.first_at,
        referenceEquity:p.referenceEquity,margin:p.paper.marginPerTrade,leverage:p.paper.marginLeverage?.base,
        maxStopLossPct:p.paper.maxStopLossPct,avgWin,avgLoss,winRate:closed.length?gains.length/closed.length:null,
        payoffRatio:avgWin!==null&&avgLoss!==null?avgWin/-avgLoss:null,
        breakEvenWinRate:avgWin!==null&&avgLoss!==null?-avgLoss/(avgWin-avgLoss):null,
        signals:events.length,placed:events.filter(e=>e.position_id!==null).length,
        filled:positions.length,filledEntries:events.filter(e=>e.status==='open'||e.status==='closed').length,
        pending:events.filter(e=>e.status==='pending').length,open:positions.filter(e=>e.status==='open').length,
        closed:closed.length,stops:closed.filter(e=>e.exit_reason==='sl').length,net:balance,fees:closed.reduce((n,e)=>n+e.fees,0),
        avgR:closed.length?closed.reduce((n,e)=>n+(e.risk_amount>0?(e.realized_pnl-e.fees)/e.risk_amount:0),0)/closed.length:null,
        drawdown,reasons,positionIds:positions.slice(-5).reverse().map(e=>e.position_id as number)};
    });
    const comparisons=[];
    for(const group of new Set(valid.filter(p=>p.comparison).map(p=>p.comparison!.group))){
      const control=valid.find(p=>p.comparison?.group===group&&p.comparison.role==='control');
      const candidate=valid.find(p=>p.comparison?.group===group&&p.comparison.role==='candidate');
      if(!control||!candidate)continue;
      const ce=eventsByCohort.get(planScannerId(control))??[],ve=eventsByCohort.get(planScannerId(candidate))??[];
      const key=(e:any,p:typeof control)=>p.readingOverride?matchedReadingKey(e.source_event):e.source_event;
      const cm=new Map(ce.map(e=>[key(e,control),e])),vm=new Map(ve.map(e=>[key(e,candidate),e]));
      const shared=[...cm.keys()].filter(k=>vm.has(k));
      const paired=shared.map(k=>[cm.get(k)!,vm.get(k)!]).filter(([a,b])=>a.status==='closed'&&b.status==='closed');
      const unresolved=(e:any)=>e.status!=='closed'&&(e.status==='open'||e.status==='pending'||['pending','processing','error','interrupted'].includes(e.action));
      const controlNet=cohorts.find(c=>c.id===control.id&&c.signature===control.signature)?.net??0;
      const candidateNet=cohorts.find(c=>c.id===candidate.id&&c.signature===candidate.signature)?.net??0;
      comparisons.push({kind:control.readingOverride?'reading':'exit',group,symbol:control.symbol,tf:control.tf,enabled:control.enabled&&candidate.enabled,
        controlId:control.id,candidateId:candidate.id,controlLabel:control.label??control.id,candidateLabel:candidate.label??candidate.id,
        controlSignature:control.signature,candidateSignature:candidate.signature,controlNet,candidateNet,
        sharedSignals:shared.length,controlOnly:cm.size-shared.length,candidateOnly:vm.size-shared.length,
        unresolvedSignals:shared.filter(k=>unresolved(cm.get(k))||unresolved(vm.get(k))).length,
        differentAdmissions:shared.filter(k=>Boolean(cm.get(k).status==='open'||cm.get(k).status==='closed')!==Boolean(vm.get(k).status==='open'||vm.get(k).status==='closed')).length,
        matchedClosed:paired.length,matchedDeltaNet:paired.length?paired.reduce((sum,[a,b])=>sum+(b.realized_pnl-b.fees)-(a.realized_pnl-a.fees),0):null});
    }
    return {configured,cohorts,comparisons};
  }
}
