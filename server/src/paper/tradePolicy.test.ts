import test from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from './engine.ts';
import {evidenceCoverage} from './tradePolicy.ts';

const T=Date.now();
function fixture(t:any,margin=false){
 const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);
 Object.assign(cfg.paper,{initialEquity:1000,slippageBps:0,quotedSlippageBps:0,feeRatePct:0,makerFeeRatePct:0,
  feeTaxPct:0,liquidation:false,latencyMs:0,fillSource:'candles',useSpread:false,requireQuote:false,
  minRiskFeeRatio:0,maxSignalAgeSec:0,skipScriptStops:false,limitEntry:undefined,
  floorAtR:0,trailAfterR:0,trailGiveBackPct:0,trailSteps:[],trailStall:undefined,
  sizingMode:margin?'margin':'risk',marginPerTrade:150,maxStopLossPct:3,
  marginLeverage:{base:5,strong:5,weak:5,minTrades:20,lookback:30,strongAboveR:1,weakBelowR:-1}});
 cfg.scanners.s={enabled:true,symbols:['BTCUSD'],timeframes:['1h'],exitMode:'both'};
 const engine=new PaperEngine(db,()=>cfg);engine.sourceHashFor=()=> 'source-a';
 const event={kind:'entry' as const,side:'long' as const,price:100,sl:99,tp:[101,102,103],label:'entry',message:'',source:'alert' as const,barTime:T-3600000,barIndex:0};
 const ctx={scannerId:'s',scannerName:'s',symbol:'BTCUSD',tf:'1h',market:{tickSize:.01,contractValue:1},atr:1,refPrice:100,at:T,signalId:null,exitMode:'both' as const};
 return {db,cfg,engine,event,ctx};
}

test('ordinary trades keep fee, trail and exit policy through configuration changes and restart',t=>{
 const {db,cfg,engine,event,ctx}=fixture(t);
 const p=engine.onEntry(event,ctx).position!;assert.ok(p.policy);const id=p.policy.id;
 cfg.paper.feeRatePct=10;cfg.paper.trailAfterR=.1;cfg.paper.trailGiveBackPct=5;cfg.scanners.s.exitMode='levels';
 const restored=new PaperEngine(db,()=>cfg);const loaded=restored.position(p.id)!;
 assert.equal(loaded.policy!.id,id);assert.equal(loaded.policy!.paper.feeRatePct,0);
 restored.onScriptExit('s','BTCUSD','1h','close',undefined,T+1000,'levels');
 assert.equal(restored.trades()[0].exitReason,'script_exit');assert.equal(restored.trades()[0].fees,0);
 assert.notEqual(restored.policyForCell(ctx).id,id);
});

test('pending maker orders preserve accepted settings and sizing through restart',t=>{
 const {db,cfg,engine,event,ctx}=fixture(t,true);
 cfg.paper.fillSource='tape';cfg.paper.limitEntry={enabled:true,books:['account'],tfs:['1h'],atr:.2,bars:2};
 const d=engine.onEntry(event,ctx);assert.equal(d.action,'pending');const pe=engine.pendingEntries()[0];
 const qty=pe.reservation!.qty,id=pe.policy!.id;
 cfg.paper.marginPerTrade=900;cfg.paper.feeRatePct=10;cfg.paper.fallbackAtrSl=10;
 const restored=new PaperEngine(db,()=>cfg);
 restored.onTrade('BTCUSD',99.7,100,T+1000,T+1000);
 const p=restored.openPositions()[0];assert.ok(p);assert.equal(p.policy!.id,id);
 assert.equal(p.qty,qty);assert.equal(p.slOriginal,99);assert.equal(p.fills[0].fee,0);
});

test('margin for unfilled orders is reserved, survives restart and releases on cancellation',t=>{
 const {db,cfg,engine,event,ctx}=fixture(t,true);cfg.paper.initialEquity=200;
 cfg.paper.limitEntry={enabled:true,books:['account'],tfs:['1h'],atr:.2,bars:2};
 assert.equal(engine.onEntry(event,ctx).action,'pending');
 const other={...ctx,scannerId:'other',symbol:'ETHUSD'};
 engine.onEntry(event,other);
 const held=engine.pendingEntries().reduce((n,p)=>n+(p.reservation?.margin??0),0);
 assert.ok(held<=200,`reserved ${held}`);
 const restored=new PaperEngine(db,()=>cfg);
 assert.equal(restored.pendingEntries().reduce((n,p)=>n+(p.reservation?.margin??0),0),held);
 for(const pe of restored.pendingEntries())restored.cancelPending(pe.id,'test cancellation');
 assert.equal(restored.onEntry(event,other).action,'pending');
 assert.equal(restored.pendingEntries()[0].reservation!.qty,engine.pendingEntries()[0].reservation!.qty);
});

test('behavior identity ignores allocation and presentation but changes with actual source or exits',t=>{
 const {cfg,engine,ctx}=fixture(t);const a=engine.policyForCell(ctx);
 assert.equal(engine.policyForCell({...ctx,at:T+500,refPrice:200} as typeof ctx).id,a.id);
 cfg.scanners.s.enabled=false;cfg.scanners.s.hidden=true;cfg.scanners.s.symbols=['ETHUSD'];
 cfg.scanners.s.pairs=[{symbol:'SOLUSD',tf:'15m'}];
 assert.equal(engine.policyForCell(ctx).id,a.id);
 cfg.paper.floorAtR=.5;cfg.paper.floorKeepR=.2;
 assert.notEqual(engine.policyForCell(ctx).id,a.id);
 assert.notEqual(engine.policyForCell(ctx).strategyId,a.strategyId);
 const b=engine.policyForCell(ctx);engine.sourceHashFor=()=> 'source-b';
 assert.notEqual(engine.policyForCell(ctx).strategyId,b.strategyId);
});

test('legacy adoption is explicit and cannot be counted as matching qualification evidence',t=>{
 const {db,cfg,engine,event,ctx}=fixture(t);const p=engine.onEntry(event,ctx).position!;
 db.run('UPDATE positions SET policy_id=NULL WHERE id=?',p.id);
 const restored=new PaperEngine(db,()=>cfg);restored.sourceHashFor=()=> 'source-a';
 assert.equal(restored.adoptLegacyPolicies(T+5),1);assert.equal(restored.adoptLegacyPolicies(T+6),0);
 restored.closeManual(p.id,'manual',T+10);
 const v=evidenceCoverage(db,ctx,0,restored.policyForCell(ctx).strategyId,T+20);
 assert.equal(v.legacy,1);assert.equal(v.matching,0);
});

test('coverage separates matching, changed and quarantined policies without rewriting history',t=>{
 const {db,cfg,engine,event,ctx}=fixture(t);
 const a=engine.onEntry(event,ctx).position!;engine.closeManual(a.id,'manual',T+1);
 cfg.paper.floorAtR=.5;cfg.paper.floorKeepR=.1;
 const b=engine.onEntry(event,{...ctx,at:T+2}).position!;engine.closeManual(b.id,'manual',T+3);
 const id=engine.policyForCell(ctx).strategyId;
 assert.deepEqual(evidenceCoverage(db,ctx,0,id,T+4),{total:2,matching:1,changed:1,legacy:0,quarantined:0,excluded:0});
 db.run("INSERT INTO evidence_flags VALUES(?,?,'quarantined','test','test',?)",b.id,b.entryAt,T+4);
 assert.deepEqual(evidenceCoverage(db,ctx,0,id,T+5),{total:2,matching:0,changed:1,legacy:0,quarantined:1,excluded:0});
});
