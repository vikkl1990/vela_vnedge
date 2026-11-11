import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {resolveTradePolicy,saveTradePolicy} from '../paper/tradePolicy.ts';
import {PaperEngine} from '../paper/engine.ts';
import {IncubatorStore} from '../incubator/store.ts';
import {approve,evaluate,admitOnly} from '../incubator/cycle.ts';
import {readEvidence,qualifiedEvidence} from './trades.ts';
import {recordGatedSignal} from './gatedSignals.ts';

const cell={scannerId:'s',symbol:'BTCUSD',tf:'15m'},DAY=86400_000,T=100*DAY;
function setup(t:any,file=':memory:') {
 const db=new Db(file);t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);
 cfg.paper.skipScriptStops=false;cfg.paper.marginPerTrade=150;cfg.paper.maxStopLossPct=3;
 cfg.paper.marginLeverage={base:5,strong:10,weak:5,minTrades:20,lookback:30,strongAboveR:.05,weakBelowR:-.05};
 cfg.incubator.mirror={enabled:true,minTrades:5,minNetR:0,minTurnoverUsd:2e6};
 Object.assign(cfg.incubator.gate,{pool:'pair',minTrades:30,minDays:14,minPfR:1.2,minAvgR:.1,minT:2,minWeeks:3});
 cfg.incubator.gate.minTradesByTf={'1h':20,'4h':12};cfg.incubator.gate.minDaysByTf={'1h':28,'4h':45};
 cfg.risk.marketGate!.enabled=false;
 cfg.paper.scalperOffer={enabled:true,majors:['BTCUSD','ETHUSD'],majorsMinutes:30,othersMinutes:15,excluded:[]};
 const old=resolveTradePolicy(cfg,cell,'source');saveTradePolicy(db,old);
 cfg.paper.scalperOffer.verification={source:'delta-india-trading-preferences',accountHash:'a'.repeat(64),connectionRevision:'test',verifiedAt:T-10*DAY,effectiveFrom:T-10*DAY};
 let policy=resolveTradePolicy(cfg,cell,'source');saveTradePolicy(db,policy);
 const store=new IncubatorStore(db);store.policyFor=()=>policy;store.evidenceConfig=()=>cfg;
 const pair=store.move(cell,'shadow','screen',null,null,T-30*DAY);
 const add=(at:number,r=.5,options:any={})=>{
  const {policyId=policy.id,...overrides}=options;
  const row={scanner_id:'s',scanner_name:'s',symbol:'BTCUSD',tf:'15m',side:'long',status:'closed',bt:2,
   qty:10,qty_open:0,entry_price:100,entry_at:at,exit_at:at+1000,contract_value:1,risk_amount:10,
   realized_pnl:r*10+1.18,fees:1.18,policy_id:policyId,evidence_scope:'shadow',
   fills:JSON.stringify([{at,price:100,qty:10,reason:'entry',fee:.59,liquidity:'taker'},
    {at:at+1000,price:100,qty:10,reason:'trail',fee:.59,liquidity:'taker'}]),...overrides};
  return Number(db.run(`INSERT INTO positions(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`,...Object.values(row)).lastInsertRowid);
 };
 for(let i=0;i<5;i++)add(T-20*DAY+i*10000,.5,{policyId:old.id});
 const enroll=()=>store.startRestorations(T);
 const forward=(n=30,r=.5)=>Array.from({length:n},(_,i)=>add(T+DAY+(12*DAY*i/n),r));
 return {db,cfg,store,old,get policy(){return policy;},setPolicy:(p:typeof policy)=>{policy=p;saveTradePolicy(db,p);},pair,add,enroll,forward};
}

