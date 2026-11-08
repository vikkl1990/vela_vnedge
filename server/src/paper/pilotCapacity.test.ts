import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pilotHorizon,pilotUsage,pilotCapacityRefusal,reservePilotEntry,type PilotConfig} from './pilotCapacity.ts';
const cfg:PilotConfig={sizeScale:1/3,maxDailyEntries:10,maxOpenPositions:2,byHorizon:{scalp:{maxDailyEntries:8,maxOpenPositions:1},swing:{maxDailyEntries:2,maxOpenPositions:1}}};
const pilot=(tf:string)=>({tf,features:{copy_pilot:1}});

test('timeframe boundaries assign pilots to scalp or swing and reject unknown frames',()=>{
  for(const tf of ['1m','3m','5m','15m','30m'])assert.equal(pilotHorizon(tf),'scalp');
  for(const tf of ['1h','2h','4h','6h','1d'])assert.equal(pilotHorizon(tf),'swing');
  assert.equal(pilotHorizon('invalid'),null);
  assert.match(pilotCapacityRefusal(cfg,'invalid',[],pilotUsage(undefined,1))!,/unsupported/);
});
test('swing occupancy cannot take the reserved scalp slot; global cap and native isolation remain',()=>{
  const usage=pilotUsage(undefined,1);
  assert.equal(pilotCapacityRefusal(cfg,'15m',[pilot('4h'),{tf:'15m'}],usage),null);
  assert.match(pilotCapacityRefusal(cfg,'1h',[pilot('4h')],usage)!,/swing open/);
  assert.match(pilotCapacityRefusal(cfg,'15m',[pilot('4h'),pilot('15m')],usage)!,/scalp open/);
  assert.match(pilotCapacityRefusal(cfg,'15m',[pilot('4h'),pilot('1h')],usage)!,/copy pilot open/,'legacy overfull swing bucket never expands the total');
});
test('daily reservations persist by horizon and rollover once, with conservative legacy migration',()=>{
  let usage=pilotUsage(undefined,1);
  for(let i=0;i<8;i++)usage=reservePilotEntry(usage,'15m');
  assert.match(pilotCapacityRefusal(cfg,'15m',[],usage)!,/scalp daily/);
  assert.equal(pilotCapacityRefusal(cfg,'1h',[],usage),null);
  usage=reservePilotEntry(usage,'1h');usage=reservePilotEntry(usage,'4h');
  assert.match(pilotCapacityRefusal(cfg,'15m',[],usage)!,/copy pilot daily/);
  assert.equal(pilotUsage(usage,2).entries,0);
  const legacy=pilotUsage({day:1,entries:3},1);
  assert.match(pilotCapacityRefusal(cfg,'1h',[],legacy)!,/swing daily/);
  const reserved=reservePilotEntry(legacy,'15m');
  assert.equal(reserved.entries,4);assert.equal(reserved.unclassified,3);assert.deepEqual(reserved.byHorizon,{scalp:1,swing:0});
});
