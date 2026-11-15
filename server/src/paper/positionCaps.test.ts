import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DEFAULT_CONFIG,validateConfig} from '../config.ts';
import {Db} from '../db.ts';
import {PaperEngine} from './engine.ts';
import {RiskManager} from '../risk/manager.ts';
import {resolveTradePolicy,saveTradePolicy} from './tradePolicy.ts';
import {removeAccountPositionCaps} from '../../../ops/remove-account-position-caps.ts';
const T=1800000000000;
function fixture(t:{after:(fn:()=>void)=>void},margin=50){
 const cfg=structuredClone(DEFAULT_CONFIG),db=new Db(':memory:');t.after(()=>db.db.close());let now=T;
 Object.assign(cfg.paper,{initialEquity:1000,maxOpenPositions:0,sizingMode:'margin',marginPerTrade:margin,maxStopLossPct:3,fillSource:'tape',latencyMs:100,slippageBps:0,feeRatePct:0,makerFeeRatePct:0,liquidation:false,maxSignalAgeSec:0,useSpread:false,requireQuote:false,minRiskFeeRatio:0,skipScriptStops:false,limitEntry:{...cfg.paper.limitEntry,enabled:false},marginLeverage:{base:5,strong:5,weak:5,strongAboveR:.05,weakBelowR:-.05,minTrades:20,lookback:30}});
 Object.assign(cfg.risk,{maxPositionsTotal:0,maxPositionsPerSymbol:1,perScannerMaxPositions:4,reentryCooldownMinutes:0,burstWindowSec:0,regime:{...cfg.risk.regime,enabled:false}});
 let engine:PaperEngine,risk:RiskManager;
 const restart=()=>{engine=new PaperEngine(db,()=>cfg,{now:()=>now});risk=new RiskManager({db,paper:engine,candles:null,cfgRef:()=>cfg,now:()=>now});engine.risk=risk;};restart();
 const queue=(i:number,extra:Record<string,unknown>={})=>engine.onEntry({kind:'entry',side:'long',price:100,sl:98,tp:[104,106,108],label:'entry',message:'',source:'alert',barTime:0,barIndex:0},{scannerId:`s${Math.floor(i/4)}`,scannerName:'test',symbol:`PAIR${i}USD`,tf:'1h',market:{tickSize:.01,contractValue:.01},refPrice:100,at:now,signalId:null,exitMode:'both',atr:1,...extra});
 const fill=(i:number,price=100)=>{now+=200;engine.onTrade(`PAIR${i}USD`,price,1e6,now,now,`fill-${i}-${now}`);};
 return {cfg,db,queue,fill,restart,engine:()=>engine,risk:()=>risk};
}

test('zero account ceilings admit and fill more than eight with sufficient margin, including after restart',t=>{
 const f=fixture(t);
 for(let i=0;i<9;i++)assert.equal(f.queue(i).action,'pending');
 assert.equal(f.risk().state().positions.max,null);
 for(let i=0;i<9;i++)f.fill(i);f.restart();
 assert.equal(f.engine().openPositions().length,9);assert.equal(f.engine().pendingEntries().length,0);
 assert.ok(f.engine().openPositions().every(p=>p.riskAmount<=30));
 assert.match(f.queue(0,{scannerId:'other'}).reason!,/max 1 positions on PAIR0USD/);
 assert.match(f.queue(10,{scannerId:'s0'}).reason!,/scanner at its 4-position budget/);
 f.risk().kill('test halt',false);assert.match(f.queue(10).reason!,/manual halt/);
});

