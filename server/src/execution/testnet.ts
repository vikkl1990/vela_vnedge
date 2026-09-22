/**
 * Exchange executor (phase 5): mirrors the paper account to the Delta Exchange India DEMO account.
 *
 *  - `execution.mode: 'dry-run'`  → every order payload is logged, nothing is sent (no keys needed).
 *  - `execution.mode: 'testnet'`  → sent to the demo host (needs DELTA_API_KEY / DELTA_API_SECRET, demo keys only).
 *  - Entries and discretionary exits (script exits, reversals, manual, risk-kill) go out as market orders,
 *    exits always reduce-only. With `execution.bracket` each paper entry also places exchange-side
 *    reduce-only stop-loss (market, mark-price trigger) and take-profit (limit) orders, replaced when the
 *    paper stop moves (break-even, partial fills) and cancelled when the position closes; level exits
 *    (sl/be/tp/liquidation) are then left to those resting orders and not mirrored as market orders.
 *  - A timer reconciles exchange positions and open orders with the paper book and logs drift.
 *  - `closeAll()` flattens the exchange account with reduce-only market orders (requires `confirm: true`).
 *
 * The production host can only be reached through `resolveHost()` (config flag AND env var), and the
 * transport then refuses everything but market orders with reduce-only exits — see execution/client.ts.
 */
import type { AppConfig } from '../config.ts';
import type { DeltaProduct } from '../delta/rest.ts';
import { logger } from '../log.ts';
import type { PaperEngine } from '../paper/engine.ts';
import type { Position } from '../paper/logic.ts';
import { DryRunTransport, RestTransport, resolveHost, type ExchangeTransport, type OrderPayload } from './client.ts';

const log = logger.scoped('execution');

/** Exit reasons handled by exchange-side bracket orders when brackets are enabled. */
const LEVEL_EXITS = new Set(['sl', 'be', 'tp1', 'tp2', 'tp3', 'liquidation']);

interface Bracket { positionId: number; symbol: string; product_id: number; stop: { id: number | string; price: number; size: number } | null; tps: Array<{ id: number | string; price: number; size: number; leg: number }>; }
export interface Drift { symbol: string; kind: 'size' | 'price' | 'orders' | 'orphan-position' | 'orphan-orders'; paper: number | string; exchange: number | string; detail: string }
export interface ReconcileReport { at: number; ok: boolean; drift: Drift[]; positions: number; orders: number; error?: string }

export interface ExecutorOptions { now?: () => number; reconcileSec?: number }

