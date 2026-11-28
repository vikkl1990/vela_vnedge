import type {Db} from '../db.ts';
import {impactOnly,type Position} from '../paper/logic.ts';
import {priceExit,type ExitBook,CAUSAL_CANDLE_VERSION} from '../paper/exitExecution.ts';
import {tradePolicyIdFor} from '../paper/tradePolicy.ts';
import type {IntrabarFlowSnapshot} from '../orderflow/intrabar.ts';
import type {WatchInput} from './openTradeMonitor.ts';

export const INTRABAR_RULE='intrabar-flow-protection-v1';
export const INTRABAR_STRESS='intrabar-flow-protection-stress-v1';
export const EARLY_PROFIT_RULE='early-net-profit-retreat-v1';
export const EARLY_PROFIT_STRESS='early-net-profit-retreat-stress-v1';
interface Cohort {
 id:number;entryAt:number;scanner:string;symbol:string;tf:string;policyId:string;sourceHash:string;
 qty:number;marketQty:number;entryPrice:number;stop:number;risk:number;status:'watching'|'triggered'|'unverified'|'unchanged';
 reason:string|null;lastAt:number;savedAt:number;peakR:number|null;adverseSince:number|null;
 samples:number;usable:number;quiet:number;unavailable:number;
 retreat?:{previousR:number;bookKey:string;confirmations:number};
}
export function pressure(flow:IntrabarFlowSnapshot,book:ExitBook,side:'long'|'short',now:number){
 const sign=side==='long'?1:-1,w=flow.windows;
 if(!flow.covered||flow.at!==now)return {ready:false,reason:flow.reason??'flow unavailable',adverse:false,depthImbalance:null};
 if(w.s60.trades<10||w.s15.trades<3||flow.lastTradeAt===null||now-flow.lastTradeAt>3000)
  return {ready:false,reason:'insufficient recent activity',adverse:false,depthImbalance:null};
 const bid=Math.max(...book.bids.map(x=>x.price)),ask=Math.min(...book.asks.map(x=>x.price));
 // Compare resting contracts within ten bps of each best price, not an unequal number of levels.
 const b=book.bids.filter(x=>x.price>=bid*.999).reduce((n,x)=>n+x.size,0);
 const a=book.asks.filter(x=>x.price<=ask*1.001).reduce((n,x)=>n+x.size,0);
 const imbalance=b+a>0?(b-a)/(b+a):null;
 const retreat=w.s5.firstPrice!==null&&w.s5.lastPrice!==null&&(w.s5.lastPrice-w.s5.firstPrice)*sign<0;
 return {ready:true,reason:null,depthImbalance:imbalance,adverse:w.s15.imbalance!==null&&w.s15.imbalance*sign<=-.35&&retreat&&imbalance!==null&&imbalance*sign<=-.2};
}
/** Observation-only study: unchanged real shadow exits are the paired controls.
 * This class has no access to an engine, admission, evidence qualification or configuration setters. */
