import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeltaFeed, normalizePublicMessage, DELTA_INDIA_WS } from './ws.ts';
const T = 1792950480000;
function read(m: any, event: string) {
  const f = new DeltaFeed(); const out: any[] = [];
  f.on(event, x => out.push(x));
  for (const x of normalizePublicMessage(m)) (f as any).handle(x);
  return out;
}
test('compact candles preserve exchange candle start independently of publish time', () => {
  const [c] = read({ type: 'candlestick_1m', sy: 'BTCUSD', res: '1m', cst: T*1000, ts: (T+30000)*1000, o: 100, h: 102, l: 99, c: 101, v: 3 }, 'candle');
  assert.equal(c.candleStartMs, T); assert.equal(c.updatedMs, T+30000); assert.equal(c.close, 101);
  assert.deepEqual(read({ type: 'candlestick_1m', sy: 'BTCUSD', ts: T*1000, c: 101 }, 'candle'), []);
});
test('compact ticker batches preserve quote sides and product identities', () => {
  const out = read({ type: 'ticker', ts: T*1000, d: [{s:'BTCUSD',m:'101',ohlc:[1,2,3,100],q:['102',5,'99',6]}, {s:'ETHUSD',m:'11',ohlc:[1,2,3,10],q:['12',5,'9',6]}] }, 'ticker');
  assert.equal(out.length, 2); assert.equal(out[0].bestAsk,102); assert.equal(out[0].bestBid,99); assert.equal(out[1].symbol,'ETHUSD');
});
test('compact prints use trade time rather than publish time and marks strip MARK prefix', () => {
  const [t] = read({type:'trades',sy:'BTCUSD',p:'100',s:2,r:'m',t:T*1000,ts:(T+1000)*1000}, 'trade');
  assert.equal(t.timeMs,T); assert.equal(t.aggressor,'sell');
  assert.equal(read({type:'mark_price',sy:'MARK:BTCUSD',p:'101',ts:T*1000}, 'mark')[0].symbol,'BTCUSD');
});
test('compact and legacy funding preserve percent units, interval and settlement', () => {
  const compact=read({type:'funding_rate',sy:'BTCUSD',fr:.01,fi:28800,nfr:T*1000,ts:T*1000},'funding')[0];
  const legacy=read({type:'funding_rate',symbol:'BTCUSD',funding_rate:.01,funding_interval:28800,next_funding_realization:T*1000,timestamp:T*1000},'funding')[0];
  assert.deepEqual(compact,legacy); assert.equal(compact.ratePct,.01);
});
test('public subscriptions map logical channels and retain global status channels on reconnect', () => {
  const f=new DeltaFeed(); assert.ok(DELTA_INDIA_WS.includes('public-socket'));
  assert.deepEqual((f as any).wireChannel('v2/ticker',['BTCUSD']),{name:'ticker',symbols:['BTCUSD']});
  assert.deepEqual((f as any).wireChannel('all_trades',['BTCUSD']),{name:'trades',symbols:['BTCUSD']});
  assert.deepEqual((f as any).wireChannel('mark_price',['BTCUSD']),{name:'mark_price',symbols:['MARK:BTCUSD']});
  assert.deepEqual((f as any).wireChannel('system_status',[]),{name:'system_status'});
  assert.ok((f as any).subs.has('system_status'));
});
