/**
 * Exchange executor against a stateful fake exchange: confirmed entries, brackets from confirmed
 * exposure, in-place stop edits, level exits settled against resting orders, the sweep, start-up
 * recovery, reconciliation, dry-run, close-all and the host guard (decision 46).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG, type AppConfig } from '../config.ts';
import { PaperEngine } from '../paper/engine.ts';
import { ExchangeExecutor, createExecutor } from './testnet.ts';
import { DryRunTransport, RestTransport, assertProductionSafe, resolveHost, type EditOrder, type ExchangeOrder, type ExchangePosition, type ExchangeTransport, type OrderPayload } from './client.ts';
import { DELTA_INDIA_PROD, DELTA_INDIA_TESTNET, DeltaRest, DeltaRequestError } from '../delta/rest.ts';

/** A fake exchange that remembers its orders: market orders fill at once, resting orders stay open until the test says otherwise. */
class FakeTransport implements ExchangeTransport {
  host: 'testnet' | 'production' = 'testnet';
  baseUrl = 'fake://';
  hasAuth = true;
  dryRun = false;
  placed: OrderPayload[] = [];
  edited: EditOrder[] = [];
  cancelled: Array<{ id: number | string; product_id: number }> = [];
  cancelledAll: number[] = [];
  positionsList: ExchangePosition[] = [];
  orders = new Map<string, ExchangeOrder>();
  /** What the next market order fills at, and how much of it (defaults: the paper price is unknown → 100.5, all of it). */
  nextFill: { price?: number | null; size?: number; fee?: number; reject?: string; unanswered?: boolean; pending?: boolean } = {};
  /** Outcomes for the next orders in turn; used before `nextFill` while non-empty. */
  queue: Array<typeof this.nextFill> = [];
  /** Failures to throw on the next edit, cancel or lookup. */
  failEdit = false;
  /** Decision 165: leverage calls seen, a refusal to raise, and a leverage the exchange insists on holding. */
  leverageCalls: Array<{ product_id: number; leverage: number }> = [];
  failLeverage: string | null = null;
  holdLeverage: number | null = null;
  /** How many client-id lookups answer null before the order is found (exchange lag). */
  lagLookups = 0;
  private seq = 1;
  async products() { return new Map<string, any>([['BTCUSD', { id: 27, symbol: 'BTCUSD' }], ['ETHUSD', { id: 3136, symbol: 'ETHUSD' }]]); }
  async positions() { return this.positionsList; }
  async openOrders() { return [...this.orders.values()].filter(o => o.state === 'open'); }
  async placeOrder(o: OrderPayload) {
    const n = this.queue.length ? this.queue.shift()! : this.nextFill; if (!this.queue.length) this.nextFill = {};
    if (n.reject) throw new Error(`Delta POST /v2/orders → 400 {"code":"${n.reject}"}`);
    this.placed.push(o);
    if (n.unanswered) { const id = this.seq++; this.orders.set(String(id), { id, product_id: o.product_id, side: o.side, size: o.size, unfilled_size: 0, order_type: o.order_type, state: 'closed', average_fill_price: n.price ?? 101, paid_commission: 0, client_order_id: o.client_order_id ?? null }); throw new Error('fetch failed: timeout'); }
    const id = this.seq++;
    const market = o.order_type === 'market_order' && !o.stop_order_type;
    const size = market ? (n.size ?? o.size) : o.size;
    const ord: ExchangeOrder = { id, product_id: o.product_id, side: o.side, size: o.size, unfilled_size: market && !n.pending ? o.size - size : o.size, order_type: o.order_type, stop_order_type: o.stop_order_type ?? null, limit_price: o.limit_price ?? null, stop_price: o.stop_price ?? null, reduce_only: Boolean(o.reduce_only), client_order_id: o.client_order_id ?? null, state: n.pending ? 'pending' : market ? (size > 0 ? 'closed' : 'cancelled') : 'open', average_fill_price: market && size > 0 && !n.pending ? (n.price === undefined ? 100.5 : n.price) : null, paid_commission: market && !n.pending ? (n.fee ?? 0) : null };
    this.orders.set(String(id), ord);
    return { id, state: ord.state };
  }
  async cancelOrder(id: number | string, product_id: number) { this.cancelled.push({ id, product_id }); const o = this.orders.get(String(id)); if (o && o.state === 'open') o.state = 'cancelled'; return {}; }
  async cancelAll(product_id: number) { this.cancelledAll.push(product_id); for (const o of this.orders.values()) if (o.product_id === product_id && o.state === 'open') o.state = 'cancelled'; return {}; }
  async wallet() { return []; }
  async order(id: number | string) { return this.orders.get(String(id)) ?? null; }
  async orderByClientId(cid: string) { if (this.lagLookups > 0) { this.lagLookups--; return null; } return [...this.orders.values()].find(o => o.client_order_id === cid) ?? null; }
  async setLeverage(product_id: number, leverage: number) { this.leverageCalls.push({ product_id, leverage }); if (this.failLeverage) throw new Error(this.failLeverage); return { leverage: this.holdLeverage ?? leverage }; }
  async editOrder(e: EditOrder) { if (this.failEdit) throw new Error('Delta PUT /v2/orders → 400 edit refused'); this.edited.push(e); const o = this.orders.get(String(e.id)); if (o) { if (e.stop_price) o.stop_price = e.stop_price; if (e.size) { o.size = e.size; o.unfilled_size = e.size; } } return { id: e.id, state: 'open' }; }
  /** The exchange fills a resting order on its own. */
  fill(id: number | string, price: number, fee = 0, size?: number) { const o = this.orders.get(String(id))!; const q = size ?? o.size; o.unfilled_size = o.size - q; o.state = o.unfilled_size <= 0 ? 'closed' : 'open'; o.average_fill_price = price; o.paid_commission = fee; }
  vanish(id: number | string) { const o = this.orders.get(String(id))!; o.state = 'cancelled'; }
  byPurpose(purpose: string) { return this.placed.map((p, i) => ({ p, id: i + 1 })).filter(x => x.p.purpose === purpose); }
}