test('count-free admission still reserves pending margin and refuses an unfunded extra entry',t=>{
 const f=fixture(t,150);let accepted=0,last='';
 for(let i=0;i<30;i++){const d=f.queue(i);if(d.action==='pending')accepted++;else{last=d.reason??'';break;}}
 assert.ok(accepted>0&&accepted<9);assert.doesNotMatch(last,/max open positions|max positions/);assert.match(last,/margin|size|leverage/i);
 const reserved=f.engine().pendingEntries().reduce((s,p)=>s+(p.reservation?.margin??0),0);assert.ok(reserved<=1000);
 for(let i=0;i<accepted;i++)f.fill(i);f.restart();
 assert.ok(f.engine().openPositions().reduce((s,p)=>s+p.qtyOpen*p.entryPrice*p.contractValue/p.marginLeverage!,0)<=1000);
});

test('finite engine ceilings still count reservations; older pending orders obey current capacity at fill',t=>{
 const f=fixture(t);f.cfg.paper.maxOpenPositions=1;
 assert.equal(f.queue(0).action,'pending');assert.match(f.queue(1).reason!,/max open positions \(1\)/);
 const frozen=resolveTradePolicy(f.cfg,{scannerId:'s0',symbol:'PAIR1USD',tf:'1h'},'source');saveTradePolicy(f.db,frozen);
 f.cfg.paper.maxOpenPositions=0;
 assert.equal(f.queue(1,{policy:frozen}).action,'pending');f.fill(0);f.fill(1);
 assert.equal(f.engine().openPositions().length,2,'old count cap is not a frozen execution rule');
 f.cfg.paper.maxOpenPositions=3;assert.equal(f.queue(2).action,'pending');f.cfg.paper.maxOpenPositions=1;f.fill(2);
 assert.equal(f.engine().openPositions().length,2,'lowering a finite live cap refuses new fills without closing held trades');
});

test('zero caps do not strand maker orders and the unchanged risk halt is rechecked at fill',t=>{
 const f=fixture(t);Object.assign(f.cfg.paper,{limitEntry:{enabled:true,tfs:['1h'],books:['account'],atr:1,bars:3},limitFill:'through'});
 assert.equal(f.queue(0).action,'pending');f.restart();f.fill(0,98.99);assert.equal(f.engine().openPositions().length,1);
 assert.equal(f.queue(1).action,'pending');f.risk().kill('after placement',false);f.fill(1,98.99);
 assert.equal(f.engine().openPositions().length,1);assert.equal(f.engine().pendingEntries().length,0);
});

test('account cap migration changes only the two reviewed counts, preserves evidence identities and validates integers',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'position-caps-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json'),cfg=structuredClone(DEFAULT_CONFIG);cfg.paper.maxOpenPositions=8;cfg.risk.maxPositionsTotal=8;
 const cell={scannerId:'s',symbol:'BTCUSD',tf:'15m'},policy=resolveTradePolicy(cfg,cell,'source');
 fs.writeFileSync(file,JSON.stringify(cfg));const before=fs.readFileSync(file,'utf8');removeAccountPositionCaps(file,true);assert.equal(fs.readFileSync(file,'utf8'),before);
 removeAccountPositionCaps(file);const next=JSON.parse(fs.readFileSync(file,'utf8'));
 const expected=structuredClone(cfg);expected.paper.maxOpenPositions=0;expected.risk.maxPositionsTotal=0;assert.deepEqual(next,expected);
 const revised=resolveTradePolicy(next,cell,'source');assert.equal(revised.strategyId,policy.strategyId);assert.notEqual(revised.id,policy.id,'exact policy accounting remains strict; no historical evidence is relabelled');
 assert.equal(removeAccountPositionCaps(file).changed,false);
 for(const key of ['maxOpenPositions','maxPositionsTotal'] as const)for(const value of [-1,.5,NaN,Infinity]){
  const bad=structuredClone(next);if(key==='maxOpenPositions')bad.paper.maxOpenPositions=value;else bad.risk.maxPositionsTotal=value;assert.ok(validateConfig(bad).some(e=>e.includes(key)));
 }
 assert.deepEqual(validateConfig(next),[]);next.risk.maxPositionsTotal=9;fs.writeFileSync(file,JSON.stringify(next));assert.throws(()=>removeAccountPositionCaps(file),/reviewed eight-position/);
});
