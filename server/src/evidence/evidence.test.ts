import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from '../paper/engine.ts';
import {IncubatorStore} from '../incubator/store.ts';
import {ShadowRunner} from '../incubator/shadow.ts';
import {mirrorRefusal} from '../incubator/gate.ts';
import {saveTradePolicy} from '../paper/tradePolicy.ts';
import {qualifiedEvidence,evidenceCoverage} from './trades.ts';
import {recordGatedSignal,gatedSignalPage} from './gatedSignals.ts';

const cell={scannerId:'s',symbol:'BTCUSD',tf:'15m'};
const event={kind:'entry' as const,side:'long' as const,barTime:1,barIndex:0,price:100,sl:99,tp:[102],label:'LONG',message:'',source:'alert' as const};
function fixture(t:any,file=':memory:') {
  const db=new Db(file);t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);
  cfg.paper.skipScriptStops=true;cfg.paper.marginPerTrade=150;cfg.paper.maxStopLossPct=3;
  cfg.paper.marginLeverage={base:5,strong:10,weak:5,minTrades:5,lookback:30,strongAboveR:.05,weakBelowR:-.05};
  const paper=new PaperEngine(db,()=>cfg);paper.sourceHashFor=()=> 'source';
  const store=new IncubatorStore(db);store.policyFor=c=>paper.policyForCell(c);
  const policy=paper.policyForCell(cell);saveTradePolicy(db,policy);
  let time=10;
  const add=(extra:Record<string,any>={})=>{
    const row={status:'closed',scanner_id:'s',scanner_name:'s',symbol:'BTCUSD',tf:'15m',side:'long',qty:1,qty_open:0,
      contract_value:1,entry_price:100,entry_at:time++,exit_at:time++,risk_amount:1,realized_pnl:.3,fees:.1,
      levels_source:'atr-fallback',bt:2,policy_id:policy.id,...extra};
    return Number(db.run(`INSERT INTO positions(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`,...Object.values(row)).lastInsertRowid);
  };
  return {db,cfg,paper,store,policy,add};
}

test('copy, promotion and sizing consume the same compatible net outcomes, not legacy/tracker/experiment/future rows',t=>{
  const {db,cfg,paper,store,policy,add}=fixture(t),before=JSON.stringify(cfg);
  const expected=Array.from({length:5},()=>add());
  add({policy_id:null});add({policy_adopted_at:1});add({evidence_scope:'tracker'});add({evidence_scope:'legacy-tracker'});
  add({evidence_scope:'experiment'});add({levels_source:'script'});add({bt:1});add({status:'open'});
  add({risk_amount:0});add({realized_pnl:Infinity});add({entry_at:300,exit_at:200});add({exit_at:2000});
  const changed={...policy,id:'changed',strategyId:'changed'};saveTradePolicy(db,changed);add({policy_id:changed.id});
  const flagged=add();const at=db.get<any>('SELECT entry_at FROM positions WHERE id=?',flagged).entry_at;
  db.run("INSERT INTO evidence_flags VALUES(?,?,'quarantined','bad fill','test',1000)",flagged,at);
  const qualified=qualifiedEvidence(db,cell,policy,{at:1000});
  assert.deepEqual(qualified.map(t=>t.positionId),expected);
  assert.deepEqual(store.qualifiedTrades('s','BTCUSD','15m',2,1000),qualified);
  assert.equal(mirrorRefusal({minTrades:5,minNetR:0},qualified,null),null);
  const sizing=paper.cellLeverage({...cell,at:1000},cfg.paper);
  assert.equal(sizing.n,5);assert.equal(sizing.leverage,10);assert.ok(Math.abs(sizing.avgR!-.2)<1e-9);
  assert.equal(evidenceCoverage(db,cell,2,policy,1000).matching,5);
  assert.equal(JSON.stringify(cfg),before,'evidence selection cannot rewrite margin or caps');
  db.run("UPDATE evidence_flags SET entry_at=? WHERE position_id=?",at-1,flagged);
  assert.equal(qualifiedEvidence(db,cell,policy,{at:1000}).length,6,'old reused position flags must not leak');
  assert.equal(qualifiedEvidence(db,cell,undefined).length,0);
  assert.equal(qualifiedEvidence(db,{...cell,symbol:'ETHUSD'},policy).length,0);
  assert.equal(qualifiedEvidence(db,cell,policy,{book:-3}).length,0);
});

