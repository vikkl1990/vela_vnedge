/**
 * Shadow paper accounts: two in-memory ledgers that mirror every live entry/exit signal through
 * the SAME fill functions as the live paper engine (`logic.ts`: resolveLevels, sizeContracts,
 * openPosition, applyLiveBar, applyScriptExit) on 1-minute bars, so the ML gate can be compared
 * against "no gate" without touching the live account:
 *   - `ungated`   takes every entry signal;
 *   - `ml-gated`  skips entries whose signal probability is below `validation.shadow.minProb`
 *                 (signals without a probability are taken — there is nothing to gate on).
 * Both ignore what the live engine did with the signal (rejections, consensus, max positions)
 * and apply their own limits, so the two curves differ only by the gate.
 *
 * Subscribes to the scanner engine's `signal` events and the candle store's 1m `bar`/`closed`
 * events; nothing here writes to the live tables. The ledger is snapshotted to the kv table so
 * it survives restarts.
 */
import { EventEmitter } from 'node:events';
import type { AppConfig } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';
import { lastAtr } from '../data/indicators.ts';
import type { Db, SignalRow } from '../db.ts';
import { logger } from '../log.ts';
import { tradeOf, type MarketInfo } from '../paper/engine.ts';
import { applyLiveBar, applyScriptExit, checkRiskVsFees, computeStats, fillExit, notionalOf, openPosition, resolveLevels, sizeContracts, unrealized, type Position, type PriceBar } from '../paper/logic.ts';
import type { ExitType } from '../scanners/extractor.ts';

const log = logger.scoped('shadow');

export type ShadowVariantId = 'ungated' | 'ml-gated';
export const SHADOW_VARIANTS: readonly ShadowVariantId[] = ['ungated', 'ml-gated'];

interface Variant {
  id: ShadowVariantId;
  open: Map<number, Position>;
  closed: Position[];
  nextId: number;
  /** Entries skipped by this variant's gate. */
  gated: number;
  /** Entries taken. */
  entries: number;
  rejected: Record<string, number>;
  curve: Array<{ at: number; equity: number }>;
}

interface Persisted {
  since: number; initialEquity: number;
  variants: Record<ShadowVariantId, { open: Position[]; closed: Position[]; nextId: number; gated: number; entries: number; rejected: Record<string, number>; curve: Array<{ at: number; equity: number }> }>;
}

export interface ShadowDeps {
  cfgRef: () => AppConfig;
  candles: { get(symbol: string, tf: string, opts?: { limit?: number; closedOnly?: boolean }): Bar[]; on(event: string, l: (...a: any[]) => void): unknown };
  signals: { on(event: 'signal', l: (sig: SignalRow) => void): unknown };
  marketInfo: (symbol: string) => Promise<MarketInfo>;
  db?: Db;
  now?: () => number;
}

const KV_KEY = 'shadow.ledger';

