import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {IncubatorStore} from './store.ts';
import {evaluate,approve,recordScreen,type ScreenResult} from './cycle.ts';
import {copyRecoveryRefusal} from './copyRecovery.ts';
import {ShadowRunner} from './shadow.ts';

const DAY=86400000,NOW=Date.UTC(2026,10,15,12);
const screen:ScreenResult={pass:true,at:NOW,trades:40,profitFactor:2,netPnl:20,netAtStress:10,windowsUp:6,winRatePct:70,avgR:.3,bars:4000,days:42,fill:'close'};
function setup(t:any){
 const db=new Db(':memory:');t.after(()=>db.db.close());const store=new IncubatorStore(db),cfg=structuredClone(DEFAULT_CONFIG);
 cfg.incubator.enabled=true;cfg.incubator.gate.pool='pair';cfg.incubator.maxShadow=1;cfg.incubator.admit.reserve=[];cfg.incubator.admit.rotation={enabled:false,maxPerDay:12,idleDaysByTf:{},cooldownDays:3};
 const cell={scannerId:'bad',symbol:'ETHUSD',tf:'15m'};
 const quarantine=()=>db.run("INSERT OR REPLACE INTO script_health(scanner_id,last_at,reason,quarantined) VALUES('bad',?,'confirmed repaint',1)",NOW);
 return {db,store,cfg,cell,quarantine};
}

test('quarantined formal cells release capacity to screened candidates even when the library says runnable',t=>{
 const f=setup(t),before=structuredClone(f.cfg);
 f.store.move(f.cell,'shadow','test',null,null,NOW-DAY);f.quarantine();
 const candidate={scannerId:'good',symbol:'BTCUSD',tf:'15m'};
 recordScreen(f.store,candidate,screen,f.cfg.incubator,NOW);
 const result=evaluate(f.store,f.cfg,NOW,{unavailable:()=>null});
 assert.equal(result.retired.length,1);assert.match(result.retired[0],/bad/);
 assert.equal(f.store.find('bad','ETHUSD','15m')!.stage,'retired');
 assert.equal(f.store.find('good','BTCUSD','15m')!.stage,'shadow');
 assert.equal(result.admitted.length,1);assert.equal(f.store.counts().live,undefined);
 assert.deepEqual(f.cfg,before);assert.equal(f.db.get<any>('SELECT count(*) n FROM positions')!.n,0);
});

test('quarantine never removes held paper/shadow allocations or a watch subscription',t=>{
 const f=setup(t);f.quarantine();
 for(const [symbol,book,status] of [['ETHUSD',0,'open'],['SOLUSD',2,'pending']] as const){
  f.store.move({...f.cell,symbol},'shadow','test',null,null,NOW-100*DAY);
  f.db.run("INSERT INTO positions(status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at,bt) VALUES(?,'bad','Bad',?,'15m','long',1,1,1,100,?,?)",status,symbol,NOW-1000,book);
 }
 f.store.move({...f.cell,symbol:'XRPUSD'},'tracked','tracker',null,'tracker:watch',NOW-DAY);
 const result=evaluate(f.store,f.cfg,NOW,{unavailable:()=>null});
 assert.equal(result.retired.length,0);
 assert.equal(f.store.find('bad','ETHUSD','15m')!.stage,'shadow');
 assert.equal(f.store.find('bad','SOLUSD','15m')!.stage,'shadow');
 assert.equal(f.store.find('bad','XRPUSD','15m')!.stage,'tracked');
 assert.equal(f.db.get<any>('SELECT count(*) n FROM positions')!.n,2);
});

test('quarantine blocks promotion and both immediate and delayed paper copy, including allocated cells',t=>{
 const f=setup(t);f.quarantine();
 const row=f.store.move(f.cell,'proposed','test',null,null,NOW-DAY);
 assert.throws(()=>approve(f.store,f.cfg,row.id,'test',()=>assert.fail('must not allocate'),NOW),/quarantined/);
 assert.match(f.store.copyRefusal(f.cell,f.cfg.incubator.mirror,1e9,NOW,{readOnly:true})!,/quarantined/);
 assert.match(f.store.copyRefusal(f.cell,f.cfg.incubator.mirror,1e9,NOW)!,/quarantined/);
 f.store.move(f.cell,'live','test',null,null,NOW);
 assert.match(copyRecoveryRefusal(f.store,{enabled:true},f.cell,NOW)!,/quarantined/);
 f.db.run("UPDATE script_health SET quarantined=0 WHERE scanner_id='bad'");
 assert.equal(copyRecoveryRefusal(f.store,{enabled:true},f.cell,NOW),null);
 assert.equal(f.db.get<any>('SELECT count(*) n FROM evidence_restorations')!.n,0);
});