test('sizing takes the newest qualified closes with deterministic ties and a changed policy falls back to base',t=>{
  const {cfg,paper,store,add,db,policy}=fixture(t);
  add({exit_at:100,realized_pnl:-3});const a=add({exit_at:200}),b=add({exit_at:200});
  add({exit_at:300,evidence_scope:'tracker',realized_pnl:20});
  assert.deepEqual(qualifiedEvidence(db,cell,policy,{at:500,limit:2}).map(x=>x.positionId),[a,b]);
  cfg.paper.marginLeverage!.lookback=2;
  assert.equal(paper.cellLeverage({...cell,at:500},cfg.paper).n,2);
  paper.sourceHashFor=()=> 'new-source';
  assert.deepEqual(paper.cellLeverage({...cell,at:500},cfg.paper),{leverage:5,avgR:null,n:0});
  assert.equal(store.qualifiedTrades('s','BTCUSD','15m',2,500).length,0);
  assert.equal(paper.cellLeverage({...cell,at:500,policy},cfg.paper).n,2,'accepted orders use their bound strategy when sized again');
});

test('diagnostic ledger survives restart, deduplicates, paginates and cannot enter qualification or change account P&L',t=>{
  const dir=mkdtempSync(join(tmpdir(),'vnedge-evidence-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const {db,store,policy,add}=fixture(t,join(dir,'test.db'));add();
  const observation={...cell,book:2,at:1000,event,stage:'admission' as const,reason:'choppy',policyId:policy.id,sourceHash:'source',snapshot:{atr:1}};
  recordGatedSignal(db,observation);recordGatedSignal(db,{...observation,at:2000,reason:'later reason'});
  const second=new Db(join(dir,'test.db'));t.after(()=>second.db.close());
  recordGatedSignal(second,observation);recordGatedSignal(second,{...observation,book:0,stage:'copy'});
  assert.equal(second.get<any>('SELECT count(*) n FROM gated_signals').n,2);
  assert.equal(store.qualifiedTrades('s','BTCUSD','15m',2,5000).length,1);
  assert.equal(second.get<any>('SELECT count(*) n FROM positions').n,1);
  assert.throws(()=>db.run('UPDATE gated_signals SET promotion_eligible=1'),/CHECK/);
  const page=gatedSignalPage(db,new URLSearchParams('since=0&limit=1'));
  assert.equal(page.promotionEligible,false);assert.ok(page.nextBefore);
  const older=gatedSignalPage(db,new URLSearchParams(`since=0&before=${page.nextBefore}`));
  assert.equal(older.rows.length,1);assert.equal(older.rows[0].reason,'choppy');
  assert.equal(older.rows[0].snapshot.outcome,'not-executed');
  assert.equal(gatedSignalPage(db,new URLSearchParams('since=0&book=paper')).rows.length,1);
  assert.equal(gatedSignalPage(db,new URLSearchParams("since=0&symbol=' OR 1=1--")).rows.length,0);
  assert.throws(()=>db.transaction(()=>{recordGatedSignal(db,{...observation,event:{...event,barTime:99}});throw Error('rollback');}),/rollback/);
  assert.equal(db.get<any>('SELECT count(*) n FROM gated_signals').n,2);
});

test('paper and shadow engine rejections retain costs, source and event context without creating positions',t=>{
  const {db,cfg,paper,store}=fixture(t);cfg.paper.requireQuote=true;cfg.paper.useSpread=true;cfg.paper.maxSignalAgeSec=0;
  const ctx={...cell,scannerName:'s',market:{tickSize:.01,contractValue:1},refPrice:100,atr:1,at:Date.now(),signalId:null,exitMode:'both' as const};
  const shadow=new PaperEngine(db,()=>cfg,{book:2});shadow.sourceHashFor=()=> 'source';
  for(const engine of [paper,shadow]){
    engine.quotes={executable:()=>null};assert.equal(engine.onEntry(event,ctx).action,'rejected');
    engine.onEntry(event,ctx);
  }
  const rows=gatedSignalPage(db,new URLSearchParams('since=0')).rows;
  assert.equal(rows.length,2);assert.ok(rows.every(r=>r.stage==='execution'&&r.reason.includes('unpriceable')));
  assert.equal(rows[0].snapshot.fees.taxPct,cfg.paper.feeTaxPct);assert.equal(rows[0].snapshot.event.barTime,1);
  assert.equal(rows[0].source_hash,'source');assert.ok(rows[0].policy_id);
  assert.equal(store.qualifiedTrades('s','BTCUSD','15m',2).length,0);
  assert.equal(paper.openPositions().length+shadow.openPositions().length,0);
});

for(const maker of [false,true])test(`unfilled ${maker?'maker':'latency'} entries retain diagnostic context through restart`,t=>{
  const {db,cfg,paper,store}=fixture(t);
  Object.assign(cfg.paper,{maxSignalAgeSec:0,useSpread:false,requireQuote:false,minRiskFeeRatio:0,fillSource:'tape',latencyMs:1500});
  if(maker)cfg.paper.limitEntry={enabled:true,books:['account'],tfs:['15m'],atr:.1,bars:2};
  const at=Date.now(),ev={...event,sl:undefined,tp:[],barTime:at-900000};
  const ctx={...cell,scannerName:'s',market:{tickSize:.01,contractValue:1},refPrice:100,atr:1,at,signalId:null,exitMode:'both' as const};
  const d=paper.onEntry(ev,ctx);assert.equal(d.action,'pending',d.reason);
  assert.equal(gatedSignalPage(db,new URLSearchParams('since=0')).rows.length,0,'accepted pending orders are not gated observations');
  const restored=new PaperEngine(db,()=>cfg);
  if(maker){assert.equal(restored.pendingEntries().length,1);restored.cancelPending(d.pendingId!,'risk changed before fill');}
  const rows=gatedSignalPage(db,new URLSearchParams('since=0')).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].stage,'pending');assert.equal(rows[0].snapshot.event.barTime,ev.barTime);
  assert.equal(rows[0].snapshot.signalAt,at);assert.equal(rows[0].snapshot.atr,1);
  assert.equal(store.qualifiedTrades('s','BTCUSD','15m',2).length,0);
  assert.equal(db.get<any>('SELECT count(*) n FROM orders').n,0);
});