async function setup(t: { after: (fn: () => void) => void }, exec: Partial<AppConfig['execution']> = {}, fakeIn?: FakeTransport, dbIn?: Db) {
  const db = dbIn ?? new Db(':memory:');
  if (!dbIn) t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, { slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false, fillSource: 'candles', latencyMs: 0, tpSplit: [0.4, 0.3, 0.3] });
  Object.assign(cfg.execution, { mode: 'testnet', bracket: true, reconcileSec: 0, sweepSec: 0, confirmSec: 2 }, exec);
  const paper = new PaperEngine(db, () => cfg);
  const fake = fakeIn ?? new FakeTransport();
  const clock = { t: 1_000 };
  const ex = new ExchangeExecutor(paper, () => cfg, fake, { now: () => clock.t, reconcileSec: 0, sweepSec: 0, pollMs: 100, sleep: async ms => { clock.t += ms; } });
  await ex.start();
  t.after(() => ex.stop());
  const open = (side: 'long' | 'short' = 'long', symbol = 'BTCUSD',contractValue=1) => paper.onEntry({ kind: 'entry', side, price: 100, sl: side === 'long' ? 95 : 105, tp: side === 'long' ? [105, 110, 115] : [95, 90, 85], label: 'entry', message: '', source: 'alert', barTime: 0, barIndex: 0 },
    { scannerId: 's', scannerName: 's', symbol, tf: '15m', market: { tickSize: 0.25, contractValue }, refPrice: 100, at: 60_010, signalId: null, exitMode: 'both' }).position!;
  return { cfg, db, paper, fake, ex, open, clock };
}

test('entry: market order, confirmed, paper restated to the exchange fill; bracket built from the confirmed size', async t => {
  const { fake, ex, open, paper } = await setup(t);
  fake.nextFill = { price: 100.5, fee: 0.3 };
  const p = open();
  await ex.flush();
  assert.equal(p.qty, 200); assert.equal(p.entryPrice, 100.5); assert.equal(p.fills[0].price, 100.5); assert.equal(p.fees, 0.3);
  assert.equal(paper.orders(5)[0].price, 100.5);
  const [entry, stop, tp1, tp2, tp3] = fake.placed;
  assert.deepEqual({ ...entry, client_order_id: undefined }, { product_id: 27, size: 200, side: 'buy', order_type: 'market_order', reduce_only: false, purpose: 'entry', client_order_id: undefined });
  assert.equal(stop.stop_order_type, 'stop_loss_order'); assert.equal(stop.stop_price, '95'); assert.equal(stop.stop_trigger_method, 'mark_price'); assert.equal(stop.reduce_only, true); assert.equal(stop.size, 200);
  assert.deepEqual([tp1, tp2, tp3].map(o => [o.order_type, o.limit_price, o.size, o.reduce_only, o.time_in_force]), [['limit_order', '105', 80, true, 'gtc'], ['limit_order', '110', 60, true, 'gtc'], ['limit_order', '115', 60, true, 'gtc']]);
  const rows = ex.ledger.forPosition(p.id);
  assert.deepEqual(rows.map(r => [r.purpose, r.state]), [['entry', 'filled'], ['stop', 'acknowledged'], ['tp', 'acknowledged'], ['tp', 'acknowledged'], ['tp', 'acknowledged']]);
  assert.equal(rows[0].avgPrice, 100.5); assert.equal(rows[0].filledSize, 200);
  assert.equal(ex.status().brackets[0].stop?.price, 95);
});

test('entry partly filled: the paper position shrinks to what the exchange holds and the bracket covers only that', async t => {
  const { fake, ex, open } = await setup(t);
  fake.nextFill = { price: 100, size: 150 };
  const p = open();
  await ex.flush();
  assert.equal(p.qty, 150); assert.equal(p.qtyOpen, 150); assert.deepEqual(p.legs, [60, 45, 45]);
  const stop = fake.placed.find(o => o.purpose === 'stop')!;
  assert.equal(stop.size, 150);
  assert.equal(fake.placed.filter(o => o.purpose === 'tp').reduce((a, o) => a + o.size, 0), 150);
});

test('entry rejected or unfilled: the paper position is voided, nothing is protected, no trade is recorded', async t => {
  const { fake, ex, open, paper } = await setup(t);
  fake.nextFill = { reject: 'insufficient_margin' };
  const a = open();
  await ex.flush();
  assert.equal(paper.openPositions().length, 0); assert.equal(paper.position(a.id), undefined);
  assert.equal(fake.placed.length, 0, 'no bracket for a position that never existed');
  assert.equal(ex.ledger.forPosition(a.id)[0].state, 'rejected');
  fake.nextFill = { size: 0 };
  const b = open();
  await ex.flush();
  assert.equal(paper.openPositions().length, 0); assert.equal(paper.position(b.id), undefined);
  assert.equal(fake.placed.length, 1, 'entry sent, nothing else');
  assert.equal(ex.ledger.forPosition(b.id)[0].state, 'cancelled');
  assert.equal(paper.trades().length, 0);
});

test('TP1 on paper: settled against the resting limit (its price stands); the stop is edited in place, never cancelled first', async t => {
  const { fake, ex, open, paper } = await setup(t);
  const p = open();
  await ex.flush();
  const tp1 = fake.byPurpose('tp')[0];
  fake.fill(tp1.id, 105.2, 0.1);
  paper.onBar('BTCUSD', { time: 120_000, high: 106, low: 100, close: 105.5 }, 120_010);
  await ex.flush();
  const f = p.fills.at(-1)!;
  assert.equal(f.reason, 'tp1'); assert.equal(f.price, 105.2); assert.equal(f.fee, 0.1); assert.equal(p.breakEven, true);
  assert.equal(fake.placed.length, 5, 'nothing new sent');
  assert.deepEqual(fake.edited, [{ id: '2', product_id: 27, stop_price: '100.5', size: 120 }]);
  assert.equal(fake.cancelled.length, 0);
  assert.equal(ex.status().brackets[0].tps.length, 2);
  assert.equal(ex.ledger.get(2)!.stopPrice, 100.5);
});

