import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeltaRest } from './rest.ts';

test('authenticated retries refresh signatures after server delays', async t => {
  let now = 100000, calls = 0; const timestamps: string[] = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    timestamps.push(init.headers.timestamp);
    if (++calls === 1) { now += 10000; return new Response('{}', { status: 503 }); }
    return new Response(JSON.stringify({ success: true, result: [] }));
  });
  await new DeltaRest({ apiKey: 'test', apiSecret: 'test' }).wallet();
  assert.deepEqual(timestamps, ['100', '110']);
});

test('rate limit reset header controls retry delay and mutations with zero retries are not retried', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? new Response('{}', { status: 429, headers: { 'X-RATE-LIMIT-RESET': '1' } }) : new Response('{"result":[]}'));
  await new DeltaRest().tickers(); assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(new DeltaRest({ apiKey: 'test', apiSecret: 'test' }).placeOrder({ product_id: 27, size: 1, side: 'buy', order_type: 'market_order' }), /rate limited/);
  assert.equal(calls, 1);
});

test('open orders reads every cursor page and fails on a repeated cursor', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: any) => {
    calls++;
    if (calls === 1) return new Response('{"result":[{"id":1}],"meta":{"after":"next"}}');
    assert.equal(new URL(url).searchParams.get('after'), 'next');
    return new Response('{"result":[{"id":2}],"meta":{}}');
  });
  const rest = new DeltaRest({ apiKey: 'test', apiSecret: 'test' });
  assert.deepEqual(await rest.openOrders(), [{ id: 1 }, { id: 2 }]);
  t.mock.method(globalThis, 'fetch', async () => new Response('{"result":[],"meta":{"after":"stuck"}}'));
  await assert.rejects(rest.openOrders(), /repeated pagination cursor/);
});

test('thin candle pages continue backwards and respect the requested time window', async t => {
  let calls = 0;
  const bar = (time: number) => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ result: ++calls === 1 ? [bar(300), bar(200)] : [bar(100), bar(50)] })));
  assert.deepEqual((await new DeltaRest().candles('BTCUSD', '1m', 100, 250)).map(b => b.time), [100, 200]);
});