test('copy readiness and runtime both wait for missing turnover without altering evidence-only enrollment rules',t=>{
 const f=setup(t),m={enabled:true,minTrades:0,minTurnoverUsd:2e6};
 for(const readOnly of [true,false]){
  for(const missing of [null,NaN,Infinity])assert.match(f.store.copyRefusal(f.cell,m,missing,NOW,{readOnly})!,/market data unavailable/);
  assert.equal(f.store.copyRefusal(f.cell,m,3e6,NOW,{readOnly}),null);
  assert.match(f.store.copyRefusal(f.cell,m,1e6,NOW,{readOnly})!,/thin market/);
  assert.equal(f.store.copyRefusal(f.cell,{...m,minTurnoverUsd:0},null,NOW,{readOnly}),null);
 }
 assert.equal(f.db.get<any>('SELECT count(*) n FROM evidence_restorations')!.n,0);
});

function runtime(t:any,held:boolean){
 const f=setup(t);t.mock.timers.enable({apis:['Date'],now:NOW+1000});
 const row=f.store.move(f.cell,'shadow','test',null,null,NOW-DAY);
 f.cfg.incubator.mirror={enabled:true};f.cfg.paper.trendGate!.enabled=false;f.cfg.risk.regime.enabled=false;
 const last=NOW-900000,bars=Array.from({length:80},(_,i)=>({time:last-(79-i)*900000,open:100,high:102,low:98,close:100,volume:100}));
 let runs=0,during=()=>{};const mirrored:string[]=[],exits:string[]=[],comparisons:string[]=[];
 const paper:any=new EventEmitter();Object.assign(paper,{openPositions:()=>held?[{scannerId:'bad',symbol:'ETHUSD',tf:'15m'}]:[],pendingEntries:()=>[],findOpen:()=>undefined,mark:()=>100,recordGatedEntry:()=>{},onEntry:()=>assert.fail('quarantined entry'),onScriptExit:()=>exits.push('exit')});
 const runner:any=new ShadowRunner({store:f.store,cfgRef:()=>f.cfg,paper,candles:{get:()=>bars},registry:{get:()=>({id:'bad',name:'Bad',patched:'alert("x")',status:'ok'})},
  pool:{run:async()=>{runs++;during();return {ok:true,alerts:[{type:'alert',message:'LONG | Price: 100',barIndex:79,time:last},{type:'alert',message:'🛑 SL HIT | Long | Entry: 100 | SL: 95',barIndex:79,time:last}],shapes:[],labels:[],plots:[],ms:1};}},
  marketInfo:async()=>({tickSize:.01,contractValue:1}),accountHolds:()=>held,mirror:(_s:any,_m:any,_tf:any,event:any)=>mirrored.push(event.kind),compare:(x:any)=>comparisons.push(x.event.kind)} as any);
 t.after(()=>runner.stop());
 return {...f,runner,row,mirrored,exits,comparisons,runs:()=>runs,during:(fn:()=>void)=>{during=fn;}};
}

test('an unheld quarantined scanner is not sent to Pine at all',async t=>{
 const f=runtime(t,false);f.quarantine();await f.runner.run(f.row,NOW,false,NOW+1000);
 assert.equal(f.runs(),0);assert.equal(f.store.shadowScanActivity(f.row)?.status,'unavailable');
});
for(const queued of [false,true])test(`held exits survive quarantine ${queued?'during the worker run':'before scanning'} without new mirrored or shadow entries`,async t=>{
 const f=runtime(t,true);if(queued)f.during(f.quarantine);else f.quarantine();
 await f.runner.run(f.row,NOW,false,NOW+1000);
 assert.equal(f.runs(),1);assert.deepEqual(f.mirrored,['exit']);assert.deepEqual(f.exits,['exit']);assert.deepEqual(f.comparisons,['exit']);
 assert.equal(f.store.shadowScanActivity(f.row)?.entry_signals,0);
});