test('edit refused: a new stop is placed BEFORE the old one is cancelled', async t => {
  const { fake, ex, open, paper } = await setup(t);
  const p = open();
  await ex.flush();
  fake.failEdit = true;
  fake.fill(fake.byPurpose('tp')[0].id, 105);
  paper.onBar('BTCUSD', { time: 120_000, high: 106, low: 100, close: 105.5 }, 120_010);
  await ex.flush();
  const stops = fake.byPurpose('stop');
  assert.equal(stops.length, 2); assert.equal(stops[1].p.stop_price, '100.5'); assert.equal(stops[1].p.size, 120);
  assert.deepEqual(fake.cancelled, [{ id: '2', product_id: 27 }]);
  assert.equal(ex.status().brackets[0].stop?.exchangeId, String(stops[1].id));
  void p;
});

test('paper stop hit but the exchange stop did not fire: it is cancelled and the exit goes out at market at the exchange price', async t => {
  const { fake, ex, open, paper } = await setup(t);
  const p = open();
  await ex.flush();
  fake.nextFill = { price: 94.7 };
  paper.onBar('BTCUSD', { time: 120_000, high: 100, low: 94, close: 94.5 }, 120_010);
  await ex.flush();
  const closed = paper.position(p.id)!;   // a closed position is restated in the store, not in the object the test holds
  assert.equal(closed.status, 'closed'); assert.equal(closed.exitReason, 'sl'); assert.equal(closed.exitPrice, 94.7);
  assert.equal(paper.trades()[0].exitPrice, 94.7);
  const last = fake.placed.at(-1)!;
  assert.equal(last.purpose, 'exit'); assert.equal(last.reduce_only, true); assert.equal(last.side, 'sell'); assert.equal(last.size, 200);
  assert.ok(fake.cancelled.some(c => String(c.id) === '2'), 'the resting stop was cancelled');
  assert.equal(fake.cancelled.length, 4, 'stop + 3 targets');
  assert.equal(ex.status().brackets.length, 0);
});

test('the exchange stop fires first: the sweep books the exit at the exchange price and cancels the targets; no market order', async t => {
  const { fake, ex, open, paper } = await setup(t);
  const p = open();
  await ex.flush();
  fake.fill(2, 94.8, 0.2);
  await ex.sweepNow();
  await ex.flush();
  assert.equal(p.status, 'closed'); assert.equal(p.exitReason, 'sl'); assert.equal(p.exitPrice, 94.8); assert.equal(p.fees, 0.2);
  assert.equal(fake.placed.length, 5);
  assert.equal(fake.cancelled.length, 3, 'targets cancelled');
  assert.equal(ex.ledger.get(2)!.state, 'filled');
  assert.equal(paper.trades().length, 1);
});

test('the exchange stop vanishes while the position is open: the sweep re-places it', async t => {
  const { fake, ex, open } = await setup(t);
  open();
  await ex.flush();
  fake.vanish(2);
  await ex.sweepNow();
  const stops = fake.byPurpose('stop');
  assert.equal(stops.length, 2); assert.equal(stops[1].p.stop_price, '95');
  assert.equal(ex.ledger.get(2)!.state, 'cancelled');
  assert.equal(ex.status().brackets[0].stop?.exchangeId, String(stops[1].id));
});

test('discretionary exit: reduce-only market, fill restated from the exchange; bracket cancelled; funding never sent', async t => {
  const { fake, ex, open, paper } = await setup(t);
  const p = open('short');
  await ex.flush();
  paper.setMark('BTCUSD', 100);
  paper.chargeFunding('BTCUSD', 0.01, 200_000);
  await ex.flush();
  assert.equal(fake.placed.length, 5, 'funding produced no order');
  fake.nextFill = { price: 99.1, fee: 0.4 };
  paper.closeManual(p.id, 'manual');
  await ex.flush();
  const last = fake.placed.at(-1)!;
  assert.equal(last.order_type, 'market_order'); assert.equal(last.side, 'buy'); assert.equal(last.reduce_only, true); assert.equal(last.size, 200);
  const closed = paper.position(p.id)!;
  assert.equal(closed.exitPrice, 99.1); assert.equal(closed.fills.at(-1)!.fee, 0.4);
  assert.equal(fake.cancelled.length, 4);
  assert.equal(ex.ledger.forPosition(p.id).find(r => r.purpose === 'exit')!.reason, 'manual');
});

test('an unanswered entry is found by client id; an empty lookup stays uncertain until later evidence', async t => {
  const { fake, ex, open, paper } = await setup(t);
  fake.nextFill = { unanswered: true, price: 101 };
  fake.lagLookups = 3;
  const p = open();
  await ex.flush();
  assert.equal(p.entryPrice, 101, 'the order the exchange did receive is the one that counts');
  assert.equal(ex.ledger.forPosition(p.id)[0].state, 'filled');
  assert.equal(fake.byPurpose('stop').length, 1, 'bracket only after the entry was found');
  // The exchange did receive this order, but its lookup is delayed beyond the deadline.
  fake.nextFill = { unanswered: true };
  fake.lagLookups = 1000;
  const q = open('short', 'ETHUSD');
  await ex.flush();
  assert.equal(paper.position(q.id)?.status, 'open', 'absence of lookup evidence cannot void an accepted entry');
  assert.equal(ex.ledger.forPosition(q.id)[0].state, 'unknown');
  const sent = fake.placed.length;
  fake.lagLookups = 0;
  await ex.sweepNow(); await ex.flush();
  assert.equal(ex.ledger.forPosition(q.id)[0].state, 'filled');
  assert.equal(fake.placed.length, sent + 4, 'only the recovered entry protection is sent');
});

for (const fault of ['502', 'malformed', 'missing-id']) test(`accepted entry with ${fault} response reconciles without a second submission`, async t => {
  const fake = new FakeTransport(), place = fake.placeOrder.bind(fake);
  fake.placeOrder = async o => {
    const ack = await place(o);
    if (o.purpose === 'entry') {
      if (fault === 'missing-id') return {} as any;
      throw new DeltaRequestError('ambiguous acknowledgement', fault === '502' ? 502 : 200, fault === '502' ? 'server_error' : 'bad_json');
    }
    return ack;
  };
  const { ex, open } = await setup(t, {}, fake);
  const p = open(); await ex.flush();
  assert.equal(fake.byPurpose('entry').length, 1);
  assert.equal(ex.ledger.forPosition(p.id)[0].state, 'filled');
  assert.equal(fake.byPurpose('stop').length, 1);
});

