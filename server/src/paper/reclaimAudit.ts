import type {Db} from '../db.ts';
import type {AppConfig} from '../config.ts';
import type {PaperEngine} from './engine.ts';

export function initReclaimAudit(db:Db) {
  db.run(`CREATE TABLE IF NOT EXISTS reclaim_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
    scanner_id TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL, rule_key TEXT NOT NULL,
    signal_id INTEGER, position_id INTEGER, event TEXT NOT NULL, reason TEXT)`);
  db.run('CREATE INDEX IF NOT EXISTS idx_reclaim_cell ON reclaim_events(scanner_id,symbol,tf,at)');
  if(db.kvGet('paper.reclaimAuditStartedAt')===undefined) db.kvSet('paper.reclaimAuditStartedAt',Date.now());
}
export function recordReclaimEvent(db:Db, cell:{scannerId:string;symbol:string;tf:string;signalId?:number|null;id?:number}, ruleKey:string,event:string,at:number,reason?:string) {
  db.run('INSERT INTO reclaim_events(at,scanner_id,symbol,tf,rule_key,signal_id,position_id,event,reason) VALUES(?,?,?,?,?,?,?,?,?)',
    at,cell.scannerId,cell.symbol,cell.tf,ruleKey,cell.signalId??null,cell.id??null,event,reason??null);
}
export function reclaimStatus(db:Db,cfg:AppConfig,paper:Pick<PaperEngine,'pendingEntries'|'openPositions'>,now=Date.now()) {
  return {at:now,auditStartedAt:db.kvGet<number>('paper.reclaimAuditStartedAt')??null,trials:(cfg.paper.reclaimTrials??[]).map(rule=>{
    const key=JSON.stringify(rule), args=[rule.scannerId,rule.symbol,rule.tf,key];
    const counts=Object.fromEntries(db.all<{event:string;n:number}>('SELECT event,count(*) n FROM reclaim_events WHERE scanner_id=? AND symbol=? AND tf=? AND rule_key=? GROUP BY event',...args).map(r=>[r.event,r.n]));
    const events=db.all<{at:number;event:string;reason:string|null;signal_id:number|null}>('SELECT at,event,reason,signal_id FROM reclaim_events WHERE scanner_id=? AND symbol=? AND tf=? AND rule_key=? ORDER BY id DESC LIMIT 8',...args);
    const matches=(p:{scannerId:string;symbol:string;tf:string})=>p.scannerId===rule.scannerId&&p.symbol===rule.symbol&&p.tf===rule.tf;
    const pending=paper.pendingEntries().filter(matches).map(p=>({id:p.id,phase:p.reclaim?.state.phase??'order',expiresAt:p.limit?.expiresAt??(p.reclaim?p.reclaim.state.at+p.reclaim.state.options.setupMinutes*60_000:null),price:p.limit?.price??null}));
    const open=paper.openPositions().filter(p=>matches(p)&&p.features?.reclaim_trial===1).length;
    const totals=db.get<{closed:number;net:number;sumR:number}>(`SELECT count(*) closed,coalesce(sum(p.realized_pnl-p.fees),0) net,
      coalesce(sum(CASE WHEN p.risk_amount>0 THEN (p.realized_pnl-p.fees)/p.risk_amount ELSE 0 END),0) sumR
      FROM positions p WHERE p.bt=0 AND p.status='closed' AND p.id IN
      (SELECT position_id FROM reclaim_events WHERE scanner_id=? AND symbol=? AND tf=? AND rule_key=? AND event='filled')`,...args)!;
    const saved=db.kvGet<{day:number;entries:number}>(`paper.reclaim.${rule.scannerId}|${rule.symbol}|${rule.tf}`);
    const usedToday=saved?.day===Math.floor(now/86_400_000)?saved.entries:0;
    const sc=cfg.scanners[rule.scannerId],allocated=!!sc?.enabled&&!!sc.pairs?.some(p=>p.symbol===rule.symbol&&p.tf===rule.tf);
    const run=db.get<{at:number;bar_time:number;error:string|null;funnel:string}>('SELECT at,bar_time,error,funnel FROM scanner_runs WHERE scanner_id=? AND symbol=? AND tf=?',rule.scannerId,rule.symbol,rule.tf);
    let scanNote:string|null=null;
    try {const f=JSON.parse(run?.funnel??'{}');scanNote=run?.error??f.note??(f.events?.entries===0?'No fresh entry event on the last scan':null);}catch{scanNote=run?.error??null;}
    const active=rule.enabled&&allocated&&cfg.execution.mode==='paper';
    const state=!rule.enabled?'Disabled':!allocated?'Not allocated':cfg.execution.mode!=='paper'?'Paper mode required':open?'Position open':pending.length?(pending[0].phase==='order'?'Maker order resting':pending[0].phase==='reclaim'?'Pullback seen; waiting for reclaim':'Waiting for pullback'):usedToday>=rule.maxDailyEntries?'Daily order limit reached':'Waiting for a fresh setup';
    return {rule,active,state,counts,pending,open,usedToday,closed:totals.closed,net:totals.net,sumR:totals.sumR,events,lastScan:run?{at:run.at,barTime:run.bar_time,note:scanNote}:null};
  })};
}
