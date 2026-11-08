import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../db.ts';
import { DeltaConnection } from './delta.ts';
import { AccountObserver } from './observer.ts';
import { productionReader } from './reader.ts';

const T = 1_800_000_000_000;
const KEY = 'fixture-key-only', SECRET = 'fixture-secret-only';
type Request = { url: URL; options: RequestInit };
function setup(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-observer-')), db = new Db(':memory:');
  t.after(() => { db.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const connection = new DeltaConnection(root);
  const save = (key = KEY) => connection.save({ environment: 'production', apiKey: key, apiSecret: SECRET });
  let now = T, account = '101';
  const calls: Request[] = [];
  let intercept: ((r: Request) => any) | null = null;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options: RequestInit) => {
    const r = { url: new URL(String(input)), options }; calls.push(r);
    const special = await intercept?.(r);
    if (special instanceof Error) throw special;
    if (special !== undefined && special !== null) return Response.json(special);
    const start = Number(r.url.searchParams.get('start_time')) / 1000;
    let result: unknown = [];
    switch (r.url.pathname) {
      case '/v2/users/trading_preferences': result = { user_id: account }; break;
      case '/v2/wallet/balances': result = [{ user_id: account, asset_symbol: 'USD', balance: '12.000000000001', available_balance: '11', trading_fee_credit: '3', private_note: SECRET }]; break;
      case '/v2/fills': result = [{ id: '1', user_id: account, order_id: '22', product_id: '27', size: 1, price: '100.00', commission: '.02', settling_asset_symbol: 'USD', created_at: (start + 10) * 1000,
        meta_data: { trading_fee_credits_used: '.01', total_commission_in_settling_asset: '.02', ip: SECRET } }]; break;
      case '/v2/wallet/transactions': result = [{ id: '1', user_id: account, amount: '-.01', asset_symbol: 'USD', transaction_type: 'commission', created_at: (start + 10) * 1000 }]; break;
      case '/v2/positions': result = { product_id: Number(r.url.searchParams.get('product_id')), size: 0 }; break;
    }
    return Response.json({ success: true, result, meta: { after: null } });
  });
  const observer = new AccountObserver(db, connection, () => now);
  return { db, connection, observer, save, calls, setTime: (n: number) => { now = n; }, setAccount: (n: string) => { account = n; },
    intercept: (fn: (r: Request) => any) => { intercept = fn; } };
}

test('production observation works without an executor, uses only GETs and preserves distinct exact accounting evidence', async t => {
  const f = setup(t); f.save(); await f.observer.sync();
  const s = f.observer.summary(); assert.equal(s.state, 'observing');
  assert.equal(s.account!.snapshot.balances[0].balance, '12.000000000001');
  assert.equal(s.account!.snapshot.balances[0].tradingFeeCredit, '3');
  assert.equal(s.account!.accountingStatus, 'unverified');
  assert.equal(f.db.get<any>('SELECT count(*) n FROM positions')!.n, 0);
  assert.equal(f.db.get<any>('SELECT count(*) n FROM exchange_orders')!.n, 0);
  assert.equal(f.db.get<any>('SELECT count(*) n FROM account_observer_history')!.n, 2);
  const fill = s.account!.recent.find((r: any) => r.kind === 'fills');
  assert.equal(fill.commission, '.02'); assert.equal(fill.feeDetails.trading_fee_credits_used, '.01');
  const data = JSON.stringify(s) + JSON.stringify(f.db.all('SELECT * FROM account_observer_history'));
  assert.ok(!data.includes(SECRET)); assert.ok(!data.includes(KEY));
  for (const c of f.calls) {
    assert.equal(c.options.method, 'GET'); assert.equal(c.options.body, undefined);
    assert.equal(c.url.origin, 'https://api.india.delta.exchange'); assert.equal(c.options.redirect, 'error');
  }
  assert.equal(f.calls.find(c => c.url.pathname === '/v2/fills')!.url.searchParams.get('start_time'), String((T - 3600_000) * 1000));
});