export class ShadowLedger extends EventEmitter {
  private deps: ShadowDeps;
  private variants = new Map<ShadowVariantId, Variant>();
  private marks = new Map<string, number>();
  private priceBars = new Map<string, PriceBar>();
  since: number;
  initialEquity: number;
  private now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: ShadowDeps) {
    super();
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.since = this.now();
    this.initialEquity = deps.cfgRef().paper.initialEquity;
    for (const id of SHADOW_VARIANTS) this.variants.set(id, this.blank(id));
    this.load();
  }

  private blank(id: ShadowVariantId): Variant { return { id, open: new Map(), closed: [], nextId: 1, gated: 0, entries: 0, rejected: {}, curve: [{ at: this.since, equity: this.initialEquity }] }; }

  /** Subscribe to live signals and 1m bars. */
  attach(): this {
    this.deps.signals.on('signal', (sig: SignalRow) => { this.queue = this.queue.then(() => this.onSignal(sig)).catch(e => log.warn(`signal failed: ${e?.message ?? e}`)); });
    const onBar = (e: { symbol: string; tf: string; bar: Bar }) => { if (e.tf === '1m') this.onBar(e.symbol, e.bar); };
    this.deps.candles.on('bar', onBar);
    this.deps.candles.on('closed', onBar);
    return this;
  }

  get enabled(): boolean { return this.deps.cfgRef().validation?.shadow?.enabled ?? true; }
  get minProb(): number { return this.deps.cfgRef().validation?.shadow?.minProb ?? 0.55; }

  reset() {
    this.since = this.now(); this.initialEquity = this.deps.cfgRef().paper.initialEquity;
    for (const id of SHADOW_VARIANTS) this.variants.set(id, this.blank(id));
    this.save();
    log.warn('shadow ledgers reset');
  }

  async onSignal(sig: SignalRow): Promise<void> {
    if (!this.enabled) return;
    if (sig.kind === 'entry' && (sig.side === 'long' || sig.side === 'short')) await this.onEntry(sig);
    else if (sig.kind === 'exit') this.onExit(sig);
  }

  private async onEntry(sig: SignalRow) {
    const cfg = this.deps.cfgRef();
    const paper = cfg.paper;
    const market = await this.deps.marketInfo(sig.symbol);
    const bars = this.deps.candles.get(sig.symbol, sig.tf, { closedOnly: true, limit: 200 });
    const atr = bars.length ? lastAtr(bars, 14) : undefined;
    const refPrice = this.marks.get(sig.symbol) ?? bars.at(-1)?.close ?? sig.price ?? 0;
    const price = sig.price && sig.price > 0 ? sig.price : refPrice;
    const side = sig.side as 'long' | 'short';
    const at = sig.at;
    for (const v of this.variants.values()) {
      if (v.id === 'ml-gated' && sig.mlProb !== null && sig.mlProb !== undefined && sig.mlProb < this.minProb) { v.gated++; continue; }
      const existing = [...v.open.values()].find(p => p.scannerId === sig.scannerId && p.symbol === sig.symbol && p.tf === sig.tf);
      if (existing) {
        if (existing.side === side) { v.rejected['already_open'] = (v.rejected['already_open'] ?? 0) + 1; continue; }
        if (!paper.allowReversal) { v.rejected['reversal_disabled'] = (v.rejected['reversal_disabled'] ?? 0) + 1; continue; }
        fillExit(existing, price, existing.qtyOpen, 'reversal', at, paper, true);
        this.finish(v, existing);
      }
      if (v.open.size >= paper.maxOpenPositions) { v.rejected['max_open'] = (v.rejected['max_open'] ?? 0) + 1; continue; }
      const lv = resolveLevels({ side, price, sl: sig.sl ?? undefined, tp: sig.tp, atr }, paper, market.tickSize);
      if ('error' in lv) { v.rejected[lv.error] = (v.rejected[lv.error] ?? 0) + 1; continue; }
      if (checkRiskVsFees(price, lv.sl, paper)) { v.rejected['stop too tight for fees'] = (v.rejected['stop too tight for fees'] ?? 0) + 1; continue; }
      const openNotional = [...v.open.values()].reduce((a, p) => a + notionalOf(p), 0);
      const reserved = [...v.open.values()].reduce((a, p) => a + notionalOf(p) / (p.marginLeverage || p.leverage || paper.maxLeverage), 0);
      const eq = this.equity(v);
      const score = sig.score ?? (cfg.ml.useAsScore && sig.mlProb !== null && sig.mlProb !== undefined ? sig.mlProb * 100 : undefined);
      const sz = sizeContracts(price, lv.sl, { equity: eq, availableMargin: this.initialEquity + this.realized(v) - reserved, contractValue: market.contractValue, tickSize: market.tickSize, cfg: paper }, openNotional, score);
      if (sz.qty < 1) { v.rejected[sz.reason ?? 'size'] = (v.rejected[sz.reason ?? 'size'] ?? 0) + 1; continue; }
      const pos = openPosition({ id: v.nextId++, scannerId: sig.scannerId, scannerName: sig.scannerName, symbol: sig.symbol, tf: sig.tf, side, qty: sz.qty, contractValue: market.contractValue, entryPrice: price, at, sl: lv.sl, tp: lv.tp, riskAmount: sz.riskAmount, levelsSource: lv.source, signalId: sig.id, cfg: paper, bt: false, leverage: sz.leverage, marginLeverage: sz.marginLeverage, mlProb: sig.mlProb ?? null, lastPriceBar: this.priceBars.get(sig.symbol) });
      v.open.set(pos.id, pos);
      v.entries++;
      this.emit('position', { variant: v.id, type: 'opened', position: pos });
    }
    this.save();
  }

  private onExit(sig: SignalRow) {
    const paper = this.deps.cfgRef().paper;
    const exitMode = this.deps.cfgRef().scanners[sig.scannerId]?.exitMode ?? 'both';
    const m = String(sig.label).match(/TP\s?(\d)/i);
    const exitType: ExitType = m ? (`tp${m[1]}` as ExitType) : /BE\b/i.test(sig.label) ? 'be' : /SL|STOP/i.test(sig.label) ? 'sl' : /REVERSAL|FLIP/i.test(sig.label) ? 'flip' : 'close';
    let changed = false;
    for (const v of this.variants.values()) {
      const pos = [...v.open.values()].find(p => p.scannerId === sig.scannerId && p.symbol === sig.symbol && p.tf === sig.tf);
      if (!pos || (sig.side && pos.side !== sig.side)) continue;
      const fallback = sig.price ?? this.marks.get(sig.symbol) ?? pos.entryPrice;
      const fills = applyScriptExit(pos, exitType, sig.price ?? undefined, sig.at, paper, exitMode, fallback);
      if (fills.length) { changed = true; if (pos.status === 'closed') this.finish(v, pos); }
    }
    if (changed) this.save();
  }

  onBar(symbol: string, bar: PriceBar, observedAt = this.now()) {
    if (bar.time < (this.priceBars.get(symbol)?.time ?? -Infinity)) return;
    this.priceBars.set(symbol, { ...bar });
    this.marks.set(symbol, bar.close);
    if (!this.enabled) return;
    const paper = this.deps.cfgRef().paper;
    let closed = false;
    for (const v of this.variants.values()) {
      for (const pos of [...v.open.values()]) {
        if (pos.symbol !== symbol) continue;
        const fills = applyLiveBar(pos, bar, paper, observedAt);
        if (fills.length && pos.status === 'closed') { this.finish(v, pos); closed = true; }
      }
    }
    if (closed) this.save();
  }

  private finish(v: Variant, pos: Position) {
    v.open.delete(pos.id);
    v.closed.push(pos);
    if (v.closed.length > 3000) v.closed.splice(0, v.closed.length - 3000);
    v.curve.push({ at: pos.exitAt ?? this.now(), equity: this.initialEquity + this.realized(v) });
    if (v.curve.length > 5000) v.curve.splice(0, v.curve.length - 5000);
    this.emit('trade', { variant: v.id, trade: tradeOf(pos) });
    log.info(`[${v.id}] CLOSE ${pos.side} ${pos.symbol} ${pos.exitReason} pnl ${(pos.realizedPnl - pos.fees).toFixed(2)} [${pos.scannerId}]`);
  }

  private realized(v: Variant): number { return v.closed.reduce((a, p) => a + p.realizedPnl - p.fees, 0) + [...v.open.values()].reduce((a, p) => a + p.realizedPnl - p.fees, 0); }
  private unrealized(v: Variant): number { let u = 0; for (const p of v.open.values()) { const m = this.marks.get(p.symbol); if (m) u += unrealized(p, m); } return u; }
  private equity(v: Variant): number { return this.initialEquity + this.realized(v) + this.unrealized(v); }

  /** Everything the dashboard needs to compare the variants. */
  snapshot() {
    const variants: Record<string, any> = {};
    for (const v of this.variants.values()) {
      const s: any = computeStats(v.closed, this.initialEquity);
      if (s.profitFactor === Infinity) s.profitFactor = 999;
      const stats = { ...s, expectancy: s.expectancy ?? null };
      variants[v.id] = {
        equity: this.equity(v), realizedPnl: this.realized(v), unrealizedPnl: this.unrealized(v), openPositions: v.open.size, entries: v.entries, gated: v.gated, rejected: v.rejected,
        stats, curve: v.curve.slice(-500), trades: v.closed.slice(-100).reverse().map(tradeOf),
        open: [...v.open.values()].map(p => ({ id: p.id, scannerId: p.scannerId, symbol: p.symbol, tf: p.tf, side: p.side, qty: p.qty, qtyOpen: p.qtyOpen, entryPrice: p.entryPrice, entryAt: p.entryAt, sl: p.sl, tp: p.tp, tpHit: p.tpHit, mlProb: p.mlProb ?? null, unrealizedPnl: unrealized(p, this.marks.get(p.symbol) ?? p.entryPrice) })),
      };
    }
    const g = variants['ml-gated'], u = variants['ungated'];
    return {
      enabled: this.enabled, since: this.since, initialEquity: this.initialEquity, minProb: this.minProb, at: this.now(),
      variants,
      comparison: { equityDelta: g.equity - u.equity, pnlDelta: g.realizedPnl - u.realizedPnl, tradesDelta: g.stats.trades - u.stats.trades, gatedEntries: g.gated, leader: g.equity > u.equity ? 'ml-gated' : g.equity < u.equity ? 'ungated' : 'tie' },
    };
  }

  private save() {
    if (!this.deps.db) return;
    const variants: any = {};
    for (const v of this.variants.values()) variants[v.id] = { open: [...v.open.values()], closed: v.closed.slice(-3000), nextId: v.nextId, gated: v.gated, entries: v.entries, rejected: v.rejected, curve: v.curve.slice(-5000) };
    try { this.deps.db.kvSet(KV_KEY, { since: this.since, initialEquity: this.initialEquity, variants } satisfies Persisted); } catch (e: any) { log.warn(`persist failed: ${e?.message ?? e}`); }
  }

  private load() {
    const saved = this.deps.db?.kvGet<Persisted>(KV_KEY);
    if (!saved) return;
    this.since = saved.since; this.initialEquity = saved.initialEquity;
    for (const id of SHADOW_VARIANTS) {
      const p = saved.variants?.[id]; if (!p) continue;
      const v = this.blank(id);
      for (const pos of p.open ?? []) v.open.set(pos.id, pos);
      v.closed = p.closed ?? []; v.nextId = p.nextId ?? 1; v.gated = p.gated ?? 0; v.entries = p.entries ?? 0; v.rejected = p.rejected ?? {}; v.curve = p.curve?.length ? p.curve : v.curve;
      this.variants.set(id, v);
    }
    log.info(`loaded shadow ledgers: ${SHADOW_VARIANTS.map(id => `${id} ${this.variants.get(id)!.closed.length} trades/${this.variants.get(id)!.open.size} open`).join(', ')}`);
  }
}
