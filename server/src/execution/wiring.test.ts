import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribeRealtime } from './wiring.ts';
test('L1 subscriptions include held and pending markets from both books even after scanner removal',()=>{
  const seen=new Map<string,string[]>();
  subscribeRealtime({resolvedSymbols:['BTCUSD'],scanners:{requiredSeries:()=>[]},paper:{openPositions:()=>[{symbol:'ETHUSD'}],pendingEntries:()=>[{symbol:'SOLUSD'}]},shadow:{openPositions:()=>[{symbol:'AINUSD'}],pendingEntries:()=>[{symbol:'ETHUSD'}]},incubator:{symbols:()=>['BTCUSD','XRPUSD']},depthRecorder:{symbols:['BTCUSD']},feed:{subscribe:(ch:string,sy:string[])=>seen.set(ch,sy)}} as any);
  assert.deepEqual(seen.get('ob_l1'),['BTCUSD','ETHUSD','AINUSD','SOLUSD','XRPUSD']);
  assert.deepEqual(seen.get('all_trades'),seen.get('ob_l1'));
});

const channels = ['v2/ticker', 'ob_l1', 'all_trades', 'mark_price', 'funding_rate'];
function allocationFixture() {
  const seen = new Map<string, string[]>();
  const required: Array<{symbol: string; tf: string}> = [];
  const emptyBook = {openPositions: () => [], pendingEntries: () => []};
  return {seen, required, app: {
    resolvedSymbols: ['BTCUSD'], scanners: {requiredSeries: () => required},
    paper: emptyBook, shadow: emptyBook, incubator: {symbols: () => []},
    depthRecorder: {symbols: ['BTCUSD']},
    feed: {subscribe: (channel: string, symbols: string[]) => seen.set(channel, symbols)},
  }};
}

test('explicit paper allocations receive execution feeds before any order exists, without shadow ownership', () => {
  const {seen, required, app} = allocationFixture();
  required.push({symbol: 'PARTIUSD', tf: '1h'}, {symbol: 'LTCUSD', tf: '1h'}, {symbol: 'PARTIUSD', tf: '15m'});
  subscribeRealtime(app as any);
  for (const channel of channels) assert.deepEqual(seen.get(channel), ['BTCUSD', 'PARTIUSD', 'LTCUSD'], channel);
  assert.deepEqual(seen.get('ob_updates'), ['BTCUSD'], 'full depth audit retains its bounded symbol set');
});

test('a newly activated paper allocation gets execution feeds on configuration refresh', () => {
  const {seen, required, app} = allocationFixture();
  subscribeRealtime(app as any);
  required.push({symbol: 'AAVEUSD', tf: '15m'});
  subscribeRealtime(app as any);
  for (const channel of channels) assert.deepEqual(seen.get(channel), ['BTCUSD', 'AAVEUSD'], channel);
});
