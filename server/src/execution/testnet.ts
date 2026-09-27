/**
 * Exchange executor: mirrors the paper account to Delta Exchange India (demo host unless production
 * is double-opted-in, see client.ts). Decision 46 made the exchange the authority on what filled:
 *
 *  - Every order is written to the ledger (`exchange_orders`) before it is sent, and its state after:
 *    intent → submitted → acknowledged → filled | cancelled | rejected | unknown.
 *  - An entry is sent as a market order and CONFIRMED: the paper position is restated to the size,
 *    price and fee the exchange reports, or voided if the exchange filled nothing. Only then is the
 *    bracket placed — protection is built from confirmed exposure, never from the paper's guess.
 *  - The bracket is a reduce-only stop-market (mark-price trigger) for the open size plus one
 *    reduce-only take-profit limit per leg. When the paper stop moves, the resting stop is EDITED in
 *    place; if the exchange refuses the edit, a new stop is placed before the old one is cancelled.
 *    There is never a moment with a position and no stop.
 *  - A level exit the paper book detects (stop, break-even, target) is settled against the resting
 *    order: if the exchange filled it, the paper fill is restated to the exchange price; if it did
 *    not within `confirmSec`, that order is cancelled and the exit goes out at market.
 *  - A sweep every `sweepSec` catches fills the exchange made on its own (a stop triggered on mark
 *    price the candles did not show) and books them in the paper account at the exchange price.
 *  - On start, the ledger is settled against the exchange, brackets are rebuilt from it and verified
 *    against the exchange's open orders, a missing stop is re-placed, and stray orders carrying this
 *    bot's client-id prefix are cancelled. A paper position that has no ledger history is reported
 *    and left alone — this process never opens exposure it did not itself ask for.
 *  - `closeAll()` flattens the exchange account with reduce-only market orders (requires `confirm: true`).
 */
import type { AppConfig } from '../config.ts';
import type { DeltaProduct } from '../delta/rest.ts';
import { logger } from '../log.ts';
import type { PaperEngine } from '../paper/engine.ts';
import { stopReason, type Position } from '../paper/logic.ts';
import { DryRunTransport, RestTransport, resolveHost, type ExchangeOrder, type ExchangeTransport, type OrderPayload } from './client.ts';
import { OrderLedger, type LedgerRow } from './ledger.ts';

const log = logger.scoped('execution');

/** Exit reasons handled by exchange-side bracket orders when brackets are enabled. */
const LEVEL_EXITS = new Set(['sl', 'be', 'trail', 'tp1', 'tp2', 'tp3', 'liquidation']);
const CID_PREFIX = 'vnedge-';

interface Leg { ledgerId: number; exchangeId: string; price: number; size: number; leg: number }
interface Bracket { positionId: number; symbol: string; product_id: number; stop: Leg | null; tps: Leg[] }
export interface Drift { symbol: string; kind: 'size' | 'price' | 'orders' | 'orphan-position' | 'orphan-orders' | 'unmirrored'; paper: number | string; exchange: number | string; detail: string }
export interface ReconcileReport { at: number; ok: boolean; drift: Drift[]; positions: number; orders: number; error?: string }
export interface RecoveryReport { at: number; settled: number; restored: number; replacedStops: number; adoptedFills: number; cancelledStray: number; unmirrored: number[]; notes: string[] }

export interface ExecutorOptions { now?: () => number; reconcileSec?: number; sweepSec?: number; confirmSec?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> }

type Confirmation = { status: 'filled' | 'unfilled' | 'unknown'; filledSize: number; avgPrice: number | null; fee: number | null; order?: ExchangeOrder | null };

export class ExchangeExecutor {
  readonly transport: ExchangeTransport;
  readonly ledger: OrderLedger;
  private paper: PaperEngine;
  private cfgRef: () => AppConfig;
  private products = new Map<string, DeltaProduct>();
  private brackets = new Map<number, Bracket>();
  private lastSeen = new Map<number, { sl: number | null; qtyOpen: number }>();
  /** Entries the exchange has not confirmed yet: no bracket until it does (the sweep keeps asking). */
  private unconfirmed = new Map<number, number>();   // positionId → ledger id
  /** Positions whose fills are being booked FROM the exchange: their 'order' events must not be mirrored back. */
  private adopting = new Set<number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private opts: ExecutorOptions;
  lastReconcile: ReconcileReport | null = null;
  lastRecovery: RecoveryReport | null = null;
  private queue: Promise<void> = Promise.resolve();
  private started = false;

  constructor(paper: PaperEngine, cfgRef: () => AppConfig, transport: ExchangeTransport, opts: ExecutorOptions = {}) {
    this.paper = paper; this.cfgRef = cfgRef; this.transport = transport; this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.ledger = new OrderLedger(paper.store, this.now);
  }

