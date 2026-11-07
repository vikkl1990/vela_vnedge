import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribeRealtime, wireTradingStatus } from './wiring.ts';
import { EventEmitter } from 'node:events';
import { TradingStatus } from '../delta/tradingStatus.ts';

test('maintenance completion discards an in-flight catalogue and immediately requests a fresh one', async t => {
  const at = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now: at });
  const feed = Object.assign(new EventEmitter(), { connected: true });
  const status = new TradingStatus();
  const pending: Array<(products: Map<string, any>) => void> = [];
  let refreshes = 0;
  const stop = wireTradingStatus({ feed, rest: {
    revalidateProducts: () => { refreshes++; return new Promise<Map<string, any>>(resolve => pending.push(resolve)); },
    products: () => { throw new Error('Recovery must force a new observation'); },
  } } as any, status);
  t.after(stop);
  feed.emit('status', { connected: true });
  feed.emit('system_status', { status: 'live', event: 'snapshot', timestamp: at * 1000 });
  assert.equal(refreshes, 1);
  t.mock.timers.setTime(at + 1000);
  feed.emit('system_status', { status: 'maintenance', event: 'maintenance_started', timestamp: (at + 1000) * 1000 });
  t.mock.timers.setTime(at + 2000);
  feed.emit('system_status', { status: 'live', event: 'maintenance_finished', timestamp: (at + 2000) * 1000 });
  assert.match(status.block('BTCUSD')!, /unknown or stale/);
  pending.shift()!(new Map([['BTCUSD', { symbol: 'BTCUSD', trading_status: 'operational' }]]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 2, 'completion queued a fresh observation without waiting a minute');
  assert.match(status.block('BTCUSD')!, /unknown or stale/, 'pre-maintenance result must not unblock');
  pending.shift()!(new Map([['BTCUSD', { symbol: 'BTCUSD', trading_status: 'operational' }]]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(status.block('BTCUSD'), null);
  stop(); assert.equal(feed.listenerCount('system_status'), 0);
});
test('L1 subscriptions include held and pending markets from both books even after scanner removal',()=>{
  const seen=new Map<string,string[]>();
  subscribeRealtime({resolvedSymbols:['BTCUSD'],scanners:{requiredSeries:()=>[]},paper:{openPositions:()=>[{symbol:'ETHUSD'}],pendingEntries:()=>[{symbol:'SOLUSD'}]},shadow:{openPositions:()=>[{symbol:'AINUSD'}],pendingEntries:()=>[{symbol:'ETHUSD'}]},incubator:{symbols:()=>['BTCUSD','XRPUSD']},orderFlow:{symbols:['BTCUSD']},depthRecorder:{symbols:['BTCUSD']},feed:{subscribe:(ch:string,sy:string[])=>seen.set(ch,sy)}} as any);
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
    orderFlow: {symbols: ['BTCUSD']}, depthRecorder: {symbols: ['BTCUSD']},
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