test('partial open entry stays unsettled until the exchange finalizes quantity', async t => {
  const { fake, ex, open } = await setup(t);
  fake.nextFill = { pending: true };
  const p = open(); await ex.flush();
  fake.fill(1, 101, .1, 50);
  await ex.sweepNow();
  assert.equal(ex.ledger.forPosition(p.id)[0].state, 'acknowledged');
  assert.deepEqual(ex.status().unconfirmed, [p.id]);
  fake.fill(1, 102, .4);
  await ex.sweepNow(); await ex.flush();
  assert.equal(ex.ledger.forPosition(p.id)[0].filledSize, 200);
  assert.equal(fake.byPurpose('entry').length, 1);
  assert.equal(fake.byPurpose('stop')[0].p.size, 200);
});

test('testnet ledger is never adopted or mutated by production recovery', async t => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const a = await setup(t, {}, undefined, db), p = a.open(); await a.ex.flush(); a.ex.stop();
  const before = db.all<any>('SELECT * FROM exchange_orders');
  const prod = new FakeTransport(); prod.host = 'production';
  const b = await setup(t, {}, prod, db);
  assert.deepEqual(b.ex.ledger.recent(), []);
  assert.deepEqual(b.ex.lastRecovery?.unmirrored, [p.id]);
  assert.equal(prod.placed.length, 0);
  assert.deepEqual(db.all<any>('SELECT * FROM exchange_orders'), before);
});

test('unanswered protection is not duplicated or cancelled during delayed lookup', async t => {
  const fake = new FakeTransport(), place = fake.placeOrder.bind(fake);
  fake.placeOrder = async o => { const ack = await place(o); if (o.purpose === 'stop') throw new DeltaRequestError('gateway failed', 502, null); return ack; };
  const { ex, open } = await setup(t, {}, fake);
  const p = open(); await ex.flush();
  fake.lagLookups = 1000;
  const before = fake.placed.length;
  await ex.recover(); await ex.recover();
  assert.equal(fake.placed.length, before); assert.equal(fake.cancelled.length, 0);
  fake.lagLookups = 0;
  await ex.sweepNow(); await ex.flush();
  assert.equal(ex.status().brackets.find(b=>b.positionId===p.id)?.stop?.exchangeId, '2');
  assert.equal(fake.placed.length, before);
});

test('failed open-order snapshot defers recovery without replacing protection, then retries', async t => {
  const db = new Db(':memory:'); t.after(()=>db.db.close());
  const fake = new FakeTransport(), a = await setup(t, {}, fake, db);
  a.open(); await a.ex.flush(); a.ex.stop();
  const before=fake.placed.length, list=fake.openOrders.bind(fake);
  fake.openOrders=async()=>{throw Error('snapshot unavailable');};
  const b=await setup(t,{},fake,db);
  assert.match(b.ex.lastRecovery!.notes.join(' '),/deferred/);
  assert.equal(fake.placed.length,before);
  fake.openOrders=list;
  await b.ex.sweepNow();
  assert.equal(b.ex.status().brackets.length,1); assert.equal(fake.placed.length,before);
});

test('long exit reasons produce valid unique IDs and preserve the full ledger reason',async t=>{
  const {fake,ex,open,paper}=await setup(t);
  const p=open();await ex.flush();
  paper.closeManual(p.id,'funding-avoid');await ex.flush();
  const ids=fake.placed.map(o=>o.client_order_id!);
  assert.ok(ids.every(id=>id.length<=32));assert.equal(new Set(ids).size,ids.length);
  assert.equal(ex.ledger.forPosition(p.id).find(r=>r.purpose==='exit')?.reason,'funding-avoid');
});

test('stop/start detaches mirror listeners and cannot multiply submissions',async t=>{
  const {ex,paper,open,fake}=await setup(t);
  ex.stop();assert.equal(paper.listenerCount('order'),0);
  await ex.start();await ex.start();assert.equal(paper.listenerCount('order'),1);
  open();await ex.flush();assert.equal(fake.byPurpose('entry').length,1);
});

test('partial stop cancellation is confirmed before sending only the remaining market quantity',async t=>{
  const {ex,open,fake,paper}=await setup(t);
  const p=open();await ex.flush();fake.fill(2,94.8,.1,50);fake.nextFill={price:94.4,fee:.3};
  paper.onBar('BTCUSD',{time:120000,high:100,low:94,close:94},120010);
  await ex.flush();
  const exits=fake.byPurpose('exit');assert.equal(exits.length,1);assert.equal(exits[0].p.size,150);
  assert.equal(ex.ledger.get(2)?.filledSize,50);assert.equal(ex.status().exposure[p.id],undefined);
  const trade=paper.trades()[0];
  assert.equal(trade.exitPrice,94.5);assert.equal(trade.fees,.4);assert.equal(trade.pnl,-1200.4);
  assert.equal(trade.accountingPending,false);
});

test('failed stop cancellation cannot trigger a second exit while its outcome is unresolved',async t=>{
  const {ex,open,fake,paper}=await setup(t);
  open();await ex.flush();const cancel=fake.cancelOrder.bind(fake);
  fake.cancelOrder=async(id,pid)=>{if(String(id)==='2')throw Error('cancel timeout');return cancel(id,pid);};
  paper.onBar('BTCUSD',{time:120000,high:100,low:94,close:94},120010);
  await ex.flush();assert.equal(fake.byPurpose('exit').length,0);
  assert.equal(ex.ledger.get(2)?.state,'unknown');
  await ex.sweepNow();await ex.sweepNow();await ex.flush();
  assert.equal(fake.byPurpose('exit').length,0,'recovery must retain unresolved cancellation across sweeps');
});