export class ExchangeExecutor {
  readonly transport: ExchangeTransport;
  private paper: PaperEngine;
  private cfgRef: () => AppConfig;
  private products = new Map<string, DeltaProduct>();
  private brackets = new Map<number, Bracket>();
  private lastSeen = new Map<number, { sl: number | null; qtyOpen: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private now: () => number;
  private reconcileSecOverride: number | undefined;
  lastReconcile: ReconcileReport | null = null;
  private queue: Promise<void> = Promise.resolve();
  private started = false;

  constructor(paper: PaperEngine, cfgRef: () => AppConfig, transport: ExchangeTransport, opts: ExecutorOptions = {}) {
    this.paper = paper; this.cfgRef = cfgRef; this.transport = transport;
    this.now = opts.now ?? (() => Date.now());
    this.reconcileSecOverride = opts.reconcileSec;
  }

  get mode(): AppConfig['execution']['mode'] { return this.cfgRef().execution.mode; }
  private get bracketEnabled(): boolean { return this.cfgRef().execution.bracket !== false; }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.loadProducts();
    if (this.transport.hasAuth) {
      try { const w = await this.transport.wallet(); log.info(`${this.transport.host} connected (${this.transport.dryRun ? 'dry-run writes' : 'live writes'}): ${Array.isArray(w) ? w.length : 0} wallet entries`); }
      catch (e: any) { log.error(`exchange init failed: ${e?.message ?? e}`); }
    } else log.warn(`execution ${this.mode} on ${this.transport.host}: no API keys → ${this.transport.dryRun ? 'payloads are logged only' : 'nothing can be sent'}`);
    this.paper.on('order', (o: any) => this.enqueue(() => this.onFill(o)));
    this.paper.on('position', (e: { type: string; position: Position }) => this.enqueue(() => this.onPosition(e)));
    const sec = this.reconcileSecOverride ?? this.cfgRef().execution.reconcileSec;
    if (sec > 0) this.timer = setInterval(() => { this.reconcile().catch(e => log.warn(`reconcile failed: ${e?.message ?? e}`)); }, sec * 1000);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn).catch(e => log.error(`execution step failed: ${e?.message ?? e}`));
    return this.queue;
  }
  /** Wait for queued order work (tests). */
  flush(): Promise<void> { return this.queue; }

  private async loadProducts() {
    try { this.products = await this.transport.products(); } catch (e: any) { log.error(`products failed: ${e?.message ?? e}`); }
  }
  private productId(symbol: string): number | null { const p = this.products.get(symbol); return p ? Number(p.id) : null; }

  // ---- paper → exchange ----

  private async onFill(o: { symbol: string; side: string; qty: number; reason: string; positionId: number; price: number }) {
    if (o.reason === 'funding' || !(o.qty > 0)) return;
    const product_id = this.productId(o.symbol);
    if (!product_id) { log.warn(`no ${this.transport.host} product for ${o.symbol}; fill not mirrored`); return; }
    const isEntry = o.reason === 'entry';
    // Leave a level exit to the exchange only when the order that would execute it was acknowledged.
    // A bracket whose stop or target was rejected protects nothing: that exit is sent at market.
    if (!isEntry && this.bracketEnabled && LEVEL_EXITS.has(o.reason) && this.bracketCovers(o.positionId, o.reason)) {
      log.info(`${o.symbol} ${o.reason} x${o.qty} left to the exchange bracket (not mirrored)`);
      return;
    }
    if (!isEntry && this.bracketEnabled && LEVEL_EXITS.has(o.reason) && this.brackets.has(o.positionId)) log.warn(`${o.symbol} ${o.reason}: no acknowledged exchange order covers it; sending a market exit`);
    const payload: OrderPayload = { product_id, size: Math.max(1, Math.round(o.qty)), side: o.side as 'buy' | 'sell', order_type: 'market_order', reduce_only: !isEntry, client_order_id: cid(o.positionId, o.reason), purpose: isEntry ? 'entry' : 'exit' };
    const res = await this.transport.placeOrder(payload);
    log.info(`${this.transport.host} ${o.side} ${payload.size} ${o.symbol} (${o.reason}) → order ${res.id} ${res.state ?? ''}`);
  }

  private async onPosition(e: { type: string; position: Position }) {
    const p = e.position;
    if (!this.bracketEnabled) return;
    if (e.type === 'opened') { this.lastSeen.set(p.id, { sl: p.sl, qtyOpen: p.qtyOpen }); await this.placeBracket(p); return; }
    if (e.type === 'closed') { await this.cancelBracket(p.id, 'position closed'); this.lastSeen.delete(p.id); return; }
    const seen = this.lastSeen.get(p.id);
    if (seen && seen.sl === p.sl && seen.qtyOpen === p.qtyOpen) return;
    this.lastSeen.set(p.id, { sl: p.sl, qtyOpen: p.qtyOpen });
    await this.replaceStop(p);
  }

  /** Whether an acknowledged exchange order exists for this exit: the stop for sl/be, the matching leg for tpN. */
  private bracketCovers(positionId: number, reason: string): boolean {
    const b = this.brackets.get(positionId);
    if (!b) return false;
    if (reason === 'sl' || reason === 'be') return b.stop !== null;
    const leg = Number(reason.match(/^tp(\d)$/)?.[1] ?? 0);
    return leg > 0 && b.tps.some(t => t.leg === leg);
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
    const b: Bracket = { positionId: p.id, symbol: p.symbol, product_id, stop: null, tps: [] };
    for (const o of this.bracketPayloads(p, product_id)) {
      try {
        const res = await this.transport.placeOrder(o);
        if (o.purpose === 'stop') b.stop = { id: res.id, price: Number(o.stop_price), size: o.size };
        else b.tps.push({ id: res.id, price: Number(o.limit_price), size: o.size, leg: Number(o.client_order_id?.match(/tp(\d)/)?.[1] ?? 0) });
      } catch (e: any) { log.error(`bracket ${o.purpose} for #${p.id} ${p.symbol} failed: ${e?.message ?? e}`); }
    }
    this.brackets.set(p.id, b);
    log.info(`bracket #${p.id} ${p.symbol}: stop ${b.stop?.price ?? '-'} x${b.stop?.size ?? 0}, tp ${b.tps.map(t => `${t.price}x${t.size}`).join(' ') || '-'}`);
  }

  /** Cancel and re-place the stop when the paper stop moved (break-even) or the open size changed (TP leg filled). */
  private async replaceStop(p: Position) {
    const b = this.brackets.get(p.id);
    if (!b) return;
    if (b.stop) { try { await this.transport.cancelOrder(b.stop.id, b.product_id); } catch (e: any) { log.warn(`cancel stop #${p.id} failed: ${e?.message ?? e}`); } b.stop = null; }
    if (p.status !== 'open' || p.sl === null || p.qtyOpen <= 0) return;
    const o = this.bracketPayloads(p, b.product_id).find(x => x.purpose === 'stop');
    if (!o) return;
    try { const res = await this.transport.placeOrder(o); b.stop = { id: res.id, price: Number(o.stop_price), size: o.size }; log.info(`stop #${p.id} ${p.symbol} → ${o.stop_price} x${o.size}${p.breakEven ? ' (break-even)' : ''}`); }
    catch (e: any) {
      log.error(`replace stop #${p.id} failed: ${e?.message ?? e}; the stop exit will be sent at market, and the next update retries`);
      this.lastSeen.delete(p.id);
    }
    // drop TP legs that the paper book already counts as filled
    b.tps = b.tps.filter(t => !p.tpHit[t.leg - 1]);
  }

  private async cancelBracket(positionId: number, why: string) {
    const b = this.brackets.get(positionId);
    if (!b) return;
    this.brackets.delete(positionId);
    const ids = [...(b.stop ? [b.stop.id] : []), ...b.tps.map(t => t.id)];
    for (const id of ids) { try { await this.transport.cancelOrder(id, b.product_id); } catch (e: any) { log.warn(`cancel order ${id} failed: ${e?.message ?? e}`); } }
    if (ids.length) log.info(`bracket #${positionId} ${b.symbol}: cancelled ${ids.length} order(s) (${why})`);
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
      // open orders vs expected bracket legs, per product
      const expected = new Map<number, number>();
      for (const b of this.brackets.values()) expected.set(b.product_id, (expected.get(b.product_id) ?? 0) + (b.stop ? 1 : 0) + b.tps.length);
      const actual = new Map<number, number>();
      for (const o of orders) actual.set(o.product_id, (actual.get(o.product_id) ?? 0) + 1);
      const symbolOf = (pid: number) => [...this.products.values()].find(p => Number(p.id) === pid)?.symbol ?? String(pid);
      for (const [pid, n] of expected) { const have = actual.get(pid) ?? 0; if (have !== n) drift.push({ symbol: symbolOf(pid), kind: 'orders', paper: n, exchange: have, detail: `expected ${n} bracket order(s), exchange has ${have}` }); }
      for (const [pid, n] of actual) if (!expected.has(pid)) drift.push({ symbol: symbolOf(pid), kind: 'orphan-orders', paper: 0, exchange: n, detail: `${n} open order(s) not placed by this bot` });
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
    this.brackets.clear();
    const closed: Array<{ symbol: string; size: number; order: unknown }> = [];
    for (const p of positions) {
      if (!p.size) continue;
      const payload: OrderPayload = { product_id: p.product_id, size: Math.abs(Math.round(p.size)), side: p.size > 0 ? 'sell' : 'buy', order_type: 'market_order', reduce_only: true, client_order_id: `vnedge-closeall-${Date.now()}`.slice(0, 40), purpose: 'close-all' };
      const order = await this.transport.placeOrder(payload);
      closed.push({ symbol: p.symbol, size: p.size, order });
      log.error(`CLOSE-ALL ${p.symbol} ${payload.side} ${payload.size} → ${JSON.stringify(order)}`);
    }
    return { closed, cancelled, dryRun: this.transport.dryRun };
  }

  status() {
    return {
      mode: this.mode, host: this.transport.host, baseUrl: this.transport.baseUrl, hasKeys: this.transport.hasAuth, dryRun: this.transport.dryRun,
      bracket: this.bracketEnabled, products: this.products.size, brackets: [...this.brackets.values()].map(b => ({ positionId: b.positionId, symbol: b.symbol, stop: b.stop, tps: b.tps })),
      lastReconcile: this.lastReconcile, dryRunLog: this.transport instanceof DryRunTransport ? this.transport.log.slice(-50) : undefined,
    };
  }
}

function cid(positionId: number, reason: string): string { return `vnedge-${positionId}-${reason}-${Date.now().toString(36)}`.slice(0, 40); }

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