test('unheld quarantine is classified before scarce dispatch slots, and clearing it permits a fresh scan',async t=>{
 const f=runtime(t,false);f.quarantine();f.cfg.incubator.mirror!.enabled=false;
 Object.assign(f.runner.deps.pool,{size:8,reserved:2,stats:{queuedLive:1,queuedMirror:0},rssReader:()=>0,memoryGuardBytes:1});
 f.runner.pairs=[f.row];const before=structuredClone(f.cfg);
 f.runner.onBarClosed('ETHUSD','15m',NOW);
 for(let i=0;i<3;i++)await new Promise<void>(r=>setImmediate(r));
 assert.equal(f.runner.dispatchStats.offered,0,'unrunnable work cannot consume the research queue');
 assert.equal(f.runner.dispatchStats.pending,0);
 assert.equal(f.runner.dispatchStats.expired,0);
 assert.equal(f.store.shadowScanActivity(f.row)?.status,'unavailable');
 assert.match(f.store.shadowScanActivity(f.row)?.reason??'',/scanner quarantined: confirmed repaint/);
 assert.equal(f.runner.scheduledBars.has('bad:ETHUSD:15m'),false,'the rejected scheduling claim is released');
 assert.equal(f.runs(),0);
 f.db.run("UPDATE script_health SET quarantined=0 WHERE scanner_id='bad'");
 f.runner.onBarClosed('ETHUSD','15m',NOW);
 for(let i=0;i<3;i++)await new Promise<void>(r=>setImmediate(r));
 assert.equal(f.runner.dispatchStats.offered,1,'clearing quarantine is still respected on the current fresh close');
 assert.equal(f.runner.dispatchStats.pending,1);
 assert.deepEqual(f.cfg,before);assert.equal(f.db.get<any>('SELECT count(*) n FROM positions')!.n,0);
 t.mock.timers.tick(300_000);f.runner.dispatch.drain();
 assert.equal(f.runner.dispatchStats.expired,1,'the original signal-age deadline is unchanged for runnable work');
});

for(const kind of ['account','shadow-open','shadow-pending','plan-pending','rotation'] as const){
 test(`quarantine dispatch still preserves ${kind} exposure`,async t=>{
  const f=runtime(t,kind==='account');f.quarantine();
  Object.assign(f.runner.deps.pool,{size:8,reserved:2,stats:{queuedLive:1,queuedMirror:0},rssReader:()=>0,memoryGuardBytes:1});
  const source={scannerId:'bad',symbol:'ETHUSD',tf:'15m'};
  if(kind==='shadow-open')f.runner.deps.paper.openPositions=()=>[source];
  if(kind==='shadow-pending')f.runner.deps.paper.pendingEntries=()=>[source];
  if(kind==='plan-pending')f.runner.deps.paper.pendingEntries=()=>[{...source,scannerId:'plan:experiment',executionPlan:{sourceScannerId:'bad'}}];
  if(kind==='rotation')f.store.rotationHolds=()=>true;
  const launched:Array<{id:string;live:boolean}>=[];
  f.runner.runScheduled=async(r:any,_at:number,live:boolean)=>{launched.push({id:r.scannerId,live});};
  f.runner.pairs=[f.row];f.runner.onBarClosed('ETHUSD','15m',NOW);
  for(let i=0;i<3;i++)await new Promise<void>(r=>setImmediate(r));
  if(kind==='account'||kind==='shadow-open')assert.deepEqual(launched,[{id:'bad',live:true}],'held exits retain the urgent lane');
  else assert.equal(f.runner.dispatchStats.pending,1,'resting and rotation-held work remains schedulable');
  assert.notEqual(f.store.shadowScanActivity(f.row)?.status,'unavailable');
  assert.equal(f.db.get<any>('SELECT count(*) n FROM evidence_restorations')!.n,0);
 });
}