test('real shadow dispatch holds legacy-only copy evidence, records regime gates and copies after compatible closes',async t=>{
  const {db,cfg,paper,store,add}=fixture(t);cfg.incubator.enabled=true;
  cfg.incubator.mirror={enabled:true,minTrades:5,minNetR:0,minTurnoverUsd:0};
  cfg.risk.regime={enabled:true,minAtrPct:.3,minEr:1,noWeekend:false,exempt:[]};
  cfg.paper.trendGate={enabled:false,emaLen:50,tf:'',mode:'follow'};
  for(let i=0;i<5;i++)add({policy_id:null});
  const pair=store.move(cell,'shadow','test'),H=900000,last=Math.floor(Date.now()/H)*H-H;
  const bars=Array.from({length:80},(_,i)=>({time:last-(79-i)*H,open:100,high:101,low:99,close:100+(i%2),volume:100}));
  const shadow=new PaperEngine(db,()=>cfg,{book:2});shadow.sourceHashFor=()=> 'source';
  const forwarded:string[]=[];
  const runner=new ShadowRunner({store,cfgRef:()=>cfg,paper:shadow,candles:{get:()=>bars},
    registry:{get:()=>({id:'s',name:'s',status:'ok',patched:'alert("x")'})},
    pool:{run:async()=>({ok:true,alerts:[{type:'alert',time:last,barIndex:79,message:'🟢 LONG | Price: 100'}],shapes:[],labels:[],plots:[],ms:1})},
    marketInfo:async()=>({tickSize:.01,contractValue:1}),mirror:async()=>{forwarded.push('entry');}} as any) as any;
  t.after(()=>runner.stop());
  await runner.run(pair,Date.now(),false,Date.now());
  assert.equal(forwarded.length,0,'raw five-win record cannot copy');
  let rows=gatedSignalPage(db,new URLSearchParams('since=0')).rows;
  assert.deepEqual(rows.map(r=>r.stage).sort(),['admission','copy']);
  assert.ok(rows.every(r=>r.promotion_eligible===0));
  for(let i=0;i<5;i++)add({policy_id:paper.policyForCell(cell).id});
  // The compatible policy is current, including the regime used above.
  saveTradePolicy(db,paper.policyForCell(cell));
  runner.seen.clear();runner.marks={window:()=>({since:0,tailBars:3}),advance:()=>{}};
  await runner.run(pair,Date.now(),false,Date.now());
  assert.equal(forwarded.length,1,'compatible record unlocks copying without weakening thresholds');
  rows=gatedSignalPage(db,new URLSearchParams('since=0')).rows;assert.equal(rows.length,2,'repeated observation stays idempotent');
});
