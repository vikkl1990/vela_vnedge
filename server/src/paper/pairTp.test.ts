import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, validateConfig, ConfigStore } from '../config.ts';
import { resolveLevels, splitPairLegs } from './logic.ts';
import { PaperEngine } from './engine.ts';
import { Db } from '../db.ts';
import { runBacktest } from './backtest.ts';

function config() {
  const c=structuredClone(DEFAULT_CONFIG);
  Object.assign(c.paper,{slippageBps:0,feeRatePct:0,makerFeeRatePct:0,liquidation:false,useSpread:false,requireQuote:false,fillSource:'candles',minRiskFeeRatio:0,trailAfterR:0,floorAtR:0});
  c.paper.takeProfitBySymbol={BTCUSD:{mode:'override',rr:[1,2,3],split:[.4,.3,.3]}};
  return c;
}

test('pair targets are symmetric, isolated by symbol, and respect script fallback mode',()=>{
 const c=config();
 for(const side of ['long','short'] as const){const lv=resolveLevels({symbol:'BTCUSD',side,price:100,sl:side==='long'?95:105,tp:[side==='long'?150:50]},c.paper,.25);assert.ok(!('error' in lv));assert.deepEqual(lv.tp,side==='long'?[105,110,115]:[95,90,85]);assert.deepEqual(lv.tpSplit,[.4,.3,.3]);}
 const other=resolveLevels({symbol:'ETHUSD',side:'long',price:100,sl:95,tp:[150]},c.paper,.25);assert.ok(!('error' in other));assert.deepEqual(other.tp,[150]);assert.equal(other.tpSplit,undefined);
 c.paper.takeProfitBySymbol!.BTCUSD!.mode='fallback';
 const script=resolveLevels({symbol:'BTCUSD',side:'long',price:100,sl:95,tp:[150]},c.paper,.25);assert.ok(!('error' in script));assert.deepEqual(script.tp,[150]);assert.equal(script.tpSplit,undefined);
 const fallback=resolveLevels({symbol:'BTCUSD',side:'long',price:100,sl:95},c.paper,.25);assert.ok(!('error' in fallback));assert.deepEqual(fallback.tp,[105,110,115]);
});

test('collapsed tick-rounded pair targets are rejected instead of silently redistributing allocations',()=>{
 const c=config();assert.ok('error' in resolveLevels({symbol:'BTCUSD',side:'long',price:100,sl:99.9},c.paper,1));
});

test('pair allocation conserves contracts and does not allocate to zero-weight legs',()=>{
 for(const split of [[.4,.3,.3],[0,.5,.5],[0,0,1],[.25,.25,.5]])for(let qty=1;qty<=100;qty++){
  const legs=splitPairLegs(qty,split,3);assert.equal(legs.reduce((a,b)=>a+b,0),qty);assert.ok(legs.every(Number.isInteger));split.forEach((w,i)=>{if(!w)assert.equal(legs[i],0)});
 }
 assert.deepEqual(splitPairLegs(1,[.25,.25,.5],3),[1,0,0]);
 assert.deepEqual(splitPairLegs(1,[0,.5,.5],3),[0,1,0]);
 assert.deepEqual(splitPairLegs(10,[.4,.3,.3],3),[4,3,3]);
});

test('reject malformed policies; null deliberately clears a pair override',()=>{
 for(const value of [[],null,{'btc':{mode:'override',rr:[1,2,3],split:[.4,.3,.3]}},{BTCUSD:{mode:'override',rr:[1,1,3],split:[.4,.3,.3]}},{BTCUSD:{mode:'override',rr:[1,2,3],split:[.4,.4,.4]}},{BTCUSD:{mode:'wrong'}}]){
 const c=config();c.paper.takeProfitBySymbol=value as any;assert.ok(validateConfig(c).some(x=>x.includes('takeProfitBySymbol')));}
 const c=config();c.paper.takeProfitBySymbol={BTCUSD:null};assert.deepEqual(validateConfig(c),[]);
});

for(const fillSource of ['candles','tape'] as const)test(`pair policies apply to ${fillSource} entries and remain fixed once accepted`,t=>{
 const c=config();c.paper.fillSource=fillSource;const db=new Db(':memory:');t.after(()=>db.db.close());const engine=new PaperEngine(db,()=>c);const at=Date.now();
 const ev={kind:'entry' as const,side:'long' as const,price:100,sl:95,tp:[150],label:'entry',message:'',source:'alert' as const,barTime:at-900000,barIndex:0};
 const d=engine.onEntry(ev,{scannerId:'s',scannerName:'s',symbol:'BTCUSD',tf:'15m',market:{tickSize:.25,contractValue:1},refPrice:100,at,signalId:null,exitMode:'both'});
 assert.equal(d.action,fillSource==='tape'?'pending':'opened');
 c.paper.takeProfitBySymbol!.BTCUSD={mode:'override',rr:[2,4,6],split:[0,0,1]};
 if(fillSource==='tape')engine.onTrade('BTCUSD',100,100,at+2000,at+2000);
 const p=engine.openPositions()[0];assert.deepEqual(p.tp,[105,110,115]);assert.ok(p.legs[0]>0);assert.equal(p.legs.reduce((a,b)=>a+b,0),p.qty);
});

test('backtest uses the same pair targets and fills the funded first target',()=>{
 const c=config();c.paper.breakEvenAfterTp1=false;
 const bars=Array.from({length:20},(_,i)=>({time:(i+1)*900000,open:100,high:i===19?106:101,low:99,close:100,volume:100}));
 const ev={kind:'entry' as const,side:'long' as const,price:100,sl:95,tp:[150],label:'entry',message:'',source:'alert' as const,barTime:bars[18].time,barIndex:18};
 const bt=runBacktest({scannerId:'s',scannerName:'s',symbol:'BTCUSD',tf:'15m',bars,events:[ev],cfg:c.paper,exitMode:'both',contractValue:1,tickSize:.25});
 assert.equal(bt.stats.open,1); // first target reduces, rather than closes, this position
 assert.equal(bt.entries,1);
 // Completing through TP3 creates a trade with all three pair-priced fills.
 bars[19].high=116;
 const closed=runBacktest({scannerId:'s',scannerName:'s',symbol:'BTCUSD',tf:'15m',bars,events:[ev],cfg:c.paper,exitMode:'both',contractValue:1,tickSize:.25});
 assert.equal(closed.trades.length,1);assert.equal(closed.trades[0].exitReason,'tp3');
});

test('pair removal survives config deep merge',async t=>{
 const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pair-tp-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new ConfigStore(path.join(dir,'config.json'));store.update({paper:config().paper});store.update({paper:{takeProfitBySymbol:{BTCUSD:null}}} as any);assert.equal(store.get().paper.takeProfitBySymbol?.BTCUSD,null);
});

test('pending pair entries reject a fill past TP1 rather than shifting allocations to other targets',t=>{
 const c=config();c.paper.fillSource='tape';const db=new Db(':memory:');t.after(()=>db.db.close());const engine=new PaperEngine(db,()=>c);const at=Date.now();
 const d=engine.onEntry({kind:'entry',side:'long',price:100,sl:95,tp:[],label:'entry',message:'',source:'alert',barTime:at-900000,barIndex:0},{scannerId:'s',scannerName:'s',symbol:'BTCUSD',tf:'15m',market:{tickSize:.25,contractValue:1},refPrice:100,at,signalId:null,exitMode:'both'});
 assert.equal(d.action,'pending');engine.onTrade('BTCUSD',106,100,at+2000,at+2000);assert.equal(engine.openPositions().length,0);assert.equal(engine.pendingEntries().length,0);
});
