import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeltaRest, DeltaRequestError } from '../delta/rest.ts';
import { RestTransport, parseOrder, wirePayload } from './client.ts';

const order = () => ({ id: 9, product_id: 27, side: 'sell', size: 2, unfilled_size: 2,
  order_type: 'market_order', stop_order_type: 'stop_loss_order', stop_price: '90',
  reduce_only: true, state: 'pending', client_order_id: 'vnedge-test' });
const transport = (rest: Record<string, unknown>) => new RestTransport('testnet', {}, rest as unknown as DeltaRest);

test('exchange booleans are explicit: string false must never become reduce-only true', () => {
  assert.equal(parseOrder({ ...order(), reduce_only: 'false' }).reduce_only, false);
  assert.equal(parseOrder({ ...order(), reduce_only: 'true' }).reduce_only, true);
  assert.equal(parseOrder({ ...order(), reduce_only: undefined }).reduce_only, undefined);
  for (const value of [0, 1, null, 'yes', 'False']) assert.throws(() => parseOrder({ ...order(), reduce_only: value }), /reduce_only/);
});

test('malformed orders cannot fabricate quantities, identity or terminal fills', () => {
  for (const patch of [{ id: undefined }, { id: NaN }, { product_id: 0 }, { product_id: null },
    { size: undefined }, { size: null }, { size: 1.5 }, { unfilled_size: undefined },
    { unfilled_size: -1 }, { unfilled_size: 3 }, { state: undefined }, { state: 'filled' },
    { average_fill_price: 'NaN' }, { paid_commission: '' }, { stop_price: false }]) {
    assert.throws(() => parseOrder({ ...order(), ...patch }), /exchange/);
  }
  assert.equal(parseOrder({ ...order(), size: '2', unfilled_size: '1', average_fill_price: '90', paid_commission: '-0.01' }).paid_commission, -.01);
  assert.equal(parseOrder({ ...order(), id: '9007199254740993' }).id, '9007199254740993');
  assert.throws(() => parseOrder({ ...order(), id: 9007199254740993 }), /order id/);
});

test('only a structured order-not-found response means absence', async () => {
  for (const bad of [undefined, null, {}, { success: true }]) {
    const t = transport({ order: async () => bad, orderByClientId: async () => bad });
    await assert.rejects(t.order(9)); await assert.rejects(t.orderByClientId('vnedge-test'));
  }
  for (const error of [new Error('404 not found'), new DeltaRequestError('bad gateway', 502, 'order_not_found'), new DeltaRequestError('unknown', 404, null)]) {
    await assert.rejects(transport({ order: async () => { throw error; } }).order(9));
  }
  assert.equal(await transport({ order: async () => { throw new DeltaRequestError('absent', 404, 'order_not_found'); } }).order(9), null);
});

test('an edit acknowledgement cannot borrow the requested order id', async () => {
  for (const response of [{ success: true }, { id: null }, { id: 8 }]) {
    await assert.rejects(transport({ editOrder: async () => response }).editOrder({ id: 9, product_id: 27, size: 2, stop_price: '90' }));
  }
});

test('unsupported FOK, invalid quantities and coercible booleans never reach the network', async () => {
  let calls = 0;
  const t = transport({ placeOrder: async () => { calls++; return { id: 1 }; } });
  const base = { product_id: 27, size: 2, side: 'buy', order_type: 'market_order' } as const;
  for (const patch of [{ time_in_force: 'fok' }, { size: 0 }, { size: 1.2 }, { size: NaN },
    { product_id: -1 }, { reduce_only: 'false' }, { post_only: 'false' }, { side: 'hold' },
    { limit_price: '' }, { stop_price: 'Infinity' }, { stop_price: '90' }, { client_order_id: 42 }]) {
    await assert.rejects(t.placeOrder({ ...base, ...patch } as any));
  }
  assert.equal(calls, 0);
  assert.equal(wirePayload({ ...base, time_in_force: 'ioc', purpose: 'entry' }).purpose, undefined);
});

test('a fill absent from margin inventory is found through its known product', async () => {
  const queried: number[] = [];
  const t = transport({ positions: async () => [], products: async () => new Map([['BTCUSD', { id: 27, symbol: 'BTCUSD' }]]),
    position: async (id: number) => { queried.push(id); return { size: '-3', entry_price: '70000' }; } });
  const rows = await t.positions([27, 27]);
  assert.deepEqual(queried, [27]);
  assert.deepEqual(rows.map(({ raw: _, ...p }) => p), [{ symbol: 'BTCUSD', product_id: 27, size: -3, entry_price: 70000 }]);
});

test('a stale margin quantity is never used after real-time reads fail or disagree', async () => {
  const inventory = [{ product_id: 27, product_symbol: 'BTCUSD', size: 20, entry_price: '70000' }];
  const t = transport({ positions: async () => inventory, position: async () => ({ size: 0, entry_price: null }) });
  assert.equal((await t.positions())[0].size, 0);
  for (const response of [{}, [], { size: null }, { size: '' }, { size: 'NaN' }, { size: 1.2 }, { size: 1, entry_price: null }, { size: 0, product_id: 99 }]) {
    await assert.rejects(transport({ positions: async () => inventory, position: async () => response }).positions());
  }
  await assert.rejects(transport({ positions: async () => inventory, position: async () => { throw Error('timeout'); } }).positions(), /timeout/);
});

test('malformed or duplicate position inventory fails instead of claiming a flat account', async () => {
  const row = { product_id: 27, product_symbol: 'BTCUSD', size: 2 };
  for (const inventory of [{ unexpected: true }, null, { result: [] }, [null], [{ ...row, size: undefined }], [row, row]]) {
    await assert.rejects(transport({ positions: async () => inventory }).positions());
  }
});

test('the real-time endpoint always supplies the required product filter', async () => {
  const rest = new DeltaRest(); const calls: any[] = [];
  rest.request = async (...args: any[]) => { calls.push(args); return { size: 0 } as any; };
  await rest.position(27);
  assert.deepEqual(calls, [['GET', '/v2/positions', { auth: true, query: { product_id: 27 } }]]);
  await assert.rejects(rest.position(0)); assert.equal(calls.length, 1);
});