test('a delayed accepted market exit is looked up instead of resubmitted by stranded recovery',async t=>{
  const {ex,open,fake,paper}=await setup(t);
  const p=open();await ex.flush();const place=fake.placeOrder.bind(fake);
  fake.placeOrder=async o=>{const ack=await place(o);if(o.purpose==='exit')throw new DeltaRequestError('gateway failed',502,null);return ack;};
  fake.lagLookups=1000;paper.closeManual(p.id);await ex.flush();
  await ex.sweepNow();assert.equal(fake.byPurpose('exit').length,1);
  fake.lagLookups=0;await ex.sweepNow();await ex.sweepNow();await ex.flush();
  assert.equal(fake.byPurpose('exit').length,1);assert.equal(ex.hasExposure(),false);
});

test('an entry still pending at the deadline stays unconfirmed with no bracket until the sweep sees it filled', async t => {
  const { fake, ex, open } = await setup(t);
  fake.nextFill = { pending: true };
  const p = open();
  await ex.flush();
  assert.deepEqual(ex.status().unconfirmed, [p.id]);
  assert.equal(fake.byPurpose('stop').length, 0, 'no bracket for exposure the exchange has not confirmed');
  fake.fill(1, 100.25, 0.1);
  await ex.sweepNow();
  await ex.flush();
  assert.equal(p.entryPrice, 100.25); assert.equal(ex.status().unconfirmed.length, 0);
  assert.equal(fake.byPurpose('stop').length, 1);
});

test('restart: brackets are rebuilt from the ledger and verified; a missing stop is re-placed; stray bot orders are cancelled', async t => {
  const fake = new FakeTransport();
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const a = await setup(t, {}, fake, db);
  const p = a.open();
  await a.ex.flush();
  a.ex.stop();
  // while the process was down: the stop was cancelled by hand, and a stray order of ours is resting
  fake.vanish(2);
  fake.orders.set('900', { id: 900, product_id: 27, side: 'sell', size: 5, unfilled_size: 5, order_type: 'limit_order', state: 'open', client_order_id: 'vnedge-999-tp1-old' });
  const before = fake.placed.length;
  const b = await setup(t, {}, fake, db);
  assert.equal(b.paper.openPositions().length, 1, 'the paper position survived the restart');
  const rep = b.ex.lastRecovery!;
  assert.equal(rep.restored, 1); assert.equal(rep.replacedStops, 1); assert.equal(rep.cancelledStray, 1); assert.deepEqual(rep.unmirrored, []);
  const st = b.ex.status();
  assert.equal(st.brackets.length, 1); assert.equal(st.brackets[0].tps.length, 3); assert.equal(st.brackets[0].stop?.price, 95);
  assert.equal(fake.placed.length, before + 1, 'one new stop, nothing else');
  assert.ok(fake.cancelled.some(c => String(c.id) === '900'));
  void p;
});

test('restart: a target the exchange filled while the process was down is booked at the exchange price', async t => {
  const fake = new FakeTransport();
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const a = await setup(t, {}, fake, db);
  const p = a.open();
  await a.ex.flush();
  a.ex.stop();
  fake.fill(fake.byPurpose('tp')[0].id, 105.3, 0.1);
  const b = await setup(t, {}, fake, db);
  const q = b.paper.position(p.id)!;
  assert.equal(q.qtyOpen, 120); assert.equal(q.fills.at(-1)!.price, 105.3); assert.equal(q.fills.at(-1)!.reason, 'tp1');
  assert.equal(b.ex.lastRecovery!.adoptedFills, 1);
  assert.equal(b.ex.status().brackets[0].tps.length, 2);
});

test('a paper position with no exchange history is reported as unmirrored and left alone', async t => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, { slippageBps: 0, feeRatePct: 0, liquidation: false, fillSource: 'candles', latencyMs: 0 });
  Object.assign(cfg.execution, { mode: 'testnet', bracket: true, reconcileSec: 0, sweepSec: 0 });
  const paper = new PaperEngine(db, () => cfg);
  const p = paper.onEntry({ kind: 'entry', side: 'long', price: 100, sl: 95, tp: [105], label: 'e', message: '', source: 'alert', barTime: 0, barIndex: 0 }, { scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', market: { tickSize: 0.25, contractValue: 1 }, refPrice: 100, at: 60_010, signalId: null, exitMode: 'both' }).position!;
  const fake = new FakeTransport();
  const ex = new ExchangeExecutor(paper, () => cfg, fake, { reconcileSec: 0, sweepSec: 0 });
  await ex.start(); t.after(() => ex.stop());
  assert.deepEqual(ex.lastRecovery!.unmirrored, [p.id]);
  assert.equal(fake.placed.length, 0);
  const r = await ex.reconcile();
  assert.ok(r.drift.some(d => d.kind === 'unmirrored'));
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
  for (const id of [3, 4, 5]) fake.vanish(id);
  const r = await ex.reconcile();
  assert.equal(r.ok, false);
  const kinds = r.drift.map(d => `${d.symbol}:${d.kind}`).sort();
  assert.deepEqual(kinds, ['BTCUSD:orders', 'BTCUSD:price', 'BTCUSD:size', 'ETHUSD:orphan-position']);
  assert.equal(r.drift.find(d => d.kind === 'orders')!.exchange, 1);
  fake.positionsList = [{ symbol: 'BTCUSD', product_id: 27, size: 200, entry_price: 100.5 }];
  for (const id of [3, 4, 5]) fake.orders.get(String(id))!.state = 'open';
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
  assert.equal(ex.ledger.recent(5).filter(x => x.purpose === 'close-all').length, 2);
});

