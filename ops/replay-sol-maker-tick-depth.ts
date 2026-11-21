/** Offline diagnostic only: conditional on the original accepted SOL orders, not portfolio/promotion evidence. */
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {createGunzip} from 'node:zlib';import {createInterface} from 'node:readline';
import {Db} from '../server/src/db.ts';
import {PaperEngine} from '../server/src/paper/engine.ts';
import {DEFAULT_CONFIG} from '../server/src/config.ts';
import {DepthRecorder} from '../server/src/execution/depthRecorder.ts';
import {MarkStore} from '../server/src/data/marks.ts';
import {planSnapshot,planScannerId} from '../server/src/paper/executionPlans.ts';
import {SOL_MAKER_TICK_REFERENCE,SOL_MAKER_SCANNER} from '../server/src/research/solMakerStudy.ts';
import {OpenTradeMonitor} from '../server/src/research/openTradeMonitor.ts';
import {makeTrial,fundingDue} from './lib/sol-maker-baseline.ts';
const [inputDir,outFile]=process.argv.slice(2);if(!inputDir||!outFile)throw Error('Usage: node ops/replay-sol-maker-tick-depth.ts <capture-directory> <output.json>');
const manifest=JSON.parse(fs.readFileSync(path.join(inputDir,'manifest.json'),'utf8'));
const bytes=fs.readFileSync(path.join(inputDir,'events.ndjson.gz'));
const digest=createHash('sha256').update(bytes).digest('hex');
if(!manifest.eventsSha256||manifest.eventsSha256!==digest)throw Error('Capture hash missing or mismatched');
const exported=fs.readFileSync(path.join(inputDir,'export.json'));
if(manifest.exportSha256!==createHash('sha256').update(exported).digest('hex'))throw Error('Journal export hash missing or mismatched');
const x=JSON.parse(exported.toString());
if(x.mode!=='paper'||x.allowProduction||!x.configUnchangedDuringRead)throw Error('Expected read-only paper export');
const db=new Db(':memory:'),depth=new DepthRecorder(db,['SOLUSD'],()=>{},false),marks=new MarkStore();
let now=0;const candidates:any[]=[],baselines:any[]=[];
for(const row of x.positions){
 if(row.symbol!=='SOLUSD'||row.tf!=='15m'||row.status!=='closed'||!(row.scanner_id===SOL_MAKER_SCANNER||row.scanner_id.startsWith('plan:sol-maker-half-stop-reference:v1:')))throw Error('Input includes a non-SOL-maker reference');
 const extra=JSON.parse(row.fills),origPlan=extra.executionPlan,origPolicy=x.policies.find((p:any)=>p.id===row.policy_id);
 const policy=origPolicy?JSON.parse(origPolicy.snapshot):null,paper=structuredClone(policy?.paper??origPlan.paper);
 const trace=JSON.parse(x.traces.find((t:any)=>t.position_id===row.id).snapshot),limit=JSON.parse(x.entryObservations.find((o:any)=>o.position_id===row.id).limit_observation);
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.paper=paper;cfg.executionPlans=[{...SOL_MAKER_TICK_REFERENCE,enabled:true}];cfg.scanners[SOL_MAKER_SCANNER]=policy?.reading??origPlan.reading;
 let snap=planSnapshot(cfg,cfg.executionPlans[0],policy?.sourceHash??origPlan.sourceHash);snap={...snap,paper}; // preserve original fees and exits, including original offer clock; never rewrite history.
 // Offline frozen-order identities must never masquerade as deployed plan evidence.
 snap.signature=createHash('sha256').update(JSON.stringify({kind:'offline-frozen-order',snapshot:snap})).digest('hex').slice(0,12);
 const scannerId=planScannerId(snap),store=new Db(':memory:');now=limit.placedAt;
 const pe:any={id:row.id,executionPlan:snap,scannerId,scannerName:row.scanner_name,symbol:row.symbol,tf:row.tf,side:row.side,
  signalPrice:trace.reference,levels:{sl:row.sl_original,tp:JSON.parse(row.tp),source:row.levels_source},market:trace.market,at:now,dueAt:now+paper.latencyMs,signalId:null,mlProb:null,leverageMult:1,sizeScale:trace.sizeScale,
  reservation:{qty:row.qty,notional:row.qty*row.entry_price*row.contract_value,margin:row.qty*row.entry_price*row.contract_value/(extra.marginLeverage??5),riskAmount:row.risk_amount},
  limit:{price:row.entry_price,expiresAt:limit.expiresAt,atr:trace.atr,sl:trace.scannerStop??undefined,tp:trace.scannerTargets,bars:(limit.expiresAt-now)/900000}};
 const pending={...row,status:'pending',bt:2,qty:0,qty_open:0,scanner_id:scannerId,entry_at:now,exit_at:null,exit_price:null,exit_reason:null,policy_id:null,signal_id:null,realized_pnl:0,fees:0,fills:JSON.stringify({limitEntry:pe})};const keys=Object.keys(pending);
 store.run(`INSERT INTO positions(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,...keys.map(k=>pending[k]));
 const engine=new PaperEngine(store,()=>cfg,{book:2,now:()=>now});engine.causalExits=true;engine.quotes=marks;engine.makerFillBook=(s,a)=>depth.bookAt(s,a,1000);
 const monitor=new OpenTradeMonitor(store,now-1);
 const c:any={row,limit,pe,engine,store,monitor,market:null,events:0,books:0,arrivalAt:null,firstFreshBookAt:null,crossingWithoutBook:0,issues:[],cancelled:[],samples:0};
 engine.on('pending',(e:any)=>{if(e.type==='cancelled')c.cancelled.push(e);});candidates.push(c);
 try{baselines.push(makeTrial(row,policy??{sim:211,id:'synthetic-reference',strategyId:'reference',sourceHash:origPlan.sourceHash,paper:origPlan.paper},x.execution.find((e:any)=>e.position_id===row.id),'current'));}catch(e){c.issues.push('Baseline: '+String(e));}
}
function baseEvent(e:any){for(const b of baselines)b.observe(e);}
const exact=x.reports.map((r:any)=>({at:r.at,symbol:'SOLUSD',kind:'depth',payload:JSON.parse(r.depth)})).sort((a:any,b:any)=>a.at-b.at);let cursor=0,n=0,last=0,regressions=0;
for await(const line of createInterface({input:fs.createReadStream(path.join(inputDir,'events.ndjson.gz')).pipe(createGunzip()),crlfDelay:Infinity})){
 const e=JSON.parse(line);now=e.receivedAt;n++;if(now<last)throw Error('Replay arrival order regressed; refusing to reconstruct future fills');last=now;
 while(cursor<exact.length&&exact[cursor].at<now)baseEvent(exact[cursor++]);
 if(e.kind==='gap'){baseEvent({at:now,symbol:e.symbol,kind:e.source==='advisory-depth'?'depthGap':'globalGap',payload:e.payload});if(e.symbol==='*'||e.source==='advisory-depth')depth.disconnect(now);if(e.source!=='advisory-depth')marks.invalidateQuotes();}
 if(e.kind==='quote_gap')marks.invalidateQuotes();
 if(e.source==='execution-feed'&&e.kind==='quote')marks.onWsQuote(e.payload);
 if(e.source==='execution-feed'&&e.kind==='mark'){const q=e.payload;marks.setQuotes(e.symbol,q.bestBid??null,q.bestAsk??null,now,q.timeMs,'mark');}
 if(e.source==='advisory-depth'&&['snapshot','checkpoint','update'].includes(e.kind))depth.onDepth(e.payload,now);
 const book=depth.bookAt('SOLUSD',now,1000),isDepth=e.source==='advisory-depth'&&['snapshot','checkpoint','update'].includes(e.kind);
 if(e.source==='execution-feed'&&['trade','mark'].includes(e.kind))baseEvent({at:now,symbol:e.symbol,kind:e.kind,payload:e.payload});
 if(['paper_bar','paper_closed_minute'].includes(e.kind))baseEvent({at:now,symbol:e.symbol,kind:e.kind,payload:e.payload});
 if(isDepth&&book)baseEvent({at:now,symbol:'SOLUSD',kind:'depth',payload:book});
 for(const c of candidates){
  if(now<c.limit.placedAt||now>c.row.exit_at+120000)continue;c.events++;
  const engine=c.engine;engine.housekeeping(now);const held=engine.position(c.row.id);if(held?.status==='open')fundingDue(held,c.row,now);
  if(isDepth&&book){c.books++;if(now>=c.pe.dueAt)c.firstFreshBookAt??=now;engine.observeMakerBook('SOLUSD',book,now);c.arrivalAt??=engine.pendingEntries()[0]?.makerArrival?.at??null;engine.settleExits('SOLUSD',book,now);c.monitor.settle('SOLUSD',book,now,()=>engine.position(c.row.id));}
  if(e.kind==='trade'&&e.source==='execution-feed'){
   const t=e.payload;if(engine.pendingEntries().length&&!book&&(c.row.side==='long'?t.price<c.row.entry_price:t.price>c.row.entry_price))c.crossingWithoutBook++;
   engine.onTrade('SOLUSD',t.price,t.qty,t.timeMs,now,t.id);
  }
  if(e.kind==='mark'&&e.source==='execution-feed')engine.onMarkPrice('SOLUSD',e.payload.markPrice,e.payload.timeMs);
  if(e.kind==='paper_bar')engine.onBar('SOLUSD',e.payload.bar,now,{historical:e.payload.historical});
  if(e.kind==='study_market_sample')c.market=e.payload;
  if(e.kind==='observer_gap')c.store.run("UPDATE advisory_scanner_exit_cohort SET status='unverified',reason='Recorded observer gap' WHERE status IN ('watching','triggered')");
  if(e.kind==='study_position_sample'&&e.payload.positionId===c.row.id){
   const p=engine.position(c.row.id);if(p?.status==='open'){c.samples++;c.monitor.observe([{position:p,book:2,scope:'experiment',...engine.advisoryObservation(p)}],new Map(c.market?[['SOLUSD',c.market]]:[]),()=>null,now);}
  }
  if(e.kind==='study_exit_book')c.monitor.settle('SOLUSD',e.payload.book,now,()=>engine.position(c.row.id));
 }
}
while(cursor<exact.length)baseEvent(exact[cursor++]);
const results=candidates.map(c=>{
 const held=c.engine.position(c.row.id),p=held&&held.status!=='pending'?held:null,reports=c.store.all('SELECT at,qty,market_qty,evidence FROM paper_maker_reports ORDER BY at');c.monitor.resolve(now);
 return {id:c.row.id,book:c.row.bt,actualNet:c.row.realized_pnl-c.row.fees,actualReason:c.row.exit_reason,actualEntryAt:c.row.entry_at,
  modeledEntryAt:p?.entryAt,entryDelayMs:p?p.entryAt-c.row.entry_at:null,modeledQty:p?.qty,targetQty:c.row.qty,entryReports:reports.map((r:any)=>({at:r.at,qty:r.qty,eventAt:JSON.parse(r.evidence).limit.eventAt,depthAt:JSON.parse(r.evidence).limit.fillDepth.receivedAt})),
  status:p?.status??'unfilled',net:p?.status==='closed'?p.realizedPnl-p.fees:null,reason:p?.exitReason,fees:p?.fees,exitAt:p?.exitAt,netDelta:p?.status==='closed'?p.realizedPnl-p.fees-(c.row.realized_pnl-c.row.fees):null,
  events:c.events,depthObservations:c.books,arrivalAt:c.arrivalAt,firstFreshBookAt:c.firstFreshBookAt,arrivalCoverageDelayMs:c.firstFreshBookAt===null?null:c.firstFreshBookAt-c.pe.dueAt,crossingWithoutBook:c.crossingWithoutBook,cancelled:c.cancelled,samples:c.samples,
  cohort:c.store.all('SELECT status,reason FROM advisory_scanner_exit_cohort'),trials:c.store.all("SELECT rule,status,net,actual_net,delta,error FROM advisory_exits WHERE rule LIKE 'scanner-half-stop%'"),issues:c.issues};
});
fs.writeFileSync(outFile,JSON.stringify({at:Date.now(),eventsSha256:digest,exportSha256:manifest.exportSha256,events:n,regressions,mode:'historical diagnostic; advisory depth proxy; closed-order selection; NOT deployment proof',
 limitations:['No original execution-depth stream retained; recorded advisory book is an explicit proxy.','Queue position unknown. A crossing print is a quantity ceiling, not an exchange fill.','Only originally filled closed orders have frozen sizes; rejected/expired order opportunity cost not reconstructed.','Half-stop uses recorded observer opportunities; absent/late observations are excluded.','No new risk, margin, promotion or account config is written.'],baseline:baselines.map(b=>b.result()),results},null,2));
for(const c of candidates)c.store.db.close();for(const b of baselines)b.db.db.close();db.db.close();
