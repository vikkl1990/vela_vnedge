import test from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {scannerPairs} from './allocation.ts';
import {IncubatorStore} from '../incubator/store.ts';
import {livePairs,syncLive,demote} from '../incubator/cycle.ts';

test('incubator and execution use the same legacy frames, not the screening frame',t=>{
  const db=new Db(':memory:');t.after(()=>db.db.close());const store=new IncubatorStore(db),cfg=structuredClone(DEFAULT_CONFIG);
  cfg.incubator.tf='15m';cfg.timeframes=['4h'];
  cfg.scanners={s:{enabled:true,symbols:['BTCUSD'],timeframes:['15m','1h'],exitMode:'both'}};
  assert.deepEqual(livePairs(cfg),scannerPairs(cfg.scanners.s,cfg.timeframes).map(p=>({scannerId:'s',...p})));
  assert.equal(syncLive(store,cfg,1000).added,2);
  const one=store.find('s','BTCUSD','1h')!;assert.equal(one.stage,'live');
  demote(store,cfg,one.id,'test',(_id,patch)=>Object.assign(cfg.scanners.s,patch),null,2000);
  assert.deepEqual(scannerPairs(cfg.scanners.s,cfg.timeframes),[{symbol:'BTCUSD',tf:'15m'}]);
  assert.equal(syncLive(store,cfg,3000).added,0,'demotion must not recreate the wrong timeframe');
  const last=store.find('s','BTCUSD','15m')!;
  demote(store,cfg,last.id,'test',(_id,patch)=>Object.assign(cfg.scanners.s,patch),null,4000);
  cfg.scanners.s.enabled=true;
  assert.deepEqual(scannerPairs(cfg.scanners.s,cfg.timeframes),[],'re-enable must not resurrect retired legacy pairs');
});
test('explicit empty allocations and duplicate tuples are consistent across consumers',()=>{
  const sc={enabled:true,symbols:['BTCUSD'],timeframes:['1h'],exitMode:'both' as const,pairs:[]};
  assert.deepEqual(scannerPairs(sc,['15m']),[]);
  assert.deepEqual(scannerPairs({...sc,pairs:[{symbol:'ETHUSD',tf:'4h'},{symbol:'ETHUSD',tf:'4h'}]},['15m']),[{symbol:'ETHUSD',tf:'4h'}]);
  assert.deepEqual(scannerPairs({symbols:null},['15m']),[]);
  assert.deepEqual(scannerPairs({symbols:['BTCUSD'],timeframes:null},['1h','4h']),[{symbol:'BTCUSD',tf:'1h'},{symbol:'BTCUSD',tf:'4h'}]);
});