test('dry-run: the entry is confirmed at no known price (paper price stands), the bracket is placed, nothing is sent', async t => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, { slippageBps: 0, feeRatePct: 0, liquidation: false, fillSource: 'candles', latencyMs: 0 });
  Object.assign(cfg.execution, { mode: 'dry-run', reconcileSec: 0, sweepSec: 0 });
  const paper = new PaperEngine(db, () => cfg);
  const reader = new RestTransport('testnet', {}, new DeltaRest({ baseUrl: 'http://127.0.0.1:9' }));
  const dry = new DryRunTransport(reader);
  const ex = new ExchangeExecutor(paper, () => cfg, dry, { reconcileSec: 0, sweepSec: 0, confirmSec: 1, pollMs: 1 });
  await ex.start();
  t.after(() => ex.stop());
  assert.equal(dry.hasAuth, false);
  assert.equal(dry.baseUrl, DELTA_INDIA_TESTNET);
  const r = await dry.placeOrder({ product_id: 27, size: 1, side: 'buy', order_type: 'market_order', purpose: 'entry' });
  assert.equal(r.dryRun, true);
  assert.equal(dry.log.length, 1); assert.deepEqual(dry.log[0].payload, { product_id: 27, size: 1, side: 'buy', order_type: 'market_order' }, 'purpose annotation stripped');
  assert.equal((await dry.order(r.id))?.state, 'closed');
  assert.equal((await ex.reconcile()).error, 'no API keys: nothing to reconcile');
  assert.equal(ex.status().dryRunLog?.length, 1);
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

test('a rejected exit keeps the protection: the book closes, the position is stranded, the stop stays, the sweep closes the rest', async t => {
  const { fake, ex, open, paper } = await setup(t);
  const p = open();
  await ex.flush();
  // the exit is rejected, and so is the immediate retry: the exchange keeps the whole position
  fake.queue = [{ reject: 'insufficient_margin' }, { reject: 'insufficient_margin' }];
  paper.closeManual(p.id, 'manual');
  await ex.flush();
  assert.equal(paper.openPositions().length, 0, 'the paper book is closed');
  assert.equal(fake.cancelled.length, 0, 'NO bracket order was cancelled');
  const st = ex.status();
  assert.equal(st.brackets.length, 1); assert.equal(st.brackets[0].stop?.price, 95);
  assert.deepEqual(st.stranded.map(s => [s.positionId, s.qty]), [[p.id, 200]]);
  assert.equal(ex.hasExposure(), true);
  // the next sweep closes the rest at market and only then releases the bracket
  fake.nextFill = { price: 99.5 };
  await ex.sweepNow();
  assert.equal(ex.status().stranded.length, 0);
  assert.equal(ex.status().brackets.length, 0);
  assert.equal(fake.cancelled.length, 4, 'bracket cancelled after the exchange confirmed zero');
  assert.equal(ex.hasExposure(), false);
});

test('a partial exit leaves the residual on the exchange: stop resized to it, closed by the sweep, then the bracket goes', async t => {
  const { fake, ex, open, paper } = await setup(t);
  const p = open();
  await ex.flush();
  // 120 of 200 fill; the immediate retry for the rest is rejected, so 80 stay on the exchange
  fake.queue = [{ price: 99.2, size: 120,fee:.12 }, { reject: 'insufficient_margin' }];
  paper.closeManual(p.id, 'manual');
  await ex.flush();
  const st = ex.status();
  assert.deepEqual(st.stranded.map(s => [s.positionId, s.qty]), [[p.id, 80]]);
  assert.ok(fake.edited.some(e => e.size === 80), 'the resting stop was resized to what the exchange still holds');
  assert.equal(fake.cancelled.length, 0);
  assert.equal(paper.trades()[0].accountingPending,true);
  assert.equal(paper.trades()[0].fees,0,'a partial commission cannot be presented as the whole exit fee');
  fake.nextFill = { price: 99.0,fee:.08 };
  await ex.sweepNow();
  assert.equal(ex.status().stranded.length, 0); assert.equal(ex.status().brackets.length, 0);
  assert.ok(ex.ledger.forPosition(p.id).some(r => r.reason === 'stranded' && r.state === 'filled'));
  const trade=paper.trades()[0];assert.equal(trade.exitPrice,99.12);assert.equal(trade.fees,.2);assert.ok(Math.abs(trade.pnl-(-276.2))<1e-8);
  assert.equal(trade.accountingPending,false);
  await ex.sweepNow();await ex.recover();assert.equal(paper.trades()[0].fees,.2,'repeated reconciliation cannot double-charge');
});

test('partial exit accounting survives a restart and respects short direction and contract value',async t=>{
  const first=await setup(t);const {ex,open,paper,fake,db}=first;
  fake.nextFill={price:100,fee:.2};const p=open('short','BTCUSD',.01);await ex.flush();
  const part=p.qty*.6;
  fake.queue=[{price:98,size:part,fee:.3},{reject:'retry_later'}];paper.closeManual(p.id);await ex.flush();ex.stop();
  const second=await setup(t,{},fake,db);fake.nextFill={price:97,fee:.4};await second.ex.sweepNow();
  const trade=second.paper.trades()[0];assert.equal(trade.exitPrice,97.6);assert.ok(Math.abs(trade.fees-.9)<1e-9);
  assert.ok(Math.abs(trade.pnl-(2.4*p.qty*.01-.9))<1e-8);assert.equal(trade.accountingPending,false);
  const before=fake.placed.length;await second.ex.recover();await second.ex.sweepNow();
  assert.equal(fake.placed.length,before);assert.equal(second.paper.trades()[0].pnl,trade.pnl);
});

test('open partial entry quantities persist, survive restart and cannot regress on a stale lookup',async t=>{
  const {ex,open,paper,fake,db}=await setup(t);fake.nextFill={pending:true};const p=open();await ex.flush();
  fake.fill(1,101,.1,50);await ex.sweepNow();
  assert.equal(ex.ledger.get(1)?.filledSize,50);assert.equal(ex.status().exposure[p.id],50);
  ex.stop();const second=await setup(t,{},fake,db);assert.equal(second.ex.status().exposure[p.id],50);
  fake.fill(1,100,.05,25);await second.ex.sweepNow();assert.equal(second.ex.ledger.get(1)?.filledSize,50);
  assert.equal(second.ex.status().exposure[p.id],50);assert.equal(fake.byPurpose('entry').length,1);
  fake.fill(1,102,.4);await second.ex.sweepNow();assert.equal(second.paper.position(p.id)?.fees,.4);
  assert.equal(second.ex.status().accounting.incomplete,0);assert.equal(paper.orders()[0].price,102);
});

