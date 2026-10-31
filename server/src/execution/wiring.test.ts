import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribeRealtime } from './wiring.ts';
test('L1 subscriptions include held and pending markets from both books even after scanner removal',()=>{
  const seen=new Map<string,string[]>();
  subscribeRealtime({resolvedSymbols:['BTCUSD'],paper:{openPositions:()=>[{symbol:'ETHUSD'}],pendingEntries:()=>[{symbol:'SOLUSD'}]},shadow:{openPositions:()=>[{symbol:'AINUSD'}],pendingEntries:()=>[{symbol:'ETHUSD'}]},incubator:{symbols:()=>['BTCUSD','XRPUSD']},depthRecorder:{symbols:['BTCUSD']},feed:{subscribe:(ch:string,sy:string[])=>seen.set(ch,sy)}} as any);
  assert.deepEqual(seen.get('ob_l1'),['BTCUSD','ETHUSD','AINUSD','SOLUSD','XRPUSD']);
  assert.deepEqual(seen.get('all_trades'),seen.get('ob_l1'));
});
