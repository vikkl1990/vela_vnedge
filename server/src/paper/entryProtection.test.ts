import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG,validateConfig} from '../config.ts';
import {PaperEngine} from './engine.ts';
import {protectEntry} from './entryProtection.ts';
import {backtestPolicy} from './policy.ts';
import {runBacktest} from './backtest.ts';
import {configFingerprint} from './fingerprint.ts';
import {resolveTradePolicy} from './tradePolicy.ts';
const H=3600_000,T=Date.UTC(2026,9,1);
function setup(t:any,book:0|2=0){
  const db=new Db(':memory:');t.after(()=>db.db.close());const c=structuredClone(DEFAULT_CONFIG);
  Object.assign(c.paper,{skipScriptStops:true,latencyMs:0,requireQuote:false,useSpread:false,maxSignalAgeSec:0,maxStopLossPct:0,liquidation:false,slippageBps:0,minRiskFeeRatio:0,fillSource:'candles'});
  c.paper.limitEntry!.enabled=false;c.scanners.s={enabled:true,symbols:['BTCUSD'],timeframes:['1h'],exitMode:'both'};
  const e=new PaperEngine(db,()=>c,{book});
  const ev={kind:'entry' as const,side:'long' as const,sl:95,tp:[110,120,130],price:100,label:'Long',message:'Long',source:'alert' as const,barTime:T,barIndex:30};
  const ctx={scannerId:'s',scannerName:'S',symbol:'BTCUSD',tf:'1h',market:{tickSize:.01,contractValue:1},atr:2,refPrice:100,at:T+H,signalId:null,exitMode:'both' as const};
  return{db,c,e,ev,ctx};
}
test('entry conversion preserves direction, signal price and exits without mutating source evidence',()=>{
  const ev={kind:'entry',side:'short',price:100,sl:105,tp:[90],label:'Short'}as any;
  assert.deepEqual(protectEntry(ev,'atr'),{...ev,sl:undefined,tp:[]});assert.equal(ev.sl,105);
  const exit={...ev,kind:'exit',exitType:'sl'};assert.equal(protectEntry(exit,'atr'),exit);
  assert.equal(protectEntry(ev,'native'),ev);assert.equal(protectEntry(ev),ev);
});
for(const book of [0,2]as const)test(`ATR entry conversion is explicit and matches replay in book ${book}`,t=>{
  const{db,c,e,ev,ctx}=setup(t,book);c.scanners.s.entryProtection='atr';
  const d=e.onEntry(ev,ctx);assert.equal(d.action,'opened');assert.equal(d.position!.slOriginal,97);assert.equal(d.position!.levelsSource,'atr-fallback');
  assert.equal(ev.sl,95);assert.deepEqual(ev.tp,[110,120,130]);
  const trace=JSON.parse(db.get<any>("select snapshot from decision_trace where stage='received'").snapshot);assert.equal(trace.scannerStop,95);assert.equal(trace.entryProtection,'atr');
  const bars=Array.from({length:65},(_,i)=>({time:T+(i-30)*H,open:100,high:101,low:99,close:100,volume:1}));
  const bt=runBacktest({scannerId:'s',scannerName:'S',symbol:'BTCUSD',tf:'1h',bars,events:[ev],...backtestPolicy(c,'s','1h',book===0?'account':'shadow'),contractValue:1,tickSize:.01});
  assert.equal(bt.entries,1);assert.equal(bt.rejected['account requires ATR stop'],undefined);
});
test('native allowance is scanner-scoped, default still rejects and costs still apply',t=>{
  const{c,e,ev,ctx}=setup(t);assert.match(e.onEntry(ev,ctx).reason!,/scanner's own stop/);
  const fp=configFingerprint(c,'s','1h').fp;c.scanners.s.entryProtection='native';assert.notEqual(configFingerprint(c,'s','1h').fp,fp);
  c.paper.minRiskFeeRatio=6;assert.match(e.onEntry({...ev,sl:99.99},ctx).reason!,/stop too tight/);
  assert.equal(e.onEntry(ev,ctx).action,'opened');assert.equal(e.openPositions()[0].slOriginal,95);
});
test('ATR conversion still enforces 6x costs and survives a deferred maker fill and restart',t=>{
  const{db,c,e,ev,ctx}=setup(t);c.scanners.s.entryProtection='atr';c.paper.minRiskFeeRatio=6;
  assert.match(e.onEntry(ev,{...ctx,atr:.01}).reason!,/stop too tight/);
  c.paper.fillSource='tape';c.paper.limitEntry={enabled:true,tfs:['1h'],books:['account'],atr:.1,bars:2};
  const at=Date.now();const d=e.onEntry(ev,{...ctx,at});assert.equal(d.action,'pending');
  const pe=e.pendingEntries()[0];assert.equal(pe.levels.source,'atr-fallback');assert.equal(pe.limit?.sl,undefined);

  const restored=new PaperEngine(db,()=>c);assert.equal(restored.pendingEntries().length,1);
  restored.onTrade('BTCUSD',99.7,1,at+1000,at+1000);
  assert.equal(restored.openPositions().length,1);assert.equal(restored.openPositions()[0].levelsSource,'atr-fallback');assert.equal(restored.openPositions()[0].slOriginal,96.8);
});
test('invalid entry protection cannot enter saved config',t=>{
  const{c}=setup(t);c.scanners.s.entryProtection='ignore' as any;assert.ok(validateConfig(c).some(e=>e.includes('entryProtection')));
});

test('scanner passive policy is shared by both books, scoped by timeframe, and restores its exact expiry',t=>{
  const{db,c,e,ev,ctx}=setup(t);c.scanners.s.entryProtection='atr';
  c.scanners.s.entryLimit={tfs:['15m'],atr:.1,minutes:5};c.paper.fillSource='tape';
  for(const book of ['account','shadow']as const){
    assert.deepEqual(backtestPolicy(c,'s','15m',book).entry,{pullbackAtr:.1,pullbackBars:1/3,limitWhenFlatOnly:true});
    assert.equal(backtestPolicy(c,'s','1h',book).entry,undefined);
    assert.equal(backtestPolicy(c,'other','15m',book).entry,undefined);
  }
  assert.equal(backtestPolicy(c,'s','15m','account',{executor:true}).entry,undefined);
  const at=Date.now();assert.equal(e.onEntry(ev,{...ctx,at,tf:'15m'}).action,'pending');
  const restored=new PaperEngine(db,()=>c);
  restored.onTrade('BTCUSD',99.7,1,at+5*60_000,at+5*60_000);
  assert.equal(restored.openPositions().length,0,'a touch at the expiry cannot fill');
  assert.equal(restored.pendingEntries().length,0);
});
test('malformed passive policies and ATR-floor overrides are rejected',t=>{
  const{c}=setup(t);
  for(const v of [{tfs:[],atr:.1,minutes:5},{tfs:['bad'],atr:.1,minutes:5},{tfs:['15m'],atr:NaN,minutes:5},{tfs:['15m'],atr:.1,minutes:0}]){
    c.scanners.s.entryLimit=v;assert.ok(validateConfig(c).some(e=>e.includes('entryLimit')));
  }
  c.risk.regime.minAtrPctByScanner={s:-1};assert.ok(validateConfig(c).some(e=>e.includes('minAtrPctByScanner')));
});

for(const book of [0,2]as const)test(`explicit market variant overrides fleet limits consistently in book ${book}`,t=>{
 const{c,e,ev,ctx}=setup(t,book);c.scanners.s.entryProtection='native';
 c.paper.limitEntry={enabled:true,tfs:['1h'],books:['account','shadow'],atr:.1,bars:2};
 const old=configFingerprint(c,'s','1h').fp;c.scanners.s.entryExecution='market';
 assert.notEqual(configFingerprint(c,'s','1h').fp,old);
 const p=resolveTradePolicy(c,{scannerId:'s',symbol:'BTCUSD',tf:'1h'},null,book);
 assert.equal(p.paper.limitEntry,undefined);assert.equal(p.paper.marginPerTrade,c.paper.marginPerTrade);assert.deepEqual(p.risk,c.risk);
 assert.equal(backtestPolicy(c,'s','1h',book===0?'account':'shadow').entry,undefined);
 assert(backtestPolicy(c,'other','1h',book===0?'account':'shadow').entry,'other scanners inherit fleet limits');
 assert.equal(e.onEntry(ev,ctx).action,'opened');assert.equal(e.pendingEntries().length,0);
 c.scanners.s.entryLimit={tfs:['1h'],atr:.1,minutes:5};assert(validateConfig(c).some(e=>e.includes('entryExecution')));
 delete c.scanners.s.entryLimit;c.scanners.s.entryExecution='ignore' as any;assert(validateConfig(c).some(e=>e.includes('entryExecution')));
});