test('missing exit commission is provisional, then a late fee updates cash exactly once',async t=>{
  const {ex,open,paper,fake}=await setup(t);const p=open();await ex.flush();
  const place=fake.placeOrder.bind(fake);
  fake.placeOrder=async o=>{const ack=await place(o);if(o.purpose==='exit')fake.orders.get(String(ack.id))!.paid_commission=null;return ack;};
  fake.nextFill={price:99};paper.closeManual(p.id);await ex.flush();
  assert.equal(paper.trades()[0].accountingPending,true);assert.equal(paper.tradesPage().accountingPending,1);
  assert.equal(paper.orders()[0].accountingState,'missing-fee');
  const exit=ex.ledger.forPosition(p.id).find(r=>r.purpose==='exit')!;
  fake.orders.get(exit.exchangeId!)!.paid_commission=.25;await ex.sweepNow();
  assert.equal(paper.trades()[0].fees,.25);assert.equal(paper.trades()[0].exitPrice,99);
  assert.equal(paper.tradesPage().accountingPending,0);
  await ex.sweepNow();await ex.recover();assert.equal(paper.trades()[0].fees,.25);
});

test('accounting update failure rolls back both journal cash and position, then retry succeeds',async t=>{
  const {ex,open,paper,fake,db}=await setup(t);const p=open();await ex.flush();
  db.db.exec("CREATE TRIGGER fail_accounting BEFORE UPDATE ON execution_accounting WHEN NEW.state='complete' AND NEW.source_order_id>1 BEGIN SELECT RAISE(ABORT,'injected accounting failure'); END");
  fake.nextFill={price:99,fee:.6};paper.closeManual(p.id);await ex.flush();
  assert.equal(paper.trades()[0].exitPrice,100.5);assert.equal(paper.orders()[0].fee,0);
  assert.equal(paper.trades()[0].fees,0);assert.equal(paper.trades()[0].accountingPending,true);
  db.db.exec('DROP TRIGGER fail_accounting');await ex.sweepNow();
  assert.equal(paper.trades()[0].exitPrice,99);assert.equal(paper.orders()[0].fee,.6);
  assert.equal(paper.trades()[0].accountingPending,false);
});

test('exact journal identity separates multiple exits with the same reason and rejects wrong-position links',async t=>{
  const {ex,open,paper,fake}=await setup(t);const p=open();await ex.flush();
  // An exchange observation can produce repeated partial exits with the same reason.
  (ex as any).adopt(p.id,()=>paper.adoptExitFill(p.id,{price:101,qty:20,fee:0,reason:'manual',at:121000}));
  (ex as any).adopt(p.id,()=>paper.adoptExitFill(p.id,{price:102,qty:20,fee:0,reason:'manual',at:121000}));
  const fills=paper.orders().filter(o=>o.reason==='manual');
  paper.restateOrderFill(fills[1].id,{price:103,fee:.2});
  const ordered=paper.orders().filter(o=>o.reason==='manual');assert.equal(ordered[0].price,102);assert.equal(ordered[1].price,103);
  const other=open('short','ETHUSD');await ex.flush();
  assert.throws(()=>ex.ledger.link(ex.ledger.forPosition(other.id)[0].id,fills[1].id),/source mismatch/);
  assert.equal(fake.byPurpose('exit').length,0,'cash restatements must not mirror back to the exchange');
});

test('accounting cannot consume another host or dry-run ledger and missing prices stay pending',async t=>{
  const {ex,open,paper,fake,db}=await setup(t);const p=open();await ex.flush();
  fake.nextFill={price:null,fee:.1};paper.closeManual(p.id);await ex.flush();
  assert.equal(paper.orders()[0].accountingState,'missing-price');assert.equal(paper.trades()[0].accountingPending,true);
  const source=paper.orders()[0].id;
  db.run("INSERT INTO exchange_orders(position_id,purpose,source_order_id,client_order_id,product_id,symbol,side,size,order_type,state,filled_size,avg_price,fee,created_at,updated_at,host) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",p.id,'exit',source,'other-host',27,'BTCUSD','sell',200,'market_order','filled',200,999,100,1,1,'production');
  await ex.sweepNow();assert.equal(paper.trades()[0].exitPrice,100.5);assert.equal(paper.trades()[0].fees,0);
  const own=ex.ledger.forPosition(p.id).find(r=>r.purpose==='exit')!;fake.orders.get(own.exchangeId!)!.average_fill_price=99;
  await ex.sweepNow();assert.equal(paper.trades()[0].exitPrice,99);assert.equal(paper.trades()[0].fees,.1);
});

test('vanished snapshot followed by still-open partial protection never books the entire exit',async t=>{
  const {ex,open,paper,fake}=await setup(t);const p=open();await ex.flush();fake.fill(2,94,.1,50);
  fake.openOrders=async()=>[];await ex.sweepNow();
  assert.equal(ex.ledger.get(2)?.state,'acknowledged');assert.equal(ex.ledger.get(2)?.filledSize,50);
  assert.equal(paper.position(p.id)?.qtyOpen,200);assert.equal(ex.status().exposure[p.id],150);
  assert.equal(fake.byPurpose('exit').length,0);
});

test('late entry price corrects already closed trading PnL, risk basis and journal cash',async t=>{
  const {ex,open,paper,fake}=await setup(t);fake.nextFill={price:null,fee:.1};const p=open();await ex.flush();
  fake.nextFill={price:99,fee:.2};paper.closeManual(p.id);await ex.flush();
  assert.equal(paper.trades()[0].accountingPending,true);assert.ok(Math.abs(paper.trades()[0].pnl-(-200.3))<1e-8);
  fake.orders.get('1')!.average_fill_price=101;await ex.sweepNow();
  const trade=paper.trades()[0];assert.equal(trade.entryPrice,101);assert.ok(Math.abs(trade.pnl-(-400.3))<1e-8);
  assert.equal(paper.position(p.id)?.riskAmount,1200);assert.equal(trade.accountingPending,false);
  assert.equal(paper.orders().find(o=>o.reason==='entry')?.price,101);
});