test('enrollment freezes a forward clock and requirements, preserves money/settings and holds all qualification channels',t=>{
 const f=setup(t),before=JSON.stringify(f.cfg),positions=f.db.all('SELECT * FROM positions');f.enroll();
 const row=f.db.get<any>('SELECT * FROM evidence_restorations');assert.equal(row.started_at,T);
 assert.equal(JSON.parse(row.requirements).gate.minTrades,30);
 assert.equal(f.store.restoration(cell,T+DAY)?.passed,false);
 assert.equal(f.store.qualifiedTrades('s','BTCUSD','15m',2,T+DAY).length,0);
 assert.match(f.store.copyRefusal(cell,f.cfg.incubator.mirror,1e8,T+DAY)!,/forward shadow evaluation/);
 const paper=new PaperEngine(f.db,()=>f.cfg);paper.sourceHashFor=()=> 'source';
 assert.deepEqual(paper.cellLeverage({...cell,at:T+DAY},f.cfg.paper),{leverage:5,avgR:null,n:0});
 assert.equal(JSON.stringify(f.cfg),before);assert.deepEqual(f.db.all('SELECT * FROM positions'),positions);
 f.cfg.incubator.gate.minTrades=1;f.store.startRestorations(T+DAY);
 assert.equal(f.db.get<any>('SELECT requirements FROM evidence_restorations').requirements,row.requirements);
 assert.throws(()=>f.db.run('UPDATE evidence_restorations SET started_at=?',T-DAY),/immutable/);
});
test('timely forward collection requires a current enrolled shadow policy and never qualifies a cell',t=>{
 const f=setup(t);assert.equal(f.store.forwardCollectionKeys(T).size,0);f.enroll();
 const frozen=f.db.all('SELECT * FROM evidence_restorations');
 assert.equal(f.store.forwardCollectionKeys(T-1).size,0);
 assert.deepEqual([...f.store.forwardCollectionKeys(T)],['s:BTCUSD:15m']);
 assert.match(f.store.copyRefusal(cell,f.cfg.incubator.mirror,1e8,T+DAY)!,/forward shadow evaluation/);
 assert.equal(f.store.qualifiedTrades('s','BTCUSD','15m',2,T+DAY).length,0);
 const original=f.policy;f.setPolicy({...original,strategyId:'changed'});
 assert.equal(f.store.forwardCollectionKeys(T+DAY).size,0);f.setPolicy(original);
 f.store.move(cell,'tracked','test');assert.equal(f.store.forwardCollectionKeys(T+DAY).size,0);
 f.store.move(cell,'live','test');assert.equal(f.store.forwardCollectionKeys(T+DAY).size,0);
 assert.deepEqual(f.db.all('SELECT * FROM evidence_restorations'),frozen);
});
test('restored forward collection is not retired by incompatible historical losses or an old failed screen',t=>{
 t.mock.timers.enable({apis:['Date'],now:T+DAY});
 const f=setup(t);f.cfg.incubator.maxShadow=100;f.cfg.incubator.admit.rotation!.enabled=false;
 for(let i=0;i<21;i++)f.add(T-5*DAY+i*1000,-1,{policyId:null});
 f.db.run('UPDATE incubator_pairs SET screen=? WHERE id=?',JSON.stringify({pass:true,at:T-40*DAY,avgR:.34}),f.pair.id);
 f.enroll();f.add(T+1000,-1);f.add(T+3000,-1);
 evaluate(f.store,f.cfg,T+DAY);
 assert.equal(f.store.get(f.pair.id)!.stage,'shadow','two forward losses cannot become 28 qualified closes');
 assert.equal(f.store.get(f.pair.id)!.gate.stats.trades,2);
 assert.match(f.store.copyRefusal(cell,f.cfg.incubator.mirror,1e8,T+DAY)!,/forward shadow evaluation/);
 f.db.run('UPDATE incubator_pairs SET screen=? WHERE id=?',JSON.stringify({pass:false,at:T-DAY,avgR:-.1}),f.pair.id);
 evaluate(f.store,f.cfg,T+DAY);assert.equal(f.store.get(f.pair.id)!.stage,'shadow','pre-enrollment failed screen cannot end the new window');
});
test('restoration inactivity starts at enrollment and a full failing forward sample still retires',t=>{
 t.mock.timers.enable({apis:['Date'],now:T+DAY});const f=setup(t);f.cfg.incubator.admit.rotation!.enabled=false;
 f.db.run('UPDATE incubator_pairs SET since=? WHERE id=?',T-100*DAY,f.pair.id);f.enroll();
 evaluate(f.store,f.cfg,T+DAY);assert.equal(f.store.get(f.pair.id)!.stage,'shadow');
 for(let i=0;i<30;i++)f.add(T+1000+i*2000,-1);
 evaluate(f.store,f.cfg,T+DAY);assert.equal(f.store.get(f.pair.id)!.stage,'retired','unchanged full-sample failure threshold is enforced');
 assert.equal(f.store.qualifiedTrades('s','BTCUSD','15m',2,T+DAY).length,0);
});