  get mode(): AppConfig['execution']['mode'] { return this.cfgRef().execution.mode; }
  private get bracketEnabled(): boolean { return this.cfgRef().execution.bracket !== false; }
  private get confirmMs(): number { return (this.opts.confirmSec ?? this.cfgRef().execution.confirmSec ?? 15) * 1000; }
  private get pollMs(): number { return this.opts.pollMs ?? 500; }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.loadProducts();
    if (this.transport.hasAuth) {
      try { const w = await this.transport.wallet(); log.info(`${this.transport.host} connected (${this.transport.dryRun ? 'dry-run writes' : 'live writes'}): ${Array.isArray(w) ? w.length : 0} wallet entries`); }
      catch (e: any) { log.error(`exchange init failed: ${e?.message ?? e}`); }
    } else log.warn(`execution ${this.mode} on ${this.transport.host}: no API keys → ${this.transport.dryRun ? 'payloads are logged only' : 'nothing can be sent'}`);
    await this.enqueue(() => this.recover().then(() => undefined));
    this.paper.on('order', (o: any) => { const external = this.adopting.has(o.positionId); this.enqueue(() => (external ? Promise.resolve() : this.onFill(o))); });
    this.paper.on('position', (e: { type: string; position: Position }) => this.enqueue(() => this.onPosition(e)));
    const sec = this.opts.reconcileSec ?? this.cfgRef().execution.reconcileSec;
    if (sec > 0) this.timer = setInterval(() => { this.reconcile().catch(e => log.warn(`reconcile failed: ${e?.message ?? e}`)); }, sec * 1000);
    const sweep = this.opts.sweepSec ?? this.cfgRef().execution.sweepSec ?? 10;
    if (sweep > 0) this.sweeper = setInterval(() => { this.enqueue(() => this.sweep()); }, sweep * 1000);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); if (this.sweeper) clearInterval(this.sweeper); this.timer = null; this.sweeper = null; }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn).catch(e => log.error(`execution step failed: ${e?.message ?? e}`));
    return this.queue;
  }
  /** Wait until the order queue is idle, including work queued while waiting (tests). */
  async flush(): Promise<void> { let last: Promise<void>; do { last = this.queue; await last; } while (last !== this.queue); }
  /** Run the sweep now and wait for it (tests, operators). */
  sweepNow(): Promise<void> { return this.enqueue(() => this.sweep()); }

  private async loadProducts() {
    try { this.products = await this.transport.products(); } catch (e: any) { log.error(`products failed: ${e?.message ?? e}`); }
  }
  private productId(symbol: string): number | null { const p = this.products.get(symbol); return p ? Number(p.id) : null; }
  private symbolOf(pid: number): string { return [...this.products.values()].find(p => Number(p.id) === pid)?.symbol ?? String(pid); }

  /** Book fills from the exchange into the paper account without mirroring them back out. */
  private adopt<T>(positionId: number, fn: () => T): T {
    this.adopting.add(positionId);
    try { return fn(); } finally { this.adopting.delete(positionId); }
  }

  // ---- sending and confirming ----

  /** Write the intent, send, record the outcome. A network failure leaves the row `unknown`: the exchange may have it. */
  private async send(o: OrderPayload, positionId: number, symbol: string, leg: number | null = null, reason: string | null = null): Promise<{ row: LedgerRow; ok: boolean; error?: string }> {
    const row = this.ledger.intent(o, positionId, symbol, leg, reason);
    try {
      const res = await this.transport.placeOrder(o);
      const resting = Boolean(o.stop_order_type) || o.order_type === 'limit_order';
      if (resting) this.ledger.acknowledged(row.id, res.id); else this.ledger.submitted(row.id, res.id);
      log.info(`${this.transport.host} ${o.side} ${o.size} ${symbol} (${o.purpose}${leg ? ` leg ${leg}` : ''}) → order ${res.id} ${res.state ?? ''}`);
      return { row: this.ledger.get(row.id)!, ok: true };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/abort|timeout|fetch failed|ECONNRESET|ETIMEDOUT|rate limited/i.test(msg)) { this.ledger.unknown(row.id, msg); log.error(`${o.purpose} for #${positionId} ${symbol}: no answer from the exchange (${msg}); the order may exist and will be looked up by client id`); }
      else { this.ledger.rejected(row.id, msg); log.error(`${o.purpose} for #${positionId} ${symbol} rejected: ${msg}`); }
      return { row: this.ledger.get(row.id)!, ok: false, error: msg };
    }
  }

  /** Poll one order until it is done or `confirmSec` has passed. */
  private async confirm(row: LedgerRow): Promise<Confirmation> {
    const deadline = this.now() + this.confirmMs;
    let last: ExchangeOrder | null = null;
    for (;;) {
      try {
        last = row.exchangeId ? await this.transport.order(row.exchangeId) : await this.transport.orderByClientId(row.clientOrderId);
        if (last) {
          if (!row.exchangeId) { this.ledger.submitted(row.id, last.id); row = this.ledger.get(row.id)!; }
          const filled = Math.max(0, last.size - (last.unfilled_size ?? 0));
          const done = last.state === 'closed' || last.state === 'cancelled' || (last.unfilled_size !== undefined && last.unfilled_size <= 0);
          if (done) {
            const c: Confirmation = { status: filled > 0 ? 'filled' : 'unfilled', filledSize: filled, avgPrice: last.average_fill_price ?? null, fee: last.paid_commission ?? null, order: last };
            if (c.status === 'filled') this.ledger.filled(row.id, { filledSize: filled, avgPrice: c.avgPrice, fee: c.fee }); else this.ledger.cancelled(row.id, last.state ?? 'unfilled');
            return c;
          }
        } else if (!row.exchangeId && this.now() >= deadline) {
          // asked by client id until the deadline and never seen: it did not reach the exchange
          this.ledger.rejected(row.id, 'not found on the exchange');
          return { status: 'unfilled', filledSize: 0, avgPrice: null, fee: null, order: null };
        }
      } catch (e: any) { log.warn(`confirm order ${row.exchangeId ?? row.clientOrderId} failed: ${e?.message ?? e}`); }
      if (this.now() >= deadline) break;
      await this.sleep(this.pollMs);
    }
    const filled = last ? Math.max(0, last.size - (last.unfilled_size ?? 0)) : 0;
    if (filled > 0) { this.ledger.filled(row.id, { filledSize: filled, avgPrice: last!.average_fill_price ?? null, fee: last!.paid_commission ?? null }); return { status: 'filled', filledSize: filled, avgPrice: last!.average_fill_price ?? null, fee: last!.paid_commission ?? null, order: last }; }
    // the exchange has the order and is still working it: that is known, only the fill is not
    if (last) { if (row.state !== 'acknowledged') this.ledger.acknowledged(row.id, last.id); return { status: 'unknown', filledSize: 0, avgPrice: null, fee: null, order: last }; }
    this.ledger.unknown(row.id, 'unconfirmed: the exchange did not answer');
    return { status: 'unknown', filledSize: 0, avgPrice: null, fee: null, order: null };
  }

  // ---- paper → exchange ----

  private async onFill(o: { symbol: string; side: string; qty: number; reason: string; positionId: number; price: number }) {
    if (o.reason === 'funding' || !(o.qty > 0)) return;
    const product_id = this.productId(o.symbol);
    if (!product_id) { log.warn(`no ${this.transport.host} product for ${o.symbol}; fill not mirrored`); return; }
    if (o.reason === 'entry') return this.enter(o, product_id);
    if (this.bracketEnabled && LEVEL_EXITS.has(o.reason) && this.brackets.has(o.positionId)) return this.settleLevel(o, product_id);
    await this.marketExit(o, product_id);
  }

  private async enter(o: { symbol: string; side: string; qty: number; positionId: number }, product_id: number) {
    const payload: OrderPayload = { product_id, size: Math.max(1, Math.round(o.qty)), side: o.side as 'buy' | 'sell', order_type: 'market_order', reduce_only: false, client_order_id: cid(o.positionId, 'entry'), purpose: 'entry' };
    const sent = await this.send(payload, o.positionId, o.symbol);
    if (!sent.ok && sent.row.state === 'rejected') { this.adopt(o.positionId, () => this.paper.voidPosition(o.positionId, `exchange-rejected: ${sent.error}`)); return; }
    const c = await this.confirm(sent.row);
    await this.settleEntry(o.positionId, sent.row.id, c);
  }

  /** Apply what the exchange says about an entry: restate, void, or wait. */
  private async settleEntry(positionId: number, ledgerId: number, c: Confirmation) {
    if (c.status === 'unknown') {
      this.unconfirmed.set(positionId, ledgerId);
      log.error(`entry #${positionId} UNCONFIRMED after ${this.confirmMs / 1000}s: no bracket until the exchange answers; the sweep keeps asking`);
      return;
    }
    this.unconfirmed.delete(positionId);
    if (c.status === 'unfilled') { this.adopt(positionId, () => this.paper.voidPosition(positionId, 'exchange-unfilled')); return; }
    const pos = this.adopt(positionId, () => this.paper.adoptEntryFill(positionId, { price: c.avgPrice, qty: c.filledSize, fee: c.fee, at: this.now() }));
    if (pos && pos.status === 'open' && this.bracketEnabled) { this.lastSeen.set(pos.id, { sl: pos.sl, qtyOpen: pos.qtyOpen }); await this.placeBracket(pos); }
  }

  /** A discretionary exit (reversal, script, manual, risk) or one with no resting order to lean on: reduce-only market, then restate. */
  private async marketExit(o: { symbol: string; side: string; qty: number; reason: string; positionId: number }, product_id: number) {
    const payload: OrderPayload = { product_id, size: Math.max(1, Math.round(o.qty)), side: o.side as 'buy' | 'sell', order_type: 'market_order', reduce_only: true, client_order_id: cid(o.positionId, o.reason), purpose: 'exit' };
    const sent = await this.send(payload, o.positionId, o.symbol, null, o.reason);
    if (!sent.ok && sent.row.state === 'rejected') { log.error(`exit #${o.positionId} ${o.symbol} (${o.reason}) rejected by the exchange; the paper book is closed but the exchange may still hold it — reconcile will report the drift`); return; }
    const c = await this.confirm(sent.row);
    if (c.status === 'filled') this.adopt(o.positionId, () => this.paper.restateFill(o.positionId, o.reason, { price: c.avgPrice, fee: c.fee }));
    else log.error(`exit #${o.positionId} ${o.symbol} (${o.reason}) ${c.status}: the paper book is closed but the exchange may still hold it`);
  }

  /** The paper book saw a level hit. Did the exchange? If so its price stands; if not within confirmSec, take it at market. */
  private async settleLevel(o: { symbol: string; side: string; qty: number; reason: string; positionId: number }, product_id: number) {
    const b = this.brackets.get(o.positionId)!;
    const legNo = Number(o.reason.match(/^tp(\d)$/)?.[1] ?? 0);
    const leg = o.reason === 'sl' || o.reason === 'be' || o.reason === 'trail' || o.reason === 'liquidation' ? b.stop : b.tps.find(t => t.leg === legNo) ?? null;
    if (!leg) { log.warn(`${o.symbol} ${o.reason}: no acknowledged exchange order covers it; sending a market exit`); return this.marketExit(o, product_id); }
    const row = this.ledger.get(leg.ledgerId)!;
    const c = await this.confirm(row);
    if (c.status === 'filled') {
      this.adopt(o.positionId, () => this.paper.restateFill(o.positionId, o.reason, { price: c.avgPrice, fee: c.fee }));
      this.dropLeg(b, leg);
      if (c.filledSize < Math.round(o.qty)) { log.warn(`${o.symbol} ${o.reason}: exchange filled ${c.filledSize} of ${Math.round(o.qty)}; closing the rest at market`); await this.marketExit({ ...o, qty: Math.round(o.qty) - c.filledSize, reason: `${o.reason}-rest` }, product_id); }
      return;
    }
    // the exchange did not take it: pull the resting order and exit at market
    log.warn(`${o.symbol} ${o.reason}: exchange order ${leg.exchangeId} ${c.status}; cancelling it and exiting at market`);
    try { await this.transport.cancelOrder(leg.exchangeId, product_id); this.ledger.cancelled(leg.ledgerId, 'not filled when the paper book exited'); } catch (e: any) { log.warn(`cancel ${leg.exchangeId} failed: ${e?.message ?? e}`); }
    this.dropLeg(b, leg);
    await this.marketExit(o, product_id);
  }

  private dropLeg(b: Bracket, leg: Leg) { if (b.stop === leg) b.stop = null; else b.tps = b.tps.filter(t => t !== leg); }

  private async onPosition(e: { type: string; position: Position; reason?: string }) {
    const p = e.position;
    if (!this.bracketEnabled) return;
    if (e.type === 'closed' || e.type === 'voided') { await this.cancelBracket(p.id, e.type === 'voided' ? `position voided (${e.reason ?? ''})` : 'position closed'); this.lastSeen.delete(p.id); this.unconfirmed.delete(p.id); return; }
    if (e.type === 'opened') return;   // the bracket follows the CONFIRMED entry, not the paper one
    const b = this.brackets.get(p.id);
    if (!b) return;
    const seen = this.lastSeen.get(p.id);
    if (seen && seen.sl === p.sl && seen.qtyOpen === p.qtyOpen) return;
    this.lastSeen.set(p.id, { sl: p.sl, qtyOpen: p.qtyOpen });
    b.tps = b.tps.filter(t => !p.tpHit[t.leg - 1]);
    await this.moveStop(p, b);
  }

  /** Bracket payloads for a position: one reduce-only stop-market for the open size and one reduce-only TP limit per leg. */
  bracketPayloads(p: Position, product_id: number): OrderPayload[] {
    const exitSide = p.side === 'long' ? 'sell' : 'buy';
    const out: OrderPayload[] = [];
    if (p.sl !== null && p.qtyOpen > 0) out.push({ product_id, size: Math.round(p.qtyOpen), side: exitSide, order_type: 'market_order', stop_order_type: 'stop_loss_order', stop_price: String(p.sl), stop_trigger_method: 'mark_price', reduce_only: true, client_order_id: cid(p.id, p.breakEven ? 'be' : 'sl'), purpose: 'stop' });
    let remaining = p.qtyOpen;
    for (let i = 0; i < p.tp.length && remaining > 0; i++) {
      if (p.tpHit[i]) continue;
      const isLast = i === p.tp.length - 1;
      const size = Math.round(isLast ? remaining : Math.min(p.legs[i] ?? 0, remaining));
      if (size <= 0) continue;
      remaining -= size;
      out.push({ product_id, size, side: exitSide, order_type: 'limit_order', limit_price: String(p.tp[i]), reduce_only: true, time_in_force: 'gtc', client_order_id: cid(p.id, `tp${i + 1}`), purpose: 'tp' });
    }
    return out;
  }

  private async placeBracket(p: Position) {
    const product_id = this.productId(p.symbol);
    if (!product_id) return;
    const b: Bracket = this.brackets.get(p.id) ?? { positionId: p.id, symbol: p.symbol, product_id, stop: null, tps: [] };
    this.brackets.set(p.id, b);
    for (const o of this.bracketPayloads(p, product_id)) {
      const legNo = o.purpose === 'stop' ? 0 : Number(o.client_order_id?.match(/tp(\d)/)?.[1] ?? 0);
      if (o.purpose === 'stop' ? b.stop : b.tps.some(t => t.leg === legNo)) continue;   // already resting (recovery)
      const sent = await this.send(o, p.id, p.symbol, o.purpose === 'tp' ? legNo : null);
      if (!sent.ok) continue;
      const leg: Leg = { ledgerId: sent.row.id, exchangeId: String(sent.row.exchangeId), price: Number(o.stop_price ?? o.limit_price), size: o.size, leg: legNo };
      if (o.purpose === 'stop') b.stop = leg; else b.tps.push(leg);
    }
    if (!b.stop && p.sl !== null) log.error(`bracket #${p.id} ${p.symbol}: NO STOP on the exchange; the paper stop will be sent at market when it hits`);
    log.info(`bracket #${p.id} ${p.symbol}: stop ${b.stop?.price ?? '-'} x${b.stop?.size ?? 0}, tp ${b.tps.map(t => `${t.price}x${t.size}`).join(' ') || '-'}`);
  }

  /** The paper stop moved or the open size changed: edit the resting stop in place; failing that, place the new one before cancelling the old. */
  private async moveStop(p: Position, b: Bracket) {
    if (p.status !== 'open' || p.sl === null || p.qtyOpen <= 0) return;
    const size = Math.round(p.qtyOpen);
    if (b.stop) {
      if (b.stop.price === p.sl && b.stop.size === size) return;
      try {
        await this.transport.editOrder({ id: b.stop.exchangeId, product_id: b.product_id, stop_price: String(p.sl), size });
        this.ledger.edited(b.stop.ledgerId, { stopPrice: p.sl, size });
        b.stop.price = p.sl; b.stop.size = size;
        log.info(`stop #${p.id} ${p.symbol} edited → ${p.sl} x${size}${p.breakEven ? ' (break-even)' : ''}`);
        return;
      } catch (e: any) { log.warn(`edit stop #${p.id} failed (${e?.message ?? e}); placing a new stop before cancelling the old`); }
    }
    const o = this.bracketPayloads(p, b.product_id).find(x => x.purpose === 'stop');
    if (!o) return;
    const old = b.stop;
    const sent = await this.send(o, p.id, p.symbol);
    if (!sent.ok) { log.error(`replace stop #${p.id} failed; ${old ? `the old stop at ${old.price} x${old.size} stays` : 'the position has NO exchange stop'}; the next update retries`); this.lastSeen.delete(p.id); return; }
    b.stop = { ledgerId: sent.row.id, exchangeId: String(sent.row.exchangeId), price: Number(o.stop_price), size: o.size, leg: 0 };
    if (old) { try { await this.transport.cancelOrder(old.exchangeId, b.product_id); this.ledger.cancelled(old.ledgerId, 'replaced'); } catch (e: any) { log.warn(`cancel old stop ${old.exchangeId} failed: ${e?.message ?? e}`); } }
    log.info(`stop #${p.id} ${p.symbol} → ${o.stop_price} x${o.size}${p.breakEven ? ' (break-even)' : ''}`);
  }

  private async cancelBracket(positionId: number, why: string) {
    const b = this.brackets.get(positionId);
    if (!b) return;
    this.brackets.delete(positionId);
    const legs = [...(b.stop ? [b.stop] : []), ...b.tps];
    for (const l of legs) {
      try { await this.transport.cancelOrder(l.exchangeId, b.product_id); this.ledger.cancelled(l.ledgerId, why); }
      catch (e: any) { log.warn(`cancel order ${l.exchangeId} failed: ${e?.message ?? e}`); this.ledger.unknown(l.ledgerId, `cancel failed: ${e?.message ?? e}`); }
    }
    if (legs.length) log.info(`bracket #${positionId} ${b.symbol}: cancelled ${legs.length} order(s) (${why})`);
  }

  // ---- exchange → paper: fills the simulator did not see ----

  /** Check every resting order and unconfirmed entry against the exchange; book what filled. */
  private async sweep(): Promise<void> {
    if (!this.brackets.size && !this.unconfirmed.size) return;
    if (!this.transport.hasAuth && !this.transport.dryRun) return;
    for (const [positionId, ledgerId] of [...this.unconfirmed]) {
      const row = this.ledger.get(ledgerId);
      if (!row) { this.unconfirmed.delete(positionId); continue; }
      const c = await this.confirmOnce(row);
      await this.settleEntry(positionId, ledgerId, c);
    }
    if (!this.brackets.size) return;
    let open: Set<string>;
    try { open = new Set((await this.transport.openOrders()).map(o => String(o.id))); } catch (e: any) { log.warn(`sweep: open orders failed: ${e?.message ?? e}`); return; }
    for (const b of [...this.brackets.values()]) {
      for (const leg of [...(b.stop ? [b.stop] : []), ...b.tps]) {
        if (open.has(leg.exchangeId)) continue;
        await this.settleVanished(b, leg);
      }
    }
  }

  /** A resting order is no longer open: it filled, was cancelled, or the exchange lost it. */
  private async settleVanished(b: Bracket, leg: Leg, onAdopt?: () => void) {
    let o: ExchangeOrder | null = null;
    try { o = await this.transport.order(leg.exchangeId); } catch (e: any) { log.warn(`sweep: order ${leg.exchangeId} failed: ${e?.message ?? e}`); return; }
    const filled = o ? Math.max(0, o.size - (o.unfilled_size ?? 0)) : 0;
    const pos = this.paper.position(b.positionId);
    const isStop = b.stop === leg;
    if (filled > 0) {
      this.ledger.filled(leg.ledgerId, { filledSize: filled, avgPrice: o!.average_fill_price ?? null, fee: o!.paid_commission ?? null });
      this.dropLeg(b, leg);
      if (pos && pos.status === 'open') {
        const reason = isStop ? stopReason(pos) : `tp${leg.leg}`;
        log.warn(`${b.symbol} ${reason}: the exchange filled ${filled} @ ${o!.average_fill_price ?? leg.price} before the paper book saw it; booking it`);
        this.adopt(b.positionId, () => this.paper.adoptExitFill(b.positionId, { price: o!.average_fill_price ?? leg.price, qty: filled, fee: o!.paid_commission ?? null, reason, at: this.now() }));
        onAdopt?.();
      }
      return;
    }
    this.ledger.cancelled(leg.ledgerId, o ? `gone: ${o.state ?? 'cancelled'}` : 'gone: not found');
    this.dropLeg(b, leg);
    if (isStop && pos && pos.status === 'open') { log.error(`${b.symbol} #${b.positionId}: the exchange STOP is gone (${o?.state ?? 'not found'}) while the position is open; re-placing it`); await this.moveStop(pos, b); }
  }

  // ---- start-up recovery ----

  /** Settle what the ledger says was in flight, rebuild brackets from it, and verify them against the exchange. */
  async recover(): Promise<RecoveryReport> {
    const rep: RecoveryReport = { at: this.now(), settled: 0, restored: 0, replacedStops: 0, adoptedFills: 0, cancelledStray: 0, unmirrored: [], notes: [] };
    const canAsk = this.transport.hasAuth || this.transport.dryRun;
    if (!canAsk) { rep.notes.push('no API keys: ledger not settled'); this.lastRecovery = rep; return rep; }
    // 1. orders sent before the last stop: what became of them? (resting stops and targets are
    //    verified against the exchange's open orders in step 2, not polled here)
    for (const row of this.ledger.unsettled().filter(r => r.purpose !== 'stop' && r.purpose !== 'tp')) {
      const pos = this.paper.position(row.positionId);
      const c = await this.confirmOnce(row);
      rep.settled++;
      if (c.status === 'filled' && pos && pos.status === 'open') {
        if (row.purpose === 'entry' && pos.qtyOpen === pos.qty && (pos.qty !== c.filledSize || (c.avgPrice !== null && c.avgPrice !== pos.entryPrice))) { this.adopt(pos.id, () => this.paper.adoptEntryFill(pos.id, { price: c.avgPrice, qty: c.filledSize, fee: c.fee, at: row.updatedAt })); rep.adoptedFills++; }
        if (row.purpose === 'stop' || row.purpose === 'tp') { const reason = row.purpose === 'stop' ? stopReason(pos) : `tp${row.leg ?? 1}`; this.adopt(pos.id, () => this.paper.adoptExitFill(pos.id, { price: c.avgPrice ?? row.stopPrice ?? row.limitPrice ?? pos.entryPrice, qty: c.filledSize, fee: c.fee, reason, at: row.updatedAt })); rep.adoptedFills++; }
        if (row.purpose === 'exit' && row.reason) this.adopt(pos.id, () => this.paper.restateFill(pos.id, row.reason!, { price: c.avgPrice, fee: c.fee }));
      }
      if (c.status === 'unfilled' && row.purpose === 'entry' && pos && pos.status === 'open' && pos.qtyOpen === pos.qty && pos.fills.length === 1) { this.adopt(pos.id, () => this.paper.voidPosition(pos.id, 'exchange-unfilled (recovered)')); rep.notes.push(`#${pos.id} voided: entry never filled`); }
      if (c.status === 'unknown' && row.purpose === 'entry' && pos && pos.status === 'open') this.unconfirmed.set(pos.id, row.id);
    }
    // 2. brackets from the ledger, verified against the exchange
    let openOrders: ExchangeOrder[] = [];
    try { openOrders = await this.transport.openOrders(); } catch (e: any) { rep.notes.push(`open orders unavailable: ${e?.message ?? e}`); }
    const openById = new Map(openOrders.map(o => [String(o.id), o]));
    const ours = new Set<string>();
    for (const p of this.paper.openPositions()) {
      const rows = this.ledger.forPosition(p.id);
      if (!rows.length) { rep.unmirrored.push(p.id); log.error(`#${p.id} ${p.symbol} is open on paper with no exchange history: NOT mirrored, NOT protected on the exchange — close it or accept it as paper-only`); continue; }
      if (!this.bracketEnabled) continue;
      const product_id = this.productId(p.symbol);
      if (!product_id) continue;
      const b: Bracket = { positionId: p.id, symbol: p.symbol, product_id, stop: null, tps: [] };
      for (const r of rows.filter(x => (x.purpose === 'stop' || x.purpose === 'tp') && x.state === 'acknowledged' && x.exchangeId)) {
        const leg: Leg = { ledgerId: r.id, exchangeId: String(r.exchangeId), price: r.stopPrice ?? r.limitPrice ?? 0, size: r.size, leg: r.purpose === 'stop' ? 0 : (r.leg ?? 0) };
        if (r.purpose === 'stop') b.stop = leg; else b.tps.push(leg);
        ours.add(leg.exchangeId);
      }
      this.brackets.set(p.id, b);
      this.lastSeen.set(p.id, { sl: p.sl, qtyOpen: p.qtyOpen });
      rep.restored++;
      const stopBefore = b.stop?.exchangeId ?? null;
      for (const leg of [...(b.stop ? [b.stop] : []), ...b.tps]) if (!openById.has(leg.exchangeId)) await this.settleVanished(b, leg, () => { rep.adoptedFills++; });
      const still = this.paper.position(p.id);
      if (still && still.status === 'open' && !this.unconfirmed.has(p.id)) {
        if (!b.stop && still.sl !== null) await this.moveStop(still, b);
        else if (b.stop && (b.stop.price !== still.sl || b.stop.size !== Math.round(still.qtyOpen))) await this.moveStop(still, b);
        if (!b.tps.length && still.tp.length) await this.placeBracket(still);
      }
      if (b.stop && b.stop.exchangeId !== stopBefore) rep.replacedStops++;
    }
    // 3. orders carrying this bot's prefix that no open position accounts for
    for (const o of openOrders) {
      if (!o.client_order_id?.startsWith(CID_PREFIX) || ours.has(String(o.id))) continue;
      const known = [...this.brackets.values()].some(b => b.stop?.exchangeId === String(o.id) || b.tps.some(t => t.exchangeId === String(o.id)));
      if (known) continue;
      try { await this.transport.cancelOrder(o.id, o.product_id); rep.cancelledStray++; const r = this.ledger.byClientId(o.client_order_id); if (r) this.ledger.cancelled(r.id, 'stray at start'); log.warn(`cancelled stray order ${o.id} (${o.client_order_id}) on ${this.symbolOf(o.product_id)}`); }
      catch (e: any) { rep.notes.push(`stray ${o.id} not cancelled: ${e?.message ?? e}`); }
    }
    this.lastRecovery = rep;
    log.info(`recovery: ${rep.settled} settled, ${rep.restored} bracket(s) restored, ${rep.replacedStops} stop(s) re-placed, ${rep.adoptedFills} fill(s) adopted, ${rep.cancelledStray} stray cancelled${rep.unmirrored.length ? `, UNMIRRORED ${rep.unmirrored.join(',')}` : ''}`);
    return rep;
  }

  /** One look at an order's state, no waiting. */
  private async confirmOnce(row: LedgerRow): Promise<Confirmation> {
    const saved = this.opts.confirmSec;
    this.opts.confirmSec = 0;
    try { return await this.confirm(row); } finally { this.opts.confirmSec = saved; }
  }

  // ---- reconciliation ----

  /** Compare exchange positions / open orders with the paper book; log and return every drift. */
  async reconcile(): Promise<ReconcileReport> {
    const at = this.now();
    if (!this.transport.hasAuth) { this.lastReconcile = { at, ok: true, drift: [], positions: 0, orders: 0, error: 'no API keys: nothing to reconcile' }; return this.lastReconcile; }
    try {
      const [positions, orders] = await Promise.all([this.transport.positions(), this.transport.openOrders()]);
      const drift: Drift[] = [];
      const paperBySymbol = new Map<string, { size: number; notional: number; qty: number }>();
      for (const p of this.paper.openPositions()) {
        const a = paperBySymbol.get(p.symbol) ?? { size: 0, notional: 0, qty: 0 };
        a.size += (p.side === 'long' ? 1 : -1) * p.qtyOpen; a.notional += p.entryPrice * p.qtyOpen; a.qty += p.qtyOpen;
        paperBySymbol.set(p.symbol, a);
        if (!this.ledger.forPosition(p.id).length) drift.push({ symbol: p.symbol, kind: 'unmirrored', paper: p.qtyOpen, exchange: 0, detail: `#${p.id} has no exchange history` });
      }
      const exBySymbol = new Map(positions.filter(p => p.size !== 0).map(p => [p.symbol, p]));
      for (const [symbol, a] of paperBySymbol) {
        const ex = exBySymbol.get(symbol);
        if (!ex) { drift.push({ symbol, kind: 'size', paper: a.size, exchange: 0, detail: 'paper position has no exchange position' }); continue; }
        if (Math.round(ex.size) !== Math.round(a.size)) drift.push({ symbol, kind: 'size', paper: a.size, exchange: ex.size, detail: `net contracts differ by ${ex.size - a.size}` });
        const avg = a.qty ? a.notional / a.qty : 0;
        if (avg > 0 && ex.entry_price > 0) { const bps = Math.abs(ex.entry_price - avg) / avg * 10_000; if (bps > 25) drift.push({ symbol, kind: 'price', paper: avg, exchange: ex.entry_price, detail: `average entry differs by ${bps.toFixed(0)} bps` }); }
      }
      for (const [symbol, ex] of exBySymbol) if (!paperBySymbol.has(symbol)) drift.push({ symbol, kind: 'orphan-position', paper: 0, exchange: ex.size, detail: 'exchange position without a paper position' });
      const expected = new Map<number, number>();
      for (const b of this.brackets.values()) expected.set(b.product_id, (expected.get(b.product_id) ?? 0) + (b.stop ? 1 : 0) + b.tps.length);
      const actual = new Map<number, number>();
      for (const o of orders) actual.set(o.product_id, (actual.get(o.product_id) ?? 0) + 1);
      for (const [pid, n] of expected) { const have = actual.get(pid) ?? 0; if (have !== n) drift.push({ symbol: this.symbolOf(pid), kind: 'orders', paper: n, exchange: have, detail: `expected ${n} bracket order(s), exchange has ${have}` }); }
      for (const [pid, n] of actual) if (!expected.has(pid)) drift.push({ symbol: this.symbolOf(pid), kind: 'orphan-orders', paper: 0, exchange: n, detail: `${n} open order(s) not placed by this bot` });
      for (const d of drift) log.warn(`DRIFT ${d.symbol} ${d.kind}: paper ${d.paper} vs exchange ${d.exchange} — ${d.detail}`);
      this.lastReconcile = { at, ok: drift.length === 0, drift, positions: positions.length, orders: orders.length };
      if (!drift.length) log.debug(`reconcile ok: ${positions.length} exchange position(s), ${orders.length} open order(s)`);
    } catch (e: any) {
      this.lastReconcile = { at, ok: false, drift: [], positions: 0, orders: 0, error: String(e?.message ?? e) };
      log.warn(`reconcile failed: ${this.lastReconcile.error}`);
    }
    return this.lastReconcile;
  }

  // ---- emergency ----

  /** Flatten the exchange account: cancel all orders, then a reduce-only market order against every open exchange position. */
  async closeAll(opts: { confirm?: boolean } = {}): Promise<{ closed: Array<{ symbol: string; size: number; order: unknown }>; cancelled: number[]; dryRun: boolean }> {
    if (opts.confirm !== true) throw new Error('close-all needs { "confirm": true }');
    if (!this.transport.hasAuth && !this.transport.dryRun) throw new Error('no API keys configured');
    const positions = await this.transport.positions();
    const cancelled: number[] = [];
    const seen = new Set<number>();
    for (const p of positions) if (!seen.has(p.product_id)) { seen.add(p.product_id); try { await this.transport.cancelAll(p.product_id); cancelled.push(p.product_id); } catch (e: any) { log.warn(`cancelAll ${p.symbol} failed: ${e?.message ?? e}`); } }
    for (const b of this.brackets.values()) if (!seen.has(b.product_id)) { seen.add(b.product_id); try { await this.transport.cancelAll(b.product_id); cancelled.push(b.product_id); } catch { /* ignore */ } }
    for (const b of this.brackets.values()) for (const l of [...(b.stop ? [b.stop] : []), ...b.tps]) this.ledger.cancelled(l.ledgerId, 'close-all');
    this.brackets.clear();
    const closed: Array<{ symbol: string; size: number; order: unknown }> = [];
    for (const p of positions) {
      if (!p.size) continue;
      const payload: OrderPayload = { product_id: p.product_id, size: Math.abs(Math.round(p.size)), side: p.size > 0 ? 'sell' : 'buy', order_type: 'market_order', reduce_only: true, client_order_id: cid(0, 'closeall'), purpose: 'close-all' };
      const sent = await this.send(payload, 0, p.symbol);
      closed.push({ symbol: p.symbol, size: p.size, order: { id: sent.row.exchangeId, state: sent.row.state, error: sent.error } });
      log.error(`CLOSE-ALL ${p.symbol} ${payload.side} ${payload.size} → ${sent.row.state} ${sent.row.exchangeId ?? ''} ${sent.error ?? ''}`);
    }
    return { closed, cancelled, dryRun: this.transport.dryRun };
  }

  status() {
    return {
      mode: this.mode, host: this.transport.host, baseUrl: this.transport.baseUrl, hasKeys: this.transport.hasAuth, dryRun: this.transport.dryRun,
      bracket: this.bracketEnabled, products: this.products.size, brackets: [...this.brackets.values()].map(b => ({ positionId: b.positionId, symbol: b.symbol, stop: b.stop, tps: b.tps })),
      unconfirmed: [...this.unconfirmed.keys()], lastReconcile: this.lastReconcile, lastRecovery: this.lastRecovery, ledger: this.ledger.recent(50),
      dryRunLog: this.transport instanceof DryRunTransport ? this.transport.log.slice(-50) : undefined,
    };
  }
}