test('open-order snapshots trigger durable observation of a partially filled target',async t=>{
  const {ex,open,fake}=await setup(t);const p=open();await ex.flush();fake.fill(3,105,.1,40);
  await ex.sweepNow();assert.equal(ex.ledger.get(3)?.filledSize,40);assert.equal(ex.status().exposure[p.id],160);
  await ex.sweepNow();assert.equal(ex.status().exposure[p.id],160,'a repeated cumulative snapshot cannot subtract twice');
});

test('a working partial stop is not resized as though its total quantity were its remainder',async t=>{
  const {ex,open,fake}=await setup(t);const p=open();await ex.flush();fake.fill(2,94,.1,50);
  await ex.sweepNow();await ex.recover();await ex.flush();
  assert.equal(ex.status().exposure[p.id],150);assert.equal(ex.ledger.get(2)?.filledSize,50);
  assert.equal(fake.edited.filter(e=>String(e.id)==='2').length,0);
  assert.equal(fake.orders.get('2')?.unfilled_size,150);
});

test('interrupted native fill adoption resumes once but historical unlinked fills are not replayed',async t=>{
  const {ex,open,paper,fake,db}=await setup(t);const p=open();await ex.flush();fake.fill(3,105,.1);
  // Simulate termination after the exchange fill committed, before creating its journal fill.
  ex.ledger.filled(3,{filledSize:80,avgPrice:105,fee:.1});assert.equal(ex.ledger.get(3)?.adoptionPending,true);ex.stop();
  const second=await setup(t,{},fake,db);assert.equal(second.paper.position(p.id)?.qtyOpen,120);
  assert.equal(second.ex.ledger.get(3)?.adoptionPending,false);assert.ok(second.ex.ledger.get(3)?.sourceOrderId);
  await second.ex.recover();assert.equal(second.paper.position(p.id)?.qtyOpen,120);second.ex.stop();
  // Old terminal rows had no source link and no pending-adoption marker. Never infer work from them.
  db.run('UPDATE exchange_orders SET source_order_id=NULL,adoption_pending=0 WHERE id=3');
  const third=await setup(t,{},fake,db);await third.ex.sweepNow();
  assert.equal(third.paper.position(p.id)?.qtyOpen,120);assert.equal(paper.orders().filter(o=>o.reason==='tp1').length,1);
});

test('partial exits keep retrying with brackets disabled and aggregate the entire exit',async t=>{
  const {ex,open,paper,fake}=await setup(t,{bracket:false});const p=open();await ex.flush();
  fake.queue=[{size:120,price:99,fee:.12},{size:80,price:98,fee:.08}];paper.closeManual(p.id);await ex.flush();
  assert.equal(ex.status().stranded.length,0);assert.equal(ex.status().exposure[p.id],undefined);
  assert.deepEqual(fake.byPurpose('exit').map(o=>o.p.size),[200,80]);
  assert.equal(paper.trades()[0].exitPrice,98.6);assert.equal(paper.trades()[0].fees,.2);
  assert.equal(paper.trades()[0].accountingPending,false);
});

test('a partial target exit retries its remainder while the position stays open and protects actual exposure',async t=>{
  const {ex,open,paper,fake}=await setup(t);const p=open();await ex.flush();
  fake.nextFill={size:50,price:105,fee:.1};
  paper.onBar('BTCUSD',{time:120000,high:105.2,low:100,close:104},120010);await ex.flush();
  assert.equal(p.qtyOpen,120);assert.equal(ex.status().exposure[p.id],150);assert.equal(ex.status().brackets[0].stop?.size,150);
  assert.equal(paper.orders().find(o=>o.reason==='tp1')?.accountingState,'pending');
  fake.nextFill={price:106,fee:.2};await ex.sweepNow();await ex.flush();
  assert.equal(ex.status().exposure[p.id],120);assert.equal(ex.status().brackets[0].stop?.size,120);
  const tp=paper.orders().find(o=>o.reason==='tp1')!;assert.equal(tp.price,105.375);assert.ok(Math.abs(tp.fee-.3)<1e-9);assert.equal(tp.accountingState,'complete');
  assert.deepEqual(fake.byPurpose('exit').map(o=>o.p.size),[80,30]);
});

test('the executor reports the mode it was built with, not the config of the moment', async t => {
  const { cfg, ex } = await setup(t);
  assert.equal(ex.mode, 'testnet');
  cfg.execution.mode = 'paper';
  assert.equal(ex.mode, 'testnet', 'a config edit cannot relabel a running transport');
});

test('decision 165: the product leverage is set to the position\'s before the entry, once per change', async t => {
  const { fake, ex, open, paper } = await setup(t);
  const a = open();
  await ex.flush();
  const want = Math.max(1, Math.floor(a.marginLeverage || a.leverage || 1));
  assert.deepEqual(fake.leverageCalls, [{ product_id: 27, leverage: want }]);
  assert.equal(fake.placed[0].purpose, 'entry', 'the order follows the leverage call');
  paper.closeAll('test', 2_000);
  await ex.flush();
  open();
  await ex.flush();
  assert.equal(fake.byPurpose('entry').length, 2, 'a second BTC entry went out');
  assert.equal(fake.leverageCalls.length, 1, 'the exchange already holds that leverage for BTC: no second call');
  open('long', 'ETHUSD');
  await ex.flush();
  assert.deepEqual(fake.leverageCalls.map(c => c.product_id), [27, 3136], 'a new product gets its own call');
});

test('decision 165: a refused leverage call, or more leverage held than asked, voids the entry before any order', async t => {
  const { fake, ex, open, paper } = await setup(t);
  fake.failLeverage = 'Delta POST /v2/products/27/orders/leverage → 400 leverage_limit_exceeded';
  const a = open();
  await ex.flush();
  assert.equal(paper.position(a.id), undefined); assert.equal(fake.placed.length, 0);
  fake.failLeverage = null; fake.holdLeverage = 100;
  const b = open();
  await ex.flush();
  assert.equal(paper.position(b.id), undefined, 'the exchange would trade nearer liquidation than the paper book checked');
  assert.equal(fake.placed.length, 0);
});