test('missing or testnet credentials never initiate observation', async t => {
  const f = setup(t); await f.observer.sync(); assert.equal(f.observer.summary().state, 'unconfigured');
  f.connection.save({ environment: 'testnet', apiKey: KEY, apiSecret: SECRET });
  await f.observer.sync(); assert.equal(f.calls.length, 0); assert.match(f.observer.summary().message, /Production India/);
});

test('account rotation isolates duplicate IDs; a replacement key for the same account resumes its cursor', async t => {
  const f = setup(t); f.save(); await f.observer.sync();
  const first = f.observer.summary().account!;
  f.save('second-fixture-key'); assert.equal(f.observer.summary().account, null);
  f.setAccount('202'); f.setTime(T + 60_000); await f.observer.sync();
  assert.notEqual(f.observer.summary().account!.label, first.label);
  assert.equal(f.db.get<any>('SELECT count(*) n FROM account_observer_history')!.n, 4);
  f.save('third-fixture-key'); f.setAccount('101'); f.setTime(T + 120_000); await f.observer.sync();
  assert.equal(f.observer.summary().account!.label, first.label);
  assert.equal(f.observer.summary().account!.historyFrom, first.historyFrom);
  assert.equal(f.db.get<any>('SELECT count(*) n FROM account_observer_history')!.n, 4);
  f.connection.remove(); assert.equal(f.observer.summary().account, null);
});

test('removing or replacing credentials during an in-flight read discards all results', async t => {
  for (const remove of [true, false]) {
    const f = setup(t); f.save();
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(r => { entered = r; });
    f.intercept(async r => { if (r.url.pathname === '/v2/wallet/balances') { entered(); await new Promise<void>(r => { release = r; }); } });
    const pending = f.observer.sync(); await waiting;
    if (remove) f.connection.remove(); else f.save('replacement-fixture');
    release(); await pending;
    assert.equal(f.db.get<any>('SELECT count(*) n FROM account_observer_state')!.n, 0);
    assert.equal(f.db.get<any>('SELECT count(*) n FROM account_observer_history')!.n, 0);
    assert.equal(f.observer.summary().account, null);
  }
});

test('partial history failure is atomic, preserves prior cursor and sanitizes upstream errors', async t => {
  const f = setup(t); f.save(); await f.observer.sync();
  const before = f.db.all('SELECT * FROM account_observer_state');
  f.setTime(T + 60_000);
  f.intercept(r => r.url.pathname === '/v2/wallet/transactions' ? new Error(SECRET) : undefined);
  await f.observer.sync();
  assert.deepEqual(f.db.all('SELECT * FROM account_observer_state'), before);
  assert.equal(f.observer.summary().state, 'error');
  assert.ok(!JSON.stringify(f.observer.summary()).includes(SECRET));
});

test('restart backfills bounded windows and reports remaining lag instead of declaring catch-up complete', async t => {
  const f = setup(t); f.save(); await f.observer.sync();
  const observer = new AccountObserver(f.db, f.connection, () => T + 5 * 3600_000);
  await observer.sync(); const s = observer.summary();
  assert.equal(s.state, 'catching-up'); assert.equal(s.account!.historyThrough, T + 3300_000);
  assert.equal(s.account!.historyFrom, T - 3600_000);
  assert.equal(f.db.get<any>('SELECT count(*) n FROM account_observer_history')!.n, 2);
});

test('staleness and backward clocks cannot be reported as current', async t => {
  const f = setup(t); f.save(); await f.observer.sync();
  f.setTime(T + 180_001); assert.equal(f.observer.summary().state, 'stale');
  f.setTime(T - 1); assert.equal(f.observer.summary().state, 'stale'); await f.observer.sync(); assert.equal(f.observer.summary().state, 'error');
});

test('concurrent syncs coalesce and shutdown invalidates in-flight results', async t => {
  const f = setup(t); f.save();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(r => { entered = r; });
  f.intercept(async r => { if (r.url.pathname === '/v2/wallet/balances') { entered(); await new Promise<void>(r => { release = r; }); } });
  const p = f.observer.sync(); assert.equal(f.observer.sync(), p); await waiting;
  f.observer.stop(); release(); await p;
  assert.equal(f.db.get<any>('SELECT count(*) n FROM account_observer_state')!.n, 0);
});