export class IntrabarProtectionStudy {
 readonly variant:'flow'|'retreat';
 readonly startedAt:number;
 get rule(){return this.variant==='flow'?INTRABAR_RULE:EARLY_PROFIT_RULE;}
 get stressRule(){return this.variant==='flow'?INTRABAR_STRESS:EARLY_PROFIT_STRESS;}
 private db:Db;private rows=new Map<string,Cohort>();
 constructor(db:Db,now=Date.now(),variant:'flow'|'retreat'='flow'){
  this.db=db;this.variant=variant;
  db.db.exec(`CREATE TABLE IF NOT EXISTS advisory_intrabar_studies(rule TEXT PRIMARY KEY,started_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS advisory_intrabar_cohort(rule TEXT NOT NULL,position_id INTEGER NOT NULL,entry_at INTEGER NOT NULL,
    status TEXT NOT NULL,payload TEXT NOT NULL,promotion_eligible INTEGER NOT NULL DEFAULT 0 CHECK(promotion_eligible=0),PRIMARY KEY(rule,position_id,entry_at));`);
  db.run('INSERT OR IGNORE INTO advisory_intrabar_studies VALUES(?,?)',this.rule,now);
  this.startedAt=db.get<{started_at:number}>('SELECT started_at FROM advisory_intrabar_studies WHERE rule=?',this.rule)!.started_at;
  // No reconstruction of missed intrabar decisions or fills across downtime.
  db.run(`UPDATE advisory_intrabar_cohort SET status='unverified',payload=json_set(payload,'$.status','unverified','$.reason','Observer restarted before continuous comparison completed')
   WHERE rule=? AND (status='watching' OR (status='triggered' AND
    (SELECT count(*) FROM advisory_exits a WHERE a.position_id=advisory_intrabar_cohort.position_id AND a.entry_at=advisory_intrabar_cohort.entry_at AND a.rule IN (?,?) AND a.status='filled')<2))`,this.rule,this.rule,this.stressRule);
 }
 private key(p:Position){return `${p.id}:${p.entryAt}`;}
 rollback(p:Position){this.rows.delete(this.key(p));}
 eligible(input:WatchInput,now:number){const p=input.position;return input.book===2&&input.scope==='shadow'&&!p.executionPlan&&!p.basket&&p.status==='open'&&p.entryAt>=this.startedAt&&p.entryAt<=now;}
 private save(c:Cohort,now:number,force=false){
  if(!force&&now-c.savedAt<10000)return;
  c.savedAt=now;
  this.db.run('INSERT INTO advisory_intrabar_cohort(rule,position_id,entry_at,status,payload) VALUES(?,?,?,?,?) ON CONFLICT(rule,position_id,entry_at) DO UPDATE SET status=excluded.status,payload=excluded.payload',this.rule,c.id,c.entryAt,c.status,JSON.stringify(c));
 }
 private enroll(input:WatchInput,now:number):Cohort{
  const p=input.position,policy=p.policy;
  let reason:string|null=!policy?.sourceHash||policy.adoptedAt!=null||policy.sim<CAUSAL_CANDLE_VERSION||tradePolicyIdFor(policy)!==policy.id?'Unverifiable current entry policy':
   now-p.entryAt>3000?'Observation started late':p.qtyOpen!==p.qty||p.fills.filter(f=>f.reason==='entry').length!==1?'Partial or multiple entry fills':
   !(p.riskAmount>0&&p.slOriginal!==null&&p.slOriginal!==p.entryPrice&&input.marketQty&&input.marketQty>0)?'Missing executable exposure':null;
  if(this.db.get("SELECT 1 FROM evidence_flags WHERE position_id=? AND entry_at=? AND status='quarantined'",p.id,p.entryAt))reason='Quarantined execution evidence';
  const e=this.db.get<{at:number;source:string;qty:number;price:number;depth:string|null}>('SELECT at,source,qty,price,depth FROM entry_fill_evidence WHERE position_id=?',p.id);
  if(!reason){
   if(!e||e.at!==p.entryAt||e.qty!==p.qty||e.price!==p.entryPrice||e.source!=='depth'||!e.depth)reason='Entry lacks exact taker depth; maker models remain separate';
   else try{
    const d=JSON.parse(e.depth),maxAge=input.config.quoteMaxAgeMs;
    // Entry and exit quantities are distinct frozen observations. In a virtual
    // shadow book, re-sizing the exit reference after the actual entry price is
    // known can differ by a contract. Replay the entry at its recorded size.
    const entryQty=d.requestedQty;
    const validEntry=Number.isSafeInteger(entryQty)&&entryQty>0&&d.side===p.side&&Number.isFinite(d.vwap)&&d.vwap>0;
    const q=validEntry?priceExit(d,p.side==='long'?'short':'long',entryQty,p.entryAt,maxAge,d.consumedQty??0):null;
    const quote=this.db.get<{bid:number|null;ask:number|null;quote_at:number|null;quote_exchange_at:number|null}>('SELECT bid,ask,quote_at,quote_exchange_at FROM entry_execution WHERE position_id=?',p.id);
    if(!q||q.error||q.qty!==entryQty||q.price===null||Math.abs(q.price-d.vwap)>Math.max(1e-9,d.vwap*1e-9))reason='Entry depth unavailable under its recorded entry quantity and frozen freshness policy';
    else if(!quote||!(quote.bid!>0&&quote.ask!>=quote.bid!)||[quote.quote_at,quote.quote_exchange_at].some(at=>at===null||at>p.entryAt||p.entryAt-at>maxAge))reason='Missing fresh entry quote needed to reproduce the current model';
    else {
     // depthPlan deliberately retains the worse of the executable quote and the
     // depth VWAP. Comparing against VWAP alone rejects conservative real entries.
     const reference=p.side==='long'?Math.max(quote.ask!,q.price):Math.min(quote.bid!,q.price);
     const expected=impactOnly(reference,p.side==='long'?'buy':'sell',input.config,reference*p.qty*p.contractValue);
     if(Math.abs(expected-p.entryPrice)>Math.max(1e-9,p.entryPrice*1e-9))reason='Saved quote/depth and frozen costs do not reproduce the entry';
    }
   }catch{reason='Malformed entry depth';}
  }
  const c:Cohort={id:p.id,entryAt:p.entryAt,scanner:p.scannerId,symbol:p.symbol,tf:p.tf,policyId:policy?.id??'unknown',sourceHash:policy?.sourceHash??'unknown',
   qty:p.qty,marketQty:input.marketQty??0,entryPrice:p.entryPrice,stop:p.slOriginal??p.entryPrice,risk:p.riskAmount,status:reason?'unverified':'watching',reason,lastAt:now,savedAt:0,peakR:null,adverseSince:null,samples:0,usable:0,quiet:0,unavailable:0};
  this.save(c,now,true);return c;
 }
 observe(input:WatchInput,flow:IntrabarFlowSnapshot,book:ExitBook|null,netR:number|null,now:number):boolean{
  if(!this.eligible(input,now))return false;
  const p=input.position,k=this.key(p);
  let c=this.rows.get(k);
  if(!c){const stored=this.db.get<{payload:string}>('SELECT payload FROM advisory_intrabar_cohort WHERE rule=? AND position_id=? AND entry_at=?',this.rule,p.id,p.entryAt);c=stored?JSON.parse(stored.payload):this.enroll(input,now);this.rows.set(k,c!);}
  c=c!;if(c.status!=='watching')return false;
  if(c.policyId!==p.policy?.id||p.policy?.adoptedAt!=null||c.qty!==p.qty||c.marketQty!==input.marketQty||c.entryPrice!==p.entryPrice||c.stop!==p.slOriginal||c.risk!==p.riskAmount||p.qtyOpen!==p.qty){c.status='unverified';c.reason='Exposure or policy changed';this.save(c,now,true);return false;}
  if(now<c.lastAt||now-c.lastAt>3000){c.status='unverified';c.reason='Observer gap exceeds three seconds';this.save(c,now,true);return false;}
  c.lastAt=now;c.samples++;
  const q=book?priceExit(book,p.side,c.marketQty,now,1000):null;
  if(netR===null||!Number.isFinite(netR)||!book||q?.error||q?.qty!==c.marketQty){c.unavailable++;c.adverseSince=null;c.reason='Fresh executable depth unavailable';this.save(c,now);return false;}
  c.peakR=Math.max(c.peakR??netR,netR);
  if(this.variant==='retreat')return this.observeRetreat(c,input,book,netR,now);
  const flowState=pressure(flow,book,p.side,now);
  if(!flowState.ready){if(flowState.reason==='insufficient recent activity')c.quiet++;else c.unavailable++;c.reason=flowState.reason;c.adverseSince=null;this.save(c,now);return false;}
  c.usable++;
  const mid=(Math.max(...book.bids.map(x=>x.price))+Math.min(...book.asks.map(x=>x.price)))/2;
  const stop=p.sl!==null&&(p.side==='long'?mid<=p.sl:mid>=p.sl);
  const liquidation=p.liqPrice!==null&&(p.side==='long'?mid<=p.liqPrice:mid>=p.liqPrice);
  // Fixed prospective hypothesis. This is deliberately not an optimization result.
  const adverse=!input.exitPending&&!stop&&!liquidation&&c.peakR>=.25&&netR>=.05&&c.peakR-netR>=.10&&flowState.adverse;
  if(!adverse)c.adverseSince=null;else c.adverseSince??=now;
  const trigger=c.adverseSince!==null&&now-c.adverseSince>=1000;
  c.reason=trigger?'Sustained adverse flow, depth and net-profit giveback':adverse?'Confirming adverse pressure':'Watching';
  if(trigger){c.status='triggered';this.db.run('INSERT OR IGNORE INTO advisory_checkpoints(position_id,entry_at,book,scope,symbol,checkpoint,at,payload) VALUES(?,?,?,?,?,?,?,?)',p.id,p.entryAt,2,'shadow',p.symbol,this.rule,now,JSON.stringify({cohort:c,flow,depth:book,netCloseR:netR,depthImbalance:flowState.depthImbalance}));}
  this.save(c,now,trigger);return trigger;
 }
 private observeRetreat(c:Cohort,input:WatchInput,book:ExitBook,netR:number,now:number){
  const p=input.position,bid=Math.max(...book.bids.map(x=>x.price)),ask=Math.min(...book.asks.map(x=>x.price));
  const spreadR=(ask-bid)*p.qty*p.contractValue/c.risk;
  const b=book.bids.filter(x=>x.price>=bid*.999).reduce((n,x)=>n+x.size,0),a=book.asks.filter(x=>x.price<=ask*1.001).reduce((n,x)=>n+x.size,0);
  const sign=p.side==='long'?1:-1,imbalance=b+a>0?(b-a)/(b+a):0,mid=(bid+ask)/2;
  const stop=p.sl!==null&&(p.side==='long'?mid<=p.sl:mid>=p.sl);
  const liquidating=p.liqPrice!==null&&(p.side==='long'?mid<=p.liqPrice:mid>=p.liqPrice);
  const bookKey=`${book.receivedAt}:${book.exchangeAt}`;
  const previous=c.retreat;
  const armed=c.peakR!==null&&c.peakR>=Math.max(.15,4*spreadR)&&c.peakR<.5;
  const retreat=armed&&c.peakR!-netR>=Math.max(.06,.35*c.peakR!,2*spreadR);
  const recovering=previous!==undefined&&netR>previous.previousR+spreadR;
  const adverse=!input.exitPending&&!stop&&!liquidating&&p.trailArmedAt==null&&!recovering&&retreat&&netR>=Math.max(.03,2*spreadR)&&imbalance*sign<=-.2;
  // A falling executable net value starts confirmation; three distinct observed
  // books and five seconds of continued pressure are required. Re-reading a book
  // cannot confirm a reversal. No aggressor flow is inferred for quiet markets.
  if(!adverse){c.adverseSince=null;c.retreat={previousR:netR,bookKey,confirmations:0};}
  else if(c.adverseSince===null){
   if(previous&&netR<previous.previousR&&bookKey!==previous.bookKey){c.adverseSince=now;c.retreat={previousR:netR,bookKey,confirmations:1};}
   else c.retreat={previousR:netR,bookKey,confirmations:0};
  }else if(bookKey!==previous?.bookKey)c.retreat={previousR:netR,bookKey,confirmations:(previous?.confirmations??0)+1};
  c.usable++;
  const trigger=c.adverseSince!==null&&now-c.adverseSince>=5000&&(c.retreat?.confirmations??0)>=3;
  c.reason=trigger?'Confirmed executable net-profit retreat below trail activation':adverse?'Confirming early net-profit retreat':'Watching net-profit protection';
  if(trigger){c.status='triggered';this.db.run('INSERT OR IGNORE INTO advisory_checkpoints(position_id,entry_at,book,scope,symbol,checkpoint,at,payload) VALUES(?,?,?,?,?,?,?,?)',p.id,p.entryAt,2,'shadow',p.symbol,this.rule,now,JSON.stringify({cohort:c,depth:book,netCloseR:netR,spreadR,depthImbalance:imbalance}));}
  this.save(c,now,trigger);return trigger;
 }
 reconcile(now:number){
  // Flush active observations before the maintenance query judges a close.
  for(const [k,c]of this.rows){this.save(c,now,true);const p=this.db.get<{status:string;entry_at:number}>('SELECT status,entry_at FROM positions WHERE id=?',c.id);if(!p||p.entry_at!==c.entryAt||p.status!=='open')this.rows.delete(k);}
  this.db.run(`INSERT OR IGNORE INTO advisory_intrabar_cohort(rule,position_id,entry_at,status,payload)
   SELECT ?,p.id,p.entry_at,'unverified',json_object('id',p.id,'entryAt',p.entry_at,'scanner',p.scanner_id,'symbol',p.symbol,'tf',p.tf,'policyId',coalesce(p.policy_id,'unknown'),'sourceHash',coalesce(t.source_hash,'unknown'),'qty',p.qty,'marketQty',0,'risk',p.risk_amount,'status','unverified','reason','No continuous prospective observations','lastAt',p.entry_at,'samples',0,'usable',0,'quiet',0,'unavailable',0)
   FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE p.bt=2 AND p.evidence_scope='shadow' AND p.status='closed' AND p.entry_at>=? AND p.entry_at>=?`,this.rule,this.startedAt,now-90*86400000);
  this.db.run(`UPDATE advisory_intrabar_cohort AS c SET status='unverified',payload=json_set(payload,'$.status','unverified','$.reason','Exposure or policy changed')
   WHERE rule=? AND status IN ('watching','triggered') AND EXISTS(SELECT 1 FROM positions p WHERE p.id=c.position_id AND p.entry_at=c.entry_at AND
   (p.qty!=json_extract(c.payload,'$.qty') OR p.entry_price!=json_extract(c.payload,'$.entryPrice') OR p.sl_original IS NOT json_extract(c.payload,'$.stop') OR p.risk_amount!=json_extract(c.payload,'$.risk') OR EXISTS(SELECT 1 FROM evidence_flags f WHERE f.position_id=p.id AND f.entry_at=p.entry_at AND f.status='quarantined') OR p.policy_id IS NOT json_extract(c.payload,'$.policyId') OR p.policy_adopted_at IS NOT NULL))`,this.rule);
  this.db.run(`UPDATE advisory_intrabar_cohort AS c SET status=CASE WHEN json_extract(payload,'$.lastAt')>=p.exit_at-3000 THEN 'unchanged' ELSE 'unverified' END,
   payload=json_set(payload,'$.status',CASE WHEN json_extract(payload,'$.lastAt')>=p.exit_at-3000 THEN 'unchanged' ELSE 'unverified' END,'$.reason',CASE WHEN json_extract(payload,'$.lastAt')>=p.exit_at-3000 THEN 'Control exit observed' ELSE 'Observation gap before actual close' END)
   FROM positions p WHERE c.rule=? AND c.status='watching' AND p.id=c.position_id AND p.entry_at=c.entry_at AND p.status='closed'`,this.rule);
  for(const [k,c] of this.rows){const stored=this.db.get<{payload:string}>('SELECT payload FROM advisory_intrabar_cohort WHERE rule=? AND position_id=? AND entry_at=?',this.rule,c.id,c.entryAt);if(stored)this.rows.set(k,JSON.parse(stored.payload));}
  this.db.run('DELETE FROM advisory_intrabar_cohort WHERE entry_at<?',now-90*86400000);
 }
 view(){
  const rows=this.db.all<{payload:string;actual_status:string|null;actual_net:number|null;exit_reason:string|null;base_status:string|null;base_net:number|null;stress_status:string|null;stress_net:number|null}>(`SELECT c.payload,p.status actual_status,p.realized_pnl-p.fees actual_net,p.exit_reason,
   a.status base_status,a.net base_net,s.status stress_status,s.net stress_net FROM advisory_intrabar_cohort c
   LEFT JOIN positions p ON p.id=c.position_id AND p.entry_at=c.entry_at
   LEFT JOIN advisory_exits a ON a.position_id=c.position_id AND a.entry_at=c.entry_at AND a.rule=?
   LEFT JOIN advisory_exits s ON s.position_id=c.position_id AND s.entry_at=c.entry_at AND s.rule=? WHERE c.rule=? ORDER BY c.entry_at DESC`,this.rule,this.stressRule,this.rule);
  const groups=new Map<string,ReturnType<typeof group>>();
  const recent: Array<{positionId:number;symbol:string;status:string;reason:string|null}>=[];
  for(const row of rows){const c:Cohort=JSON.parse(row.payload),k=`${c.scanner}:${c.symbol}:${c.tf}:${c.policyId}`;
   const g=groups.get(k)??group(c,k);groups.set(k,g);g.enrolled++;g.triggered+=Number(c.status==='triggered');
   g.samples+=c.samples;g.usable+=c.usable;g.quiet+=c.quiet;g.dataUnavailable+=c.unavailable;
   if(recent.length<30)recent.push({positionId:c.id,symbol:c.symbol,status:c.status,reason:c.reason});
   if(row.actual_status===null){g.missingActual++;continue;}if(row.actual_status!=='closed')continue;g.closed++;
   const same=c.status==='unchanged';
   if(!(c.risk>0&&c.marketQty>0)||row.actual_net===null||!(same||(c.status==='triggered'&&row.base_status==='filled'&&row.stress_status==='filled'&&row.base_net!==null&&row.stress_net!==null))){g.unavailable++;continue;}
   const before=row.actual_net,after=same?before:row.base_net!,stress=same?before:row.stress_net!,scale=c.marketQty/c.qty;
   g.covered++;g.baselineR+=before/c.risk;g.candidateR+=after/c.risk;g.stressR+=stress/c.risk;
   g.baselineNet+=before*scale;g.candidateNet+=after*scale;g.stressNet+=stress*scale;
   g.stopsBefore+=Number(row.exit_reason==='sl');g.stopsAfter+=Number(same&&row.exit_reason==='sl');
   g.losersBefore+=Number(before<0);g.losersAfter+=Number(after<0);g.stressLosers+=Number(stress<0);
   g.winnersCut+=Number(before>0&&after<before-1e-8);g.winnersLost+=Number(before>0&&after<=0);g.stressWinnersCut+=Number(before>0&&stress<before-1e-8);
   g.winnerGivebackR+=before>0?Math.max(0,before-after)/c.risk:0;
  }
  return {rule:this.rule,startedAt:this.startedAt,mode:'shadow-advisory' as const,promotionEligible:false as const,
   description:this.variant==='retreat'?'Separate prospective shadow hypothesis: before the 0.5R trail, protect a net peak of at least max(0.15R, four spreads) after max(0.06R, 35% peak, two spreads) giveback, while max(0.03R, two spreads) remains. Requires adverse 10bps depth pressure for five seconds on three distinct fresh books. Fees and funding included; no inferred flow for quiet markets. Same delayed/stressed fills and unavailable-data rules. Not promotion evidence.':'Future ordinary shadow trades with entries verified against their saved quote, depth and frozen execution policy. Protect a net peak ≥0.25R after ≥0.10R giveback, while ≥0.05R remains, only with sustained adverse 15s flow, 5s price retreat and fresh 10bps depth pressure. Exit depth must be under one second old. Base delay matches the entry policy; stress adds 3s and 5bps. Quiet/unknown data abstains. Net dollars are normalized to frozen executable size, not account cash. No paper activation or promotion evidence.',
   groups:[...groups.values()].map(g=>({...g,deltaR:g.candidateR-g.baselineR,stressDeltaR:g.stressR-g.baselineR})),recent};
 }
}
function group(c:Cohort,key:string){return {key,scanner:c.scanner,symbol:c.symbol,tf:c.tf,policyId:c.policyId,sourceHash:c.sourceHash,enrolled:0,closed:0,covered:0,unavailable:0,missingActual:0,triggered:0,
 samples:0,usable:0,quiet:0,dataUnavailable:0,baselineR:0,candidateR:0,stressR:0,baselineNet:0,candidateNet:0,stressNet:0,
 stopsBefore:0,stopsAfter:0,losersBefore:0,losersAfter:0,stressLosers:0,winnersCut:0,winnersLost:0,stressWinnersCut:0,winnerGivebackR:0};}
