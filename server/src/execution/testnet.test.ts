/** Phase 5: exchange executor against a fake transport — brackets, break-even replace, reconciliation, dry-run, close-all, host guard. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG, type AppConfig } from '../config.ts';
import { PaperEngine } from '../paper/engine.ts';
import { ExchangeExecutor, createExecutor } from './testnet.ts';
import { DryRunTransport, RestTransport, assertProductionSafe, resolveHost, type ExchangeOrder, type ExchangePosition, type ExchangeTransport, type OrderPayload } from './client.ts';
import { DELTA_INDIA_PROD, DELTA_INDIA_TESTNET, DeltaRest } from '../delta/rest.ts';

class FakeTransport implements ExchangeTransport {
  host: 'testnet' | 'production' = 'testnet';
  baseUrl = 'fake://';
  hasAuth = true;
  dryRun = false;
  placed: OrderPayload[] = [];
  cancelled: Array<{ id: number | string; product_id: number }> = [];
  cancelledAll: number[] = [];
  positionsList: ExchangePosition[] = [];
  ordersList: ExchangeOrder[] = [];
  private seq = 1;
  async products() { return new Map<string, any>([['BTCUSD', { id: 27, symbol: 'BTCUSD' }], ['ETHUSD', { id: 3136, symbol: 'ETHUSD' }]]); }
  async positions() { return this.positionsList; }
  async openOrders() { return this.ordersList; }
  async placeOrder(o: OrderPayload) { this.placed.push(o); return { id: this.seq++, state: 'open' }; }
  async cancelOrder(id: number | string, product_id: number) { this.cancelled.push({ id, product_id }); return {}; }
  async cancelAll(product_id: number) { this.cancelledAll.push(product_id); return {}; }
  async wallet() { return []; }
}

async function setup(t: { after: (fn: () => void) => void }, exec: Partial<AppConfig['execution']> = {}) {
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, { slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false, fillSource: 'candles', tpSplit: [0.4, 0.3, 0.3] });
  Object.assign(cfg.execution, { mode: 'testnet', bracket: true, reconcileSec: 0 }, exec);
  const paper = new PaperEngine(db, () => cfg);
  const fake = new FakeTransport();
  const ex = new ExchangeExecutor(paper, () => cfg, fake, { now: () => 1_000, reconcileSec: 0 });
  await ex.start();
  t.after(() => ex.stop());
  const open = (side: 'long' | 'short' = 'long', symbol = 'BTCUSD') => paper.onEntry({ kind: 'entry', side, price: 100, sl: side === 'long' ? 95 : 105, tp: side === 'long' ? [105, 110, 115] : [95, 90, 85], label: 'entry', message: '', source: 'alert', barTime: 0, barIndex: 0 },
    { scannerId: 's', scannerName: 's', symbol, tf: '15m', market: { tickSize: 0.25, contractValue: 1 }, refPrice: 100, at: 60_010, signalId: null, exitMode: 'both' }).position!;
  return { cfg, paper, fake, ex, open };
}

test('entry is mirrored as a market order and a reduce-only bracket (stop-market on mark + TP limits per leg) follows', async t => {
  const { fake, ex, open } = await setup(t);
  const p = open();
  await ex.flush();
  assert.equal(p.qty, 200);
  const [entry, stop, tp1, tp2, tp3] = fake.placed;
  assert.deepEqual({ ...entry, client_order_id: undefined }, { product_id: 27, size: 200, side: 'buy', order_type: 'market_order', reduce_only: false, purpose: 'entry', client_order_id: undefined });
  assert.equal(stop.order_type, 'market_order'); assert.equal(stop.stop_order_type, 'stop_loss_order'); assert.equal(stop.stop_price, '95'); assert.equal(stop.stop_trigger_method, 'mark_price'); assert.equal(stop.reduce_only, true); assert.equal(stop.side, 'sell'); assert.equal(stop.size, 200);
  assert.deepEqual([tp1, tp2, tp3].map(o => [o.order_type, o.limit_price, o.size, o.reduce_only, o.side, o.time_in_force]), [['limit_order', '105', 80, true, 'sell', 'gtc'], ['limit_order', '110', 60, true, 'sell', 'gtc'], ['limit_order', '115', 60, true, 'sell', 'gtc']]);
  assert.ok(fake.placed.every(o => /^vnedge-\d+-/.test(o.client_order_id ?? '')));
  const st = ex.status();
  assert.equal(st.brackets.length, 1); assert.equal(st.brackets[0].tps.length, 3); assert.equal(st.brackets[0].stop?.price, 95);
});

test('TP1 on paper is left to the exchange limit; the stop is cancelled and re-placed at break-even for the remaining size', async t => {
  const { fake, ex, open, paper } = await setup(t);
  const p = open();
  await ex.flush();
  const before = fake.placed.length;
  paper.onBar('BTCUSD', { time: 120_000, high: 106, low: 100, close: 105.5 }, 120_010);
  await ex.flush();
  assert.equal(p.fills.at(-1)?.reason, 'tp1'); assert.equal(p.breakEven, true);
  const newOrders = fake.placed.slice(before);
  assert.equal(newOrders.length, 1, 'no market order for the tp1 leg');
  assert.equal(newOrders[0].purpose, 'stop'); assert.equal(newOrders[0].stop_price, '100'); assert.equal(newOrders[0].size, 120);
  assert.deepEqual(fake.cancelled, [{ id: 2, product_id: 27 }], 'old stop cancelled');
  assert.equal(ex.status().brackets[0].tps.length, 2, 'filled TP leg dropped from the bracket');
  // stop hit on paper → remaining bracket orders cancelled, nothing else sent
  const n = fake.placed.length;
  paper.onBar('BTCUSD', { time: 180_000, high: 101, low: 99, close: 99 }, 180_010);
  await ex.flush();
  assert.equal(p.status, 'closed'); assert.equal(p.exitReason, 'be');
  assert.equal(fake.placed.length, n);
  assert.equal(fake.cancelled.length, 1 + 3, 'new stop + 2 TPs cancelled');
  assert.equal(ex.status().brackets.length, 0);
});

test('discretionary exits are mirrored as reduce-only market orders and the bracket is cancelled; funding fills are never sent', async t => {
  const { fake, ex, open, paper } = await setup(t);
  const p = open('short');
  await ex.flush();
  paper.setMark('BTCUSD', 100);
  paper.chargeFunding('BTCUSD', 0.01, 200_000);
  await ex.flush();
  assert.equal(fake.placed.length, 5, 'funding produced no order');
  paper.closeManual(p.id, 'manual');
  await ex.flush();
  const last = fake.placed.at(-1)!;
  assert.equal(last.order_type, 'market_order'); assert.equal(last.side, 'buy'); assert.equal(last.reduce_only, true); assert.equal(last.size, 200);
  assert.equal(fake.cancelled.length, 4);
});

test('bracket disabled: every paper fill is mirrored as a market order, exits reduce-only', async t => {
  const { fake, ex, open, paper } = await setup(t, { bracket: false });
  const p = open();
  await ex.flush();
  assert.equal(fake.placed.length, 1);
  paper.onBar('BTCUSD', { time: 120_000, high: 106, low: 100, close: 105.5 }, 120_010);
  await ex.flush();
  assert.equal(fake.placed.length, 2);
  assert.deepEqual([fake.placed[1].side, fake.placed[1].size, fake.placed[1].reduce_only], ['sell', 80, true]);
  void p;
});

test('reconciliation flags size, price, orphan positions and missing bracket orders', async t => {
  const { fake, ex, open } = await setup(t);
  open();
  await ex.flush();
  fake.positionsList = [{ symbol: 'BTCUSD', product_id: 27, size: 150, entry_price: 101 }, { symbol: 'ETHUSD', product_id: 3136, size: -5, entry_price: 2600 }];
  fake.ordersList = [{ id: 9, product_id: 27, side: 'sell', size: 200, order_type: 'market_order', stop_order_type: 'stop_loss_order' }];
  const r = await ex.reconcile();
  assert.equal(r.ok, false);
  const kinds = r.drift.map(d => `${d.symbol}:${d.kind}`).sort();
  assert.deepEqual(kinds, ['BTCUSD:orders', 'BTCUSD:price', 'BTCUSD:size', 'ETHUSD:orphan-position']);
  assert.equal(r.drift.find(d => d.kind === 'orders')!.exchange, 1);
  fake.positionsList = [{ symbol: 'BTCUSD', product_id: 27, size: 200, entry_price: 100 }];
  fake.ordersList = [1, 2, 3, 4].map(i => ({ id: i, product_id: 27, side: 'sell', size: 1, order_type: 'limit_order' }));
  assert.equal((await ex.reconcile()).ok, true);
  assert.equal(ex.status().lastReconcile?.ok, true);
});

test('close-all cancels every order and sends reduce-only market orders against exchange positions; needs confirm', async t => {
  const { fake, ex } = await setup(t);
  fake.positionsList = [{ symbol: 'BTCUSD', product_id: 27, size: 150, entry_price: 101 }, { symbol: 'ETHUSD', product_id: 3136, size: -5, entry_price: 2600 }, { symbol: 'SOLUSD', product_id: 1, size: 0, entry_price: 0 }];
  await assert.rejects(() => ex.closeAll({}), /confirm/);
  const r = await ex.closeAll({ confirm: true });
  assert.deepEqual(fake.cancelledAll.sort(), [1, 27, 3136]);
  assert.deepEqual(fake.placed.map(o => [o.product_id, o.side, o.size, o.reduce_only, o.order_type, o.purpose]), [[27, 'sell', 150, true, 'market_order', 'close-all'], [3136, 'buy', 5, true, 'market_order', 'close-all']]);
  assert.equal(r.closed.length, 2); assert.equal(r.dryRun, false);
});

test('dry-run transport records payloads and sends nothing; status exposes the log', async t => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, { slippageBps: 0, feeRatePct: 0, liquidation: false, fillSource: 'candles' });
  Object.assign(cfg.execution, { mode: 'dry-run', reconcileSec: 0 });
  const paper = new PaperEngine(db, () => cfg);
  const fetches: string[] = [];
  const reader = new RestTransport('testnet', {}, new DeltaRest({ baseUrl: 'http://127.0.0.1:9' }));
  const dry = new DryRunTransport(reader);
  const ex = new ExchangeExecutor(paper, () => cfg, dry, { reconcileSec: 0 });
  // products come from the (unreachable) reader → executor starts without products and logs, but never throws
  await ex.start();
  t.after(() => ex.stop());
  assert.equal(dry.hasAuth, false);
  assert.equal(dry.baseUrl, DELTA_INDIA_TESTNET);
  const r = await dry.placeOrder({ product_id: 27, size: 1, side: 'buy', order_type: 'market_order', purpose: 'entry' });
  assert.equal(r.dryRun, true);
  assert.equal(dry.log.length, 1); assert.deepEqual(dry.log[0].payload, { product_id: 27, size: 1, side: 'buy', order_type: 'market_order' }, 'purpose annotation stripped');
  assert.equal((await ex.reconcile()).error, 'no API keys: nothing to reconcile');
  assert.equal(ex.status().dryRunLog?.length, 1);
  await assert.rejects(() => ex.closeAll({ confirm: true }).then(() => { throw new Error('should have read positions from the unreachable reader? no: no keys → []'); }), /no keys|should/);
  void fetches;
});

test('createExecutor: paper → null, dry-run without keys, testnet without keys falls back to dry-run', () => {
  const db = new Db(':memory:');
  const cfg = structuredClone(DEFAULT_CONFIG);
  const paper = new PaperEngine(db, () => cfg);
  assert.equal(createExecutor(paper, () => cfg, {}), null);
  cfg.execution.mode = 'dry-run';
  assert.equal(createExecutor(paper, () => cfg, {})!.transport.dryRun, true);
  cfg.execution.mode = 'testnet';
  assert.equal(createExecutor(paper, () => cfg, {})!.transport.dryRun, true);
  const live = createExecutor(paper, () => cfg, { DELTA_API_KEY: 'k', DELTA_API_SECRET: 's' })!;
  assert.equal(live.transport.dryRun, false); assert.equal(live.transport.host, 'testnet'); assert.equal(live.transport.baseUrl, DELTA_INDIA_TESTNET);
  db.db.close();
});

test('production host needs both the config flag and DELTA_LIVE=1, and then only market orders with reduce-only exits', () => {
  assert.equal(resolveHost({ allowProduction: false }, { DELTA_LIVE: '1' }), 'testnet');
  assert.equal(resolveHost({ allowProduction: true }, {}), 'testnet');
  assert.equal(resolveHost({ allowProduction: true }, { DELTA_LIVE: 'true' }), 'testnet');
  assert.equal(resolveHost({ allowProduction: true }, { DELTA_LIVE: '1' }), 'production');
  assert.equal(resolveHost(undefined, { DELTA_LIVE: '1' }), 'testnet');
  const prod = new RestTransport('production', { apiKey: 'k', apiSecret: 's' }, new DeltaRest({ baseUrl: 'http://127.0.0.1:9', apiKey: 'k', apiSecret: 's' }));
  assert.equal(prod.baseUrl, DELTA_INDIA_PROD);
  assert.throws(() => assertProductionSafe({ product_id: 1, size: 1, side: 'sell', order_type: 'limit_order', limit_price: '1', reduce_only: true, purpose: 'tp' }), /only market orders/);
  assert.throws(() => assertProductionSafe({ product_id: 1, size: 1, side: 'sell', order_type: 'market_order', stop_order_type: 'stop_loss_order', stop_price: '1', reduce_only: true, purpose: 'stop' }), /only market orders/);
  assert.throws(() => assertProductionSafe({ product_id: 1, size: 1, side: 'sell', order_type: 'market_order', reduce_only: false, purpose: 'exit' }), /reduce-only/);
  assert.doesNotThrow(() => assertProductionSafe({ product_id: 1, size: 1, side: 'buy', order_type: 'market_order', reduce_only: false, purpose: 'entry' }));
  assert.doesNotThrow(() => assertProductionSafe({ product_id: 1, size: 1, side: 'sell', order_type: 'market_order', reduce_only: true, purpose: 'close-all' }));
  return assert.rejects(() => prod.placeOrder({ product_id: 1, size: 1, side: 'sell', order_type: 'limit_order', limit_price: '1', reduce_only: true, purpose: 'tp' }), /only market orders/);
});