test('the forward clock survives process restart without counting prior or still-open trades',t=>{
 const dir=mkdtempSync(join(tmpdir(),'vnedge-restoration-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const f=setup(t,join(dir,'db'));f.add(T-1000,.5);f.enroll();f.forward(5);f.add(T+DAY,100,{status:'open'});
 const second=new Db(join(dir,'db'));t.after(()=>second.db.close());
 const store=new IncubatorStore(second);store.policyFor=()=>f.policy;store.evidenceConfig=()=>f.cfg;store.startRestorations(T+15*DAY);
 const r=store.restoration(cell,T+15*DAY)!;assert.equal(r.startedAt,T);assert.equal(r.stats?.trades,5);assert.equal(r.passed,false);
 assert.equal(store.qualifiedTrades('s','BTCUSD','15m',2,T+15*DAY).length,0,'five new wins cannot bypass the forward hold');
});

test('a passing forward record unlocks the same conservative evidence for copy, promotion and sizing; later losses revoke it',t=>{
 const f=setup(t);f.enroll();f.forward();const at=T+15*DAY;
 assert.equal(f.store.restoration(cell,at)?.passed,true);
 const rows=f.store.qualifiedTrades('s','BTCUSD','15m',2,at);assert.equal(rows.length,35);
 assert.equal(rows.reduce((n,r)=>n+r.r,0),17.5,'historical fees and losses remain as recorded');
 assert.equal(f.store.copyRefusal(cell,f.cfg.incubator.mirror,1e8,at),null);
 const paper=new PaperEngine(f.db,()=>f.cfg);paper.sourceHashFor=()=> 'source';
 assert.equal(paper.cellLeverage({...cell,at},f.cfg.paper).n,30);
 assert.equal(paper.cellLeverage({...cell,at},f.cfg.paper).leverage,10);
 f.add(at+1000,-100);
 assert.equal(f.store.restoration(cell,at+5000)?.passed,false);
 assert.equal(qualifiedEvidence(f.db,cell,f.policy,{at:at+5000}).length,0);
 assert.equal(paper.cellLeverage({...cell,at:at+5000},f.cfg.paper).leverage,5);
});

test('age, sample size, profitability, both halves and cost stress are independent requirements',t=>{
 const f=setup(t);f.enroll();f.forward();
 assert.equal(f.store.restoration(cell,T+13*DAY)?.passed,false,'too young');
 f.db.run('UPDATE positions SET realized_pnl=? WHERE entry_at>=?',1.18+.0999*10,T);
 let r=f.store.restoration(cell,T+15*DAY)!;assert.equal(r.passed,false,'minimum R is not rounded up');
 f.db.run('UPDATE positions SET risk_amount=1,realized_pnl=? WHERE entry_at>=?',1.18+.2,T);
 r=f.store.restoration(cell,T+15*DAY)!;assert.ok(r.stressedR!<0);assert.equal(r.passed,false);
 f.db.run('UPDATE positions SET risk_amount=10,realized_pnl=? WHERE entry_at>=?',1.18+5,T);
 f.db.run('UPDATE positions SET realized_pnl=? WHERE entry_at>=?',1.18-2,T+8*DAY);
 r=f.store.restoration(cell,T+15*DAY)!;assert.ok(r.reasons.some(x=>x.includes('both forward')));
});

test('invalid fill proof blocks the verdict rather than discarding an outcome; quarantined, tracker and gated observations never count',t=>{
 const f=setup(t);f.enroll();const ids=f.forward();
 f.add(T+DAY,100,{evidence_scope:'tracker'});f.add(T+DAY,100,{evidence_scope:'experiment'});f.add(T+DAY,100,{policyId:null});
 recordGatedSignal(f.db,{...cell,book:2,at:T+DAY,stage:'admission',reason:'regime',snapshot:{},event:{kind:'entry',side:'long',barTime:T+DAY,barIndex:0,price:100,sl:99,tp:[],label:'long',message:'',source:'alert'}});
 f.db.run('UPDATE positions SET fills=? WHERE id=?','[]',ids[0]);
 let r=f.store.restoration(cell,T+15*DAY)!;assert.equal(r.stats?.trades,30);assert.equal(r.invalidFills,1);assert.equal(r.passed,false);
 f.db.run("INSERT INTO evidence_flags VALUES(?,?,'quarantined','test','test',?)",ids[0],T+DAY,T+15*DAY);
 r=f.store.restoration(cell,T+15*DAY)!;assert.equal(r.stats?.trades,29);assert.equal(r.invalidFills,0);assert.equal(r.passed,false);
});

test('source changes cannot reuse a pass, and must enroll a fresh window',t=>{
 const f=setup(t);f.enroll();f.forward();assert.equal(f.store.restoration(cell,T+15*DAY)?.passed,true);
 const changed=resolveTradePolicy(f.cfg,cell,'new source');f.setPolicy(changed);
 assert.equal(f.store.restoration(cell,T+15*DAY)?.state,'policy-changed');
 assert.equal(qualifiedEvidence(f.db,cell,changed,{at:T+15*DAY}).length,0);
 f.store.qualifiedTrades('s','BTCUSD','15m',2,T+15*DAY);
 const r=f.store.restoration(cell,T+15*DAY)!;assert.equal(r.startedAt,T+15*DAY);assert.equal(r.stats?.trades,0);
 assert.equal(f.db.get<any>('SELECT count(*) n FROM evidence_restorations').n,2);
});

test('current exact-qualified cells retain their existing eligibility',t=>{
 const f=setup(t);for(let i=0;i<5;i++)f.add(T-50000+i*1000,.5);
 f.store.startRestorations(T);assert.equal(f.db.get<any>('SELECT count(*) n FROM evidence_restorations').n,0,'current exact-qualified path retained');
 assert.equal(qualifiedEvidence(f.db,cell,f.policy,{at:T}).length,5);
});

test('allocated or merely tracked cells are not enrolled for restoration',t=>{
 const f=setup(t);f.store.move(cell,'live','config');f.enroll();assert.equal(f.db.get<any>('SELECT count(*) n FROM evidence_restorations').n,0);
 f.store.move(cell,'tracked','tracker');f.enroll();assert.equal(f.db.get<any>('SELECT count(*) n FROM evidence_restorations').n,0);
});

test('pending restoration blocks stale/cohort proposals even if copy thresholds are disabled',t=>{
 const f=setup(t);f.enroll();f.cfg.incubator.mirror={enabled:true,minTrades:0};
 assert.match(f.store.copyRefusal(cell,f.cfg.incubator.mirror,1e8,T+DAY)!,/forward shadow/);
 f.store.move(cell,'proposed','gate');f.cfg.incubator.gate.pool='cohort';
 assert.throws(()=>approve(f.store,f.cfg,f.pair.id,'test',()=>{throw Error('must not allocate');},T+15*DAY),/forward shadow/);
});

test('future closes and pre-enrollment entries are excluded from the forward gate but remain in the journal',t=>{
 const f=setup(t);f.enroll();f.forward();f.add(T-10000,100,{exit_at:T+DAY});f.add(T+DAY,100,{exit_at:T+16*DAY});
 const at=T+15*DAY;f.add(at-1000,100);
 const r=f.store.restoration(cell,at)!;assert.equal(r.stats?.trades,30);assert.equal(r.stats?.netR,15);
 assert.equal(readEvidence(f.db,cell,f.policy,{at}).length,32);
});

for(const [tf,n,days] of [['1h',20,28],['4h',20,45]] as const)test(`${tf} freezes its own timeframe requirements`,t=>{
 const f=setup(t);f.db.run('UPDATE incubator_pairs SET tf=?',tf);f.db.run('UPDATE positions SET tf=?',tf);
 const c={...cell,tf},old=structuredClone(f.cfg);delete old.paper.scalperOffer!.verification;
 const oldPolicy=resolveTradePolicy(old,c,'source'),current=resolveTradePolicy(f.cfg,c,'source');saveTradePolicy(f.db,oldPolicy);saveTradePolicy(f.db,current);
 f.db.run('UPDATE positions SET policy_id=?',oldPolicy.id);f.setPolicy(current);f.store.startRestorations(T);
 const r=f.store.restoration(c,T+DAY)!;assert.equal(r.requirements?.minTrades,n);assert.equal(r.requirements?.minDays,days);
});

test('enrollment and its holds do not leak into historical as-of evaluations',t=>{
 const f=setup(t);f.enroll();f.add(T-5000,.5);
 assert.equal(f.store.restoration(cell,T-1),null);
 assert.equal(qualifiedEvidence(f.db,cell,f.policy,{at:T-1}).length,1);
 assert.equal(qualifiedEvidence(f.db,cell,f.policy,{at:T+1}).length,0);
});

test('actual shadow dispatch records the restoration hold, continues shadow evaluation and copies only after a forward pass',async t=>{
 t.mock.timers.enable({apis:['Date'],now:T+15*DAY});
 const {ShadowRunner}=await import('../incubator/shadow.ts');
 const f=setup(t);f.cfg.incubator.enabled=true;f.enroll();
 const H=900000,last=Math.floor(Date.now()/H)*H-H;
 const bars=Array.from({length:80},(_,i)=>({time:last-(79-i)*H,open:100,high:101,low:99,close:100+(i%2),volume:100}));
 const shadow=new PaperEngine(f.db,()=>f.cfg,{book:2});shadow.sourceHashFor=()=> 'source';
 const forwarded:string[]=[];
 const runner=new ShadowRunner({store:f.store,cfgRef:()=>f.cfg,paper:shadow,candles:{get:()=>bars},
   registry:{get:()=>({id:'s',name:'s',status:'ok',patched:'alert("x")'})},
   pool:{run:async()=>({ok:true,alerts:[{type:'alert',time:last,barIndex:79,message:'🟢 LONG | Price: 100'}],shapes:[],labels:[],plots:[],ms:1})},
   marketInfo:async()=>({tickSize:.01,contractValue:1}),mirror:async()=>{forwarded.push('entry');}}as any)as any;
 try {
  await runner.run(f.store.get(f.pair.id),Date.now(),false,Date.now());
  assert.equal(forwarded.length,0);
  const held=f.db.get<any>("SELECT reason FROM gated_signals WHERE stage='copy'");assert.match(held.reason,/forward shadow evaluation/);
  f.forward();runner.seen.clear();runner.marks={window:()=>({since:0,tailBars:3}),advance:()=>{}};
  await runner.run(f.store.get(f.pair.id),Date.now(),false,Date.now());
  assert.equal(forwarded.length,1);
 }finally{runner.stop();}
});

for(const pool of ['pair','cohort'] as const)test(`${pool}: current forward losses stay visible and active orders defer retirement`,t=>{
 t.mock.timers.enable({apis:['Date'],now:T+DAY});const f=setup(t);f.cfg.incubator.gate.pool=pool;f.cfg.incubator.admit.rotation!.enabled=false;
 f.enroll();f.add(T+1000,-1);evaluate(f.store,f.cfg,T+DAY);
 assert.equal(f.store.get(f.pair.id)!.stage,'shadow');assert.equal(f.store.get(f.pair.id)!.gate.stats.trades,1);
 assert.equal(f.store.get(f.pair.id)!.gate.stats.netR,-1);
 for(let i=0;i<29;i++)f.add(T+5000+i*2000,-1);
 const held=f.add(T+90000,0,{status:'pending'});evaluate(f.store,f.cfg,T+DAY);
 assert.equal(f.store.get(f.pair.id)!.stage,'shadow');assert.match(f.store.get(f.pair.id)!.gate.reasons[0],/retirement deferred/);
 f.db.run('DELETE FROM positions WHERE id=?',held);evaluate(f.store,f.cfg,T+DAY);
 assert.equal(f.store.get(f.pair.id)!.stage,'retired');
});
test('only a post-enrollment failed screen with three current losses can retire the new test',t=>{
 const f=setup(t);f.cfg.incubator.admit.rotation!.enabled=false;f.enroll();
 for(let i=0;i<3;i++)f.add(T+1000+i*2000,-1);
 f.db.run('UPDATE incubator_pairs SET screen=? WHERE id=?',JSON.stringify({pass:false,at:T-DAY}),f.pair.id);
 evaluate(f.store,f.cfg,T+DAY);assert.equal(f.store.get(f.pair.id)!.stage,'shadow');
 f.db.run('UPDATE incubator_pairs SET screen=? WHERE id=?',JSON.stringify({pass:false,at:T+10000}),f.pair.id);
 evaluate(f.store,f.cfg,T+DAY);assert.equal(f.store.get(f.pair.id)!.stage,'retired');
});
test('idle rotation gives a new forward window its existing inactivity allowance',t=>{
 const f=setup(t);f.cfg.incubator.maxShadow=1;f.cfg.incubator.admit.reserve=[];
 f.cfg.incubator.admit.rotation={enabled:true,maxPerDay:1,idleDaysByTf:{'15m':7},cooldownDays:3};
 const next=f.store.move({scannerId:'next',symbol:'ETHUSD',tf:'15m'},'candidate','test',null,null,T-DAY);
 f.db.run('UPDATE incubator_pairs SET screen=? WHERE id=?',JSON.stringify({pass:true,at:T,trades:40,profitFactor:2,avgR:.2,days:20,fill:'close'}),next.id);
 f.store.setLiveMarks({'s:BTCUSD:15m':T+DAY-900000});f.enroll();
 assert.deepEqual(admitOnly(f.store,f.cfg,T+DAY),[]);assert.equal(f.store.get(f.pair.id)!.stage,'shadow');
 assert.equal(f.store.evaluationSince(f.store.get(f.pair.id)!,T+DAY),T);
 f.store.setLiveMarks({'s:BTCUSD:15m':T+8*DAY-900000});
 assert.deepEqual(admitOnly(f.store,f.cfg,T+8*DAY),['next ETHUSD 15m']);
});