test('malformed history, looping cursors and missing pagination do not advance coverage', async t => {
  const variants = [
    { success: true, result: [] },
    { success: true, result: [], meta: { after: 'same' } },
    { success: true, result: [{ id: Number.MAX_SAFE_INTEGER + 2 }], meta: {} },
    { success: true, result: [{ id: '1', created_at: 'invalid' }], meta: {} },
    { success: true, result: [{ id: '1', created_at: (T + 1000) * 1000 }], meta: {} },
    { success: true, result: [{ id: '1', user_id: '999' }], meta: {} },
    { success: true, result: {}, meta: {} },
    { success: false, result: [], meta: {} },
  ];
  for (const response of variants) {
    const f = setup(t); f.save(); f.intercept(r => r.url.pathname === '/v2/fills' ? response : undefined);
    await f.observer.sync(); assert.equal(f.observer.summary().state, 'error');
    assert.equal(f.db.get<any>('SELECT count(*) n FROM account_observer_state')!.n, 0);
    assert.equal(f.db.get<any>('SELECT count(*) n FROM account_observer_history')!.n, 0);
  }
});

test('empty account is valid evidence of reads, not evidence of fill reconciliation', async t => {
  const f = setup(t); f.save();
  f.intercept(r => r.url.pathname === '/v2/users/trading_preferences' ? undefined : { success: true, result: [], meta: {} });
  await f.observer.sync(); const s = f.observer.summary();
  assert.equal(s.state, 'observing'); assert.equal(s.account!.accountingStatus, 'unverified');
  assert.deepEqual(s.account!.counts, []);
});

test('realtime positions confirm lagged inventory and open-order products', async t => {
  const f = setup(t); f.save();
  f.intercept(r => {
    if (r.url.pathname === '/v2/orders') return { success: true, result: [{ id: 3, product_id: 28, size: 2, unfilled_size: 1, side: 'sell', state: 'open', reduce_only: true }], meta: {} };
    if (r.url.pathname === '/v2/positions/margined') return { success: true, result: [{ product_id: 29, size: 9 }] };
    if (r.url.pathname === '/v2/positions') return { success: true, result: { product_id: Number(r.url.searchParams.get('product_id')), size: r.url.searchParams.get('product_id') === '28' ? -2 : 0, entry_price: '100' } };
  });
  await f.observer.sync(); const s = f.observer.summary();
  assert.equal(s.state, 'observing'); assert.deepEqual(s.account!.snapshot.positions.map(p => [p.productId, p.size]), [['28', -2]]);
  assert.deepEqual(new Set(f.calls.filter(c => c.url.pathname === '/v2/positions').map(c => c.url.searchParams.get('product_id'))), new Set(['27', '28', '29']));
});

test('reader follows every page, deduplicates IDs, and preserves absent fee values as unknown', async t => {
  const f = setup(t);
  f.intercept(r => r.url.pathname === '/v2/fills' ? { success: true, result: [{ id: '1', order_id: '2', product_id: '3', size: 1, created_at: T * 1000 }], meta: { after: r.url.searchParams.has('after') ? null : 'next' } } : undefined);
  const reader = productionReader(KEY, SECRET);
  const records = await reader.history('fills', T - 1000, T, '101');
  assert.equal(records.length, 1); assert.equal(records[0].payload.commission, null); assert.equal(records[0].payload.feeDetails, null);
  assert.equal(f.calls[1].url.searchParams.get('after'), 'next');
  assert.deepEqual(Object.keys(reader).sort(), ['history', 'identity', 'snapshot']);
});

test('a snapshot identity mismatch prevents both history and balance publication', async t => {
  const f = setup(t); f.save();
  f.intercept(r => r.url.pathname === '/v2/wallet/balances' ? { success: true, result: [{ user_id: 999, asset_symbol: 'USD', balance: '99' }] } : undefined);
  await f.observer.sync(); assert.equal(f.observer.summary().state, 'error'); assert.equal(f.observer.summary().account, null);
  assert.equal(f.db.get<any>('SELECT count(*) n FROM account_observer_history')!.n, 0);
});
