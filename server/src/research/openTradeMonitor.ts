import {createHash} from 'node:crypto';
import type {Db} from '../db.ts';
import {TF_SECONDS,type PaperConfig} from '../config.ts';
import {fillExit,type Position} from '../paper/logic.ts';
import {priceExit,type ExitBook} from '../paper/exitExecution.ts';

export const MONITOR_VERSION='recovery-observer-v1';
export const MONITOR_RULES=[
 {id:'drawdown-050-v1',name:'−0.5R control',description:'Observe an exit when price reaches −0.5R. This control failed historical validation; it is not a trading recommendation.'},
 {id:'persistent-loss-v1',name:'Persistent loss',description:'After one source-timeframe bar, two observations at least a minute apart below −0.35R, with peak below +0.1R. Experimental; never executes.'},
];
export interface WatchInput {position:Position;book:number;scope:string;config:PaperConfig;marketQty:number|null;exitPending:boolean}
export interface MarketObservation {
 symbol:string;at:number;price:number|null;priceAt:number|null;depth:ExitBook|null;depthAt:number|null;
 flow:{covered:boolean;imbalance:number|null;throughAt:number|null;availableAt:number|null;minutes:number};
 funding?:unknown;
}
interface State {id:number;entryAt:number;book:number;scope:string;symbol:string;scanner:string;tf:string;side:string;firstAt:number;lastAt:number;peak:number;worst:number;r:number|null;complete:boolean;persistAt:number|null;seen:string[];state:string;reason:string;policyId:string|null;sourceHash:string|null;sim:number|null;lastSaved:number}
interface Trial {id:number;position_id:number;entry_at:number;book:number;scope:string;symbol:string;rule:string;trigger_at:number;ready_at:number;status:string;payload:string;market_qty:number;market_filled:number;net:number|null;actual_net:number|null;delta:number|null;error:string|null}
interface Payload {position:Position;config:PaperConfig;originalQty:number;fundingCount:number;reports:Array<{at:number;price:number;qty:number;marketQty:number;grossFee:number;cashFee:number;discount:number;depth:ExitBook}>}
const key=(p:{id:number;entryAt:number})=>`${p.id}:${p.entryAt}`;
const net=(p:Position)=>p.realizedPnl-p.fees;
/** Capable only of writing advisory_* tables. No engine, executor, config setter or entry-gate dependency. */
export class OpenTradeMonitor {
 readonly db:Db;private states=new Map<string,State>();private pending=new Map<number,Trial>();
 private lastMaintenance=0;private lastTick=0;
 constructor(db:Db){
  this.db=db;
  db.db.exec(`CREATE TABLE IF NOT EXISTS advisory_trade_states(position_id INTEGER NOT NULL,entry_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(position_id,entry_at));
   CREATE TABLE IF NOT EXISTS advisory_checkpoints(id INTEGER PRIMARY KEY,position_id INTEGER NOT NULL,entry_at INTEGER NOT NULL,book INTEGER NOT NULL,scope TEXT NOT NULL,symbol TEXT NOT NULL,checkpoint TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL,promotion_eligible INTEGER NOT NULL DEFAULT 0 CHECK(promotion_eligible=0),UNIQUE(position_id,entry_at,checkpoint));
   CREATE INDEX IF NOT EXISTS advisory_checkpoint_at ON advisory_checkpoints(at);
   CREATE TABLE IF NOT EXISTS advisory_exits(id INTEGER PRIMARY KEY,position_id INTEGER NOT NULL,entry_at INTEGER NOT NULL,book INTEGER NOT NULL,scope TEXT NOT NULL,symbol TEXT NOT NULL,rule TEXT NOT NULL,trigger_at INTEGER NOT NULL,ready_at INTEGER NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,market_qty INTEGER NOT NULL,market_filled INTEGER NOT NULL DEFAULT 0,net REAL,actual_net REAL,delta REAL,error TEXT,updated_at INTEGER NOT NULL,promotion_eligible INTEGER NOT NULL DEFAULT 0 CHECK(promotion_eligible=0),UNIQUE(position_id,entry_at,rule));
   CREATE INDEX IF NOT EXISTS advisory_exits_status ON advisory_exits(status,ready_at);
   CREATE INDEX IF NOT EXISTS advisory_exits_time ON advisory_exits(trigger_at);
   CREATE TABLE IF NOT EXISTS advisory_exit_liquidity(scope TEXT NOT NULL,symbol TEXT NOT NULL,side TEXT NOT NULL,book_key TEXT NOT NULL,used INTEGER NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(scope,symbol,side,book_key));
   CREATE TABLE IF NOT EXISTS advisory_reconcile(position_id INTEGER NOT NULL,entry_at INTEGER NOT NULL,PRIMARY KEY(position_id,entry_at));
   CREATE TRIGGER IF NOT EXISTS advisory_closed_revision AFTER UPDATE OF fills,realized_pnl,fees,status ON positions
   WHEN NEW.status='closed' AND NEW.bt IN (0,2)
   BEGIN INSERT OR IGNORE INTO advisory_reconcile VALUES(NEW.id,NEW.entry_at); END;`);
  for(const r of db.all<{payload:string}>('SELECT payload FROM advisory_trade_states')){const s:State=JSON.parse(r.payload);this.states.set(key(s),s);}
  for(const r of db.all<Trial>("SELECT * FROM advisory_exits WHERE status IN ('waiting','partial')"))this.pending.set(r.id,r);
 }
 observe(inputs:WatchInput[],markets:Map<string,MarketObservation>,setup:(p:Position)=>unknown,now=Date.now()){
  this.lastTick=now;const active=new Set(inputs.map(x=>key(x.position)));
  for(const input of inputs){
   const p=input.position,m=markets.get(p.symbol),unit=Math.abs(p.entryPrice-(p.slOriginal??p.entryPrice));
   if(p.status!=='open'||!(p.riskAmount>0)||!(unit>0))continue;
   let s=this.states.get(key(p));
   if(!s){s={id:p.id,entryAt:p.entryAt,book:input.book,scope:input.scope,symbol:p.symbol,scanner:p.scannerName,tf:p.tf,side:p.side,firstAt:now,lastAt:now,peak:0,worst:0,r:null,complete:now-p.entryAt<=10000,persistAt:null,seen:[],state:'warming',reason:'Awaiting a fresh observation',policyId:p.policy?.id??null,sourceHash:p.policy?.sourceHash??null,sim:p.policy?.sim??null,lastSaved:0};this.states.set(key(p),s);}
   const fresh=!!m&&m.price!==null&&m.priceAt!==null&&m.priceAt<=now&&now-m.priceAt<=10000;
   if(now-s.lastAt>15000){s.complete=false;s.persistAt=null;}
   if(!fresh){s.r=null;s.state='data-gap';s.reason='Fresh price unavailable; no hypothetical decision';s.persistAt=null;this.save(s,now);continue;}
   const r=(m!.price!-p.entryPrice)*(p.side==='long'?1:-1)/unit;
   s.peak=Math.max(s.peak,r);s.worst=Math.min(s.worst,r);s.r=r;s.lastAt=now;
   const protective=p.sl!==null&&(p.side==='long'?m!.price!<=p.sl:m!.price!>=p.sl);
   s.state=input.exitPending||protective?'exit-pending':r<=-.5?'adverse':r<0?'pullback':'favorable';
   s.reason=input.exitPending||protective?'Protective exit has priority':r<0?'Observe recovery; no automatic close':'Trade remains above entry';
   const age=now-p.entryAt,bar=(TF_SECONDS[p.tf]??900)*1000;
   const persistent=age>=bar&&r<=-.35&&s.peak<.1&&s.complete;
   if(persistent){s.persistAt??=now;}else s.persistAt=null;
   const checkpoints=[...[-.25,-.5,-.75].filter(x=>r<=x).map(x=>`drawdown:${x}`),...(age>=bar&&r<0?['losing-after-bar']:[])];
   let changed=false;
   for(const cp of checkpoints)if(!s.seen.includes(cp)){
    const payload={version:MONITOR_VERSION,state:s,market:{...m,depth:m!.depth?compactBook(m!.depth):null},setup:setup(p),entryFeatures:p.features??null,entryMlProbability:p.mlProb??null,exitNow:estimateExit(input,m!.depth,now)};
    this.db.run('INSERT OR IGNORE INTO advisory_checkpoints(position_id,entry_at,book,scope,symbol,checkpoint,at,payload) VALUES(?,?,?,?,?,?,?,?)',p.id,p.entryAt,input.book,input.scope,p.symbol,cp,now,JSON.stringify(payload));s.seen.push(cp);changed=true;
   }
   if(!input.exitPending&&!protective&&r>-1){
    if(r<=-.5)this.trigger(input,MONITOR_RULES[0].id,now);
    if(s.persistAt!==null&&now-s.persistAt>=60000)this.trigger(input,MONITOR_RULES[1].id,now);
   }
   this.save(s,now,changed);
  }
  // Closed states resolve from the immutable journal; never infer a close from a temporarily missing input.
  for(const [k,s]of this.states)if(!active.has(k)){
   const p=this.db.get<{status:string;entry_at:number}>('SELECT status,entry_at FROM positions WHERE id=?',s.id);
   if(!p||p.entry_at!==s.entryAt||p.status!=='open'){this.states.delete(k);this.db.run('DELETE FROM advisory_trade_states WHERE position_id=? AND entry_at=?',s.id,s.entryAt);}
  }
  if(now-this.lastMaintenance>60000){this.resolve(now);this.lastMaintenance=now;}
 }
 private save(s:State,now:number,force=false){if(!force&&now-s.lastSaved<60000)return;s.lastSaved=now;this.db.run('INSERT INTO advisory_trade_states VALUES(?,?,?,?) ON CONFLICT(position_id,entry_at) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload',s.id,s.entryAt,now,JSON.stringify(s));}
 private trigger(input:WatchInput,rule:string,now:number){
  const p=input.position;
  if(this.db.get('SELECT id FROM advisory_exits WHERE position_id=? AND entry_at=? AND rule=?',p.id,p.entryAt,rule))return;
  const qty=input.marketQty;
  const copy=structuredClone(p);
  // Entry features and policy identity are already captured in checkpoints. Do not duplicate
  // large source/config snapshots in every partial-fill report.
  delete copy.policy;delete copy.executionPlan;delete copy.features;
  const payload:Payload={position:copy,config:structuredClone(input.config),originalQty:p.qtyOpen,fundingCount:p.fills.filter(f=>f.reason==='funding').length,reports:[]};
  const valid=Number.isSafeInteger(qty)&&qty! > 0;
  const x=this.db.run('INSERT INTO advisory_exits(position_id,entry_at,book,scope,symbol,rule,trigger_at,ready_at,status,payload,market_qty,error,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',p.id,p.entryAt,input.book,input.scope,p.symbol,rule,now,now+Math.max(0,input.config.latencyMs??0),valid?'waiting':'unpriced',JSON.stringify(payload),valid?qty!:0,valid?null:'No frozen executable quantity',now);
  if(valid){const id=Number(x.lastInsertRowid);this.pending.set(id,this.db.get<Trial>('SELECT * FROM advisory_exits WHERE id=?',id)!);}
 }
 due(now=Date.now()){return [...this.pending.values()].filter(t=>t.ready_at<=now).sort((a,b)=>(a.book===0?0:1)-(b.book===0?0:1)||a.ready_at-b.ready_at);}
 /** Called only with a NEW public depth observation. Never calls the real execution queue. */
 settle(symbol:string,book:ExitBook|null,now:number,current:(id:number)=>Position|undefined){
  for(const t of this.due(now).filter(t=>t.symbol===symbol)){
   const x:Payload=JSON.parse(t.payload),actual=current(t.position_id);
   if(!actual||actual.entryAt!==t.entry_at){this.finish(t,'censored','Position reset or unavailable',now);continue;}
   if(actual.fills.some(f=>f.at>=t.trigger_at&&f.qty>0&&f.reason!=='entry')){this.finish(t,'censored','Actual exit occurred before hypothetical completion',now);continue;}
   if(now-t.ready_at>60000){this.finish(t,'unpriced','No complete executable fill within 60 seconds',now);continue;}
   if(!book||book.receivedAt<t.ready_at)continue;
   book=compactBook(book);
   const bookKey=createHash('sha256').update(JSON.stringify([book.exchangeAt,book.bids,book.asks])).digest('hex');
   const scope=t.book===0?`paper:${t.rule}`:`shadow:${t.position_id}:${t.entry_at}:${t.rule}`;
   const used=this.db.get<{used:number}>('SELECT used FROM advisory_exit_liquidity WHERE scope=? AND symbol=? AND side=? AND book_key=?',scope,symbol,x.position.side,bookKey)?.used??0;
   const fill=priceExit(book,x.position.side,t.market_qty-t.market_filled,now,1000,used);
   if(fill.error||fill.price===null)continue;
   const done=t.market_filled+fill.qty===t.market_qty;
   const quantity=done?x.position.qtyOpen:Math.floor(x.originalQty*(t.market_filled+fill.qty)/t.market_qty)-(x.originalQty-x.position.qtyOpen);
   if(quantity<=0)continue;
   // Preserve funding incurred before the hypothetical close, prorated after partial fills.
   const funding=actual.fills.filter(f=>f.reason==='funding');
   for(const f of funding.slice(x.fundingCount)){if(f.at>now)break;const scaled={...f,pnl:f.pnl*x.position.qtyOpen/Math.max(1,actual.qtyOpen)};x.position.realizedPnl+=scaled.pnl;x.position.fills.push(scaled);x.fundingCount++;}
   const f=fillExit(x.position,fill.price,quantity,'advisory-exit',now,x.config,'depth');
   x.reports.push({at:now,price:fill.price,qty:quantity,marketQty:fill.qty,grossFee:f.feeGross??f.fee,cashFee:f.fee,discount:f.feeDiscount??0,depth:compactBook(book)});
   const next={market_filled:t.market_filled+fill.qty,payload:JSON.stringify(x),status:done?'filled':'partial',net:done?net(x.position):null};
   this.db.transaction(()=>{
    this.db.run('UPDATE advisory_exits SET market_filled=?,payload=?,status=?,net=?,error=NULL,updated_at=? WHERE id=?',next.market_filled,next.payload,next.status,next.net,now,t.id);
    this.db.run('INSERT INTO advisory_exit_liquidity VALUES(?,?,?,?,?,?) ON CONFLICT(scope,symbol,side,book_key) DO UPDATE SET used=used+excluded.used,at=excluded.at',scope,symbol,x.position.side,bookKey,fill.qty,now);
   });
   Object.assign(t,next);
   if(done)this.pending.delete(t.id);
  }
 }
 private finish(t:Trial,status:string,error:string,now:number){this.db.run('UPDATE advisory_exits SET status=?,error=?,updated_at=? WHERE id=?',status,error,now,t.id);this.pending.delete(t.id);}
 resolve(now=Date.now()){
  for(const t of this.pending.values())if(now-t.ready_at>60000)this.finish(t,'unpriced','Observation window expired; no inferred fill',now);
  // Funding may be reconciled after a position closed. Revalue only settlements before the hypothetical fill.
  for(const row of this.db.all<{id:number;payload:string;fills:string;qty:number;net:number}>(`SELECT a.id,a.payload,p.fills,p.qty,a.net FROM advisory_exits a JOIN positions p ON p.id=a.position_id AND p.entry_at=a.entry_at WHERE a.status='filled' AND p.status='closed' AND (a.actual_net IS NULL OR EXISTS(SELECT 1 FROM advisory_reconcile r WHERE r.position_id=p.id AND r.entry_at=p.entry_at))`)){
    const x:Payload=JSON.parse(row.payload),actual=JSON.parse(row.fills)?.fills??[];
    const amount=reconciledHypotheticalNet(x,actual,row.qty);
    if(Math.abs(amount-row.net)>1e-9)this.db.run('UPDATE advisory_exits SET net=? WHERE id=?',amount,row.id);
  }
  this.db.run(`UPDATE advisory_exits SET actual_net=(SELECT realized_pnl-fees FROM positions p WHERE p.id=position_id AND p.entry_at=advisory_exits.entry_at),
   delta=CASE WHEN status='filled' THEN net-(SELECT realized_pnl-fees FROM positions p WHERE p.id=position_id AND p.entry_at=advisory_exits.entry_at) ELSE NULL END,
   updated_at=? WHERE EXISTS(SELECT 1 FROM positions p WHERE p.id=position_id AND p.entry_at=advisory_exits.entry_at AND p.status='closed')
   AND (actual_net IS NULL OR EXISTS(SELECT 1 FROM advisory_reconcile r WHERE r.position_id=advisory_exits.position_id AND r.entry_at=advisory_exits.entry_at))`,now);
  this.db.run('DELETE FROM advisory_reconcile');
  this.db.run("UPDATE advisory_exits SET status='censored',delta=NULL,error='Actual position unavailable or reset' WHERE status='filled' AND actual_net IS NULL AND NOT EXISTS(SELECT 1 FROM positions p WHERE p.id=position_id AND p.entry_at=advisory_exits.entry_at)");
  this.db.run('DELETE FROM advisory_exit_liquidity WHERE at<?',now-86400000);
  // Bound storage independently of trading journals. Keep 90 days / 200k checkpoints and 50k trials.
  this.db.run('DELETE FROM advisory_checkpoints WHERE at<? OR id IN (SELECT id FROM advisory_checkpoints ORDER BY id DESC LIMIT -1 OFFSET 200000)',now-90*86400000);
  this.db.run("DELETE FROM advisory_exits WHERE status NOT IN ('waiting','partial') AND (trigger_at<? OR id IN (SELECT id FROM advisory_exits ORDER BY id DESC LIMIT -1 OFFSET 50000))",now-90*86400000);
 }
 view(){
  const rows=this.db.all<any>(`SELECT id,position_id,entry_at,book,scope,symbol,rule,trigger_at,ready_at,status,market_qty,market_filled,net,actual_net,delta,error,
   json_extract(payload,'$.position.riskAmount') risk FROM advisory_exits ORDER BY id DESC LIMIT 300`);
  const summary=this.db.all<any>(`SELECT book,scope,rule,count(*) trials,sum(status='filled' AND actual_net IS NOT NULL) resolved,
   sum(CASE WHEN status='filled' AND actual_net IS NOT NULL THEN delta ELSE 0 END) deltaUsd,
   sum(CASE WHEN status='filled' AND actual_net IS NOT NULL THEN delta/json_extract(payload,'$.position.riskAmount') ELSE 0 END) deltaR,
   sum(status IN ('unpriced','censored')) unavailable,sum(status='filled' AND actual_net>0 AND net<0) winnersLost FROM advisory_exits GROUP BY book,scope,rule`);
  return {mode:'advisory' as const,version:MONITOR_VERSION,at:this.lastTick,rules:MONITOR_RULES,positions:[...this.states.values()],trials:rows,summary};
 }
 detail(id:number){return this.db.all<any>('SELECT checkpoint,at,payload FROM advisory_checkpoints WHERE position_id=? ORDER BY at LIMIT 100',id).map(x=>({...x,payload:JSON.parse(x.payload)}));}
}
export function reconciledHypotheticalNet(x:Payload,actual:Position['fills'],actualQty:number){
 const through=x.reports.at(-1)?.at??0,p=x.position;
 let funding=0;
 for(const f of actual.filter(f=>f.reason==='funding'&&f.at<=through)){
  const realQty=actualQty-actual.filter(e=>e.reason!=='entry'&&e.reason!=='funding'&&e.qty>0&&e.at<f.at).reduce((a,e)=>a+e.qty,0);
  const hypotheticalQty=f.at<(x.reports[0]?.at??Infinity)
   ? realQty : x.originalQty-x.reports.filter(e=>e.at<f.at).reduce((a,e)=>a+e.qty,0);
  funding+=realQty>0?f.pnl*hypotheticalQty/realQty:0;
 }
 return net(p)-p.fills.filter(f=>f.reason==='funding').reduce((a,f)=>a+f.pnl,0)+funding;
}
export function compactBook(book:ExitBook):ExitBook{return {...book,bids:book.bids.slice(0,100),asks:book.asks.slice(0,100)};}
export function estimateExit(input:WatchInput,depth:ExitBook|null,now:number){
 if(!input.marketQty)return {netR:null,netUsd:null,coverage:0};
 const q=priceExit(depth?compactBook(depth):null,input.position.side,input.marketQty,now,1000);
 if(q.error||q.qty!==input.marketQty||q.price===null)return {netR:null,netUsd:null,coverage:q.qty/input.marketQty};
 const p=structuredClone(input.position);fillExit(p,q.price,p.qtyOpen,'advisory-quote',now,input.config,'depth');
 return {netR:net(p)/p.riskAmount,netUsd:input.book===0?net(p):null,coverage:1};
}