let cidSeq = 0;
function cid(positionId: number, reason: string): string { return `${CID_PREFIX}${positionId}-${reason}-${Date.now().toString(36)}${(cidSeq++ % 1296).toString(36).padStart(2, '0')}`.slice(0, 40); }

/** Build the executor for the configured mode; null in plain `paper` mode. Reads keys from the environment (demo keys only). */
export function createExecutor(paper: PaperEngine, cfgRef: () => AppConfig, env: NodeJS.ProcessEnv = process.env): ExchangeExecutor | null {
  const x = cfgRef().execution;
  if (x.mode === 'paper') return null;
  const host = resolveHost(x, env);
  const hasKeys = Boolean(env.DELTA_API_KEY && env.DELTA_API_SECRET);
  if (x.mode === 'dry-run') {
    const reader = hasKeys ? new RestTransport(host, { apiKey: env.DELTA_API_KEY, apiSecret: env.DELTA_API_SECRET }) : new RestTransport(host, {});
    log.warn(`execution.mode=dry-run on ${host}: order payloads are logged, nothing is sent${hasKeys ? ' (keys used for read-only reconciliation)' : ''}`);
    return new ExchangeExecutor(paper, cfgRef, new DryRunTransport(reader, host));
  }
  if (!hasKeys) { log.warn('execution.mode=testnet but DELTA_API_KEY/DELTA_API_SECRET are not set: falling back to dry-run'); return new ExchangeExecutor(paper, cfgRef, new DryRunTransport(new RestTransport(host, {}), host)); }
  log.warn(`execution.mode=testnet: paper fills will be mirrored to the Delta India ${host.toUpperCase()} account`);
  return new ExchangeExecutor(paper, cfgRef, new RestTransport(host, { apiKey: env.DELTA_API_KEY, apiSecret: env.DELTA_API_SECRET }));
}

export { ExchangeExecutor as TestnetExecutor };
