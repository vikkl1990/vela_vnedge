import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG,type ScannerConfig,validateConfig} from '../config.ts';
import {IncubatorStore} from './store.ts';
import {autoPromote} from './cycle.ts';
const DAY=86400_000,T0=Date.UTC(2026,0,5),NOW=T0+21*DAY;
function world(){
 const db=new Db(':memory:'),store=new IncubatorStore(db,{evidenceMode:'historical-research'});
 store.marketStaleMs=Infinity;
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.scanners={};cfg.incubator.promote.auto=true;
 cfg.incubator.promote.maxFleet=20;cfg.incubator.promote.maxPerWeek=20;
 cfg.incubator.gate.pool='pair';
 let saved=structuredClone(cfg);
 const setScanner=(id:string,patch:Partial<ScannerConfig>)=>{saved={...saved,scanners:{...saved.scanners,[id]:{...(saved.scanners[id]??{enabled:false,symbols:null,timeframes:null,exitMode:'both'}),...patch}}};};
 function add(symbol:string,scannerId='s',n=40,book=2){
   store.move({scannerId,symbol,tf:'15m'},'proposed','test',null,null,T0);
   for(let i=0;i<n;i++){
     const at=T0+1000+Math.floor(i/n*20*DAY);
     db.run("INSERT INTO positions(status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at,exit_at,realized_pnl,fees,risk_amount,bt) VALUES ('closed',?,?,?,'15m','long',1,0,1,100,?,?,?,0,10,?)",scannerId,scannerId,symbol,at,at+3600_000,i%2===0?-10:20,book);
   }
 }
 return {db,store,cfg,add,setScanner,saved:()=>saved};
}
test('batch promotion retains both allocations when the config store replaces its snapshot',t=>{
 const w=world();t.after(()=>w.db.db.close());w.add('ETHUSD');w.add('SOLUSD');const before=structuredClone(w.cfg);
 const out=autoPromote(w.store,w.cfg,w.setScanner,NOW);
 assert.equal(out.promoted.length,2,JSON.stringify(out));
 assert.deepEqual(w.saved().scanners.s.pairs?.map(p=>p.symbol).sort(),['ETHUSD','SOLUSD']);
 assert.deepEqual(w.cfg,before,'caller and risk/evidence settings unchanged');
});
test('disabling allocation quotas promotes every qualified proposal but still rejects weak and backtest evidence',async t=>{
 const {resolveTradePolicy}=await import('../paper/tradePolicy.ts');
 const w=world();t.after(()=>w.db.db.close());
 w.cfg.incubator.promote={...w.cfg.incubator.promote,maxPerWeek:0,maxFleet:1,maxPerMarket:1,maxPerScanner:1};
 const cell={scannerId:'s',symbol:'ETHUSD',tf:'15m'},before=resolveTradePolicy(w.cfg,cell,'source');
 w.cfg.incubator.promote.countLimitsEnabled=false;
 assert.deepEqual(resolveTradePolicy(w.cfg,cell,'source'),before,'promotion quotas are not a trade-policy or evidence reset');
 w.add('ETHUSD');w.add('SOLUSD');w.add('ETHUSD','another');w.add('XRPUSD','weak',3);w.add('BTCUSD','backtest',40,1);
 const out=autoPromote(w.store,w.cfg,w.setScanner,NOW);
 assert.equal(out.promoted.length,3,JSON.stringify(out));assert.equal(out.blocked.length,2);
 assert.equal(w.saved().scanners.s.pairs?.length,2);assert.ok(w.saved().scanners.another);
 assert.equal(w.saved().scanners.weak,undefined);assert.equal(w.saved().scanners.backtest,undefined);
 assert.deepEqual(w.saved().risk,w.cfg.risk);assert.deepEqual(w.saved().paper,w.cfg.paper);
});
test('fleet and scanner caps include earlier promotions from the same batch',t=>{
 for(const cap of ['maxFleet','maxPerScanner'] as const){
   const w=world();t.after(()=>w.db.db.close());w.cfg.incubator.promote[cap]=1;w.add('ETHUSD');w.add('SOLUSD');
   const out=autoPromote(w.store,w.cfg,w.setScanner,NOW);assert.equal(out.promoted.length,1);assert.equal(out.blocked.length,1);
   assert.equal(w.saved().scanners.s.pairs?.length,1);
 }
});
test('waiting proposals retry when capacity frees, and evidence is rechecked at approval',t=>{
 const w=world();t.after(()=>w.db.db.close());w.add('ETHUSD');w.add('SOLUSD','weak',3);w.add('BTCUSD','backtest',40,1);
 w.cfg.incubator.promote.maxPerWeek=0;assert.equal(autoPromote(w.store,w.cfg,w.setScanner,NOW).promoted.length,0);
 w.cfg.incubator.promote.maxPerWeek=20;const out=autoPromote(w.store,w.cfg,w.setScanner,NOW);
 assert.equal(out.promoted.length,1);assert.equal(out.blocked.length,2);
 assert.ok(w.saved().scanners.s);assert.equal(w.saved().scanners.weak,undefined);assert.equal(w.saved().scanners.backtest,undefined);
});
test('a failed config write does not consume an allocation or corrupt later promotion',t=>{
 const w=world();t.after(()=>w.db.db.close());w.add('ETHUSD');w.add('SOLUSD');w.cfg.incubator.promote.maxPerScanner=1;let calls=0;
 const out=autoPromote(w.store,w.cfg,(id,patch)=>{if(calls++===0)throw Error('write failed');w.setScanner(id,patch);},NOW);
 assert.equal(out.promoted.length,1);assert.match(out.blocked[0],/write failed/);assert.equal(w.saved().scanners.s.pairs?.length,1);
});
test('automatic promotion cannot run in live mode or when disabled',t=>{
 for(const mode of ['dry-run','testnet','off','disabled'] as const){const w=world();t.after(()=>w.db.db.close());w.add('ETHUSD');
   if(mode==='off')w.cfg.incubator.promote.auto=false;else if(mode==='disabled')w.cfg.incubator.enabled=false;else w.cfg.execution.mode=mode;
   assert.deepEqual(autoPromote(w.store,w.cfg,()=>assert.fail('must not write'),NOW),{promoted:[],blocked:[]});
 }
});
test('review cadence must be an integer between five minutes and one day',()=>{
 for(const minutes of [0,4,5.5,1441,NaN]){const c=structuredClone(DEFAULT_CONFIG);c.incubator.promote.reviewMinutes=minutes;assert.ok(validateConfig(c).some(x=>x.includes('reviewMinutes')));}
 for(const minutes of [5,15,1440]){const c=structuredClone(DEFAULT_CONFIG);c.incubator.promote.reviewMinutes=minutes;assert.equal(validateConfig(c).some(x=>x.includes('reviewMinutes')),false);}
});

test('automatic promotion uses exact forward policies and excludes tracker, experimental and old-reader profits',async t=>{
 const {resolveTradePolicy,saveTradePolicy}=await import('../paper/tradePolicy.ts');
 const w=world();t.after(()=>w.db.db.close());w.cfg.paper.skipScriptStops=false;
 w.store.policyFor=cell=>resolveTradePolicy(w.cfg,cell,'current-source');
 for(const [symbol,id,scope,source] of [
   ['ETHUSD','good','shadow','current-source'],['SOLUSD','tracker','tracker','current-source'],
   ['BTCUSD','plan:experiment','shadow','current-source'],['XRPUSD','old','shadow','old-source'],
 ] as const){
   w.add(symbol,id);const policy=resolveTradePolicy(w.cfg,{scannerId:id,symbol,tf:'15m'},source);
   saveTradePolicy(w.db,policy);w.db.run('UPDATE positions SET policy_id=?,evidence_scope=? WHERE scanner_id=?',policy.id,scope,id);
 }
 const out=autoPromote(w.store,w.cfg,w.setScanner,NOW);
 assert.equal(out.promoted.length,1,JSON.stringify(out));assert.equal(out.blocked.length,3);
 assert.deepEqual(Object.keys(w.saved().scanners),['good']);
});
