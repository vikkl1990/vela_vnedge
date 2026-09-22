import { lastAtr } from './data/indicators.ts';
import { ConfigStore, DATA_DIR, type AppConfig } from './config.ts';
import { CandleStore } from './data/candleStore.ts';
import { Db } from './db.ts';
import { DeltaRest } from './delta/rest.ts';
import { DeltaFeed, type WsTicker } from './delta/ws.ts';
import { logger } from './log.ts';
import { PaperEngine } from './paper/engine.ts';
import { PinePool } from './pine/pool.ts';
import { ScannerEngine } from './scanners/engine.ts';
import { ScannerRegistry } from './scanners/registry.ts';
import { createExecutor, type ExchangeExecutor } from './execution/testnet.ts';
import { subscribeRealtime, wireRealtime } from './execution/wiring.ts';
import { MarkStore } from './data/marks.ts';
import { RiskManager } from './risk/manager.ts';
import { MlService } from './ml/service.ts';
import { OpsService } from './ops/service.ts';
import { WorkerTracker } from './ops/workers.ts';

const log = logger.scoped('app');

/** Optional replacements for the network/file-backed collaborators (integration tests inject recorded feeds). */
export interface AppDeps {
  rest?: DeltaRest;
  feed?: DeltaFeed;
  registry?: ScannerRegistry;
  /** Replaces the Telegram transport for alerts. */
  alertTransport?: (text: string) => Promise<void>;
}

/** Composition root: wires feed → candles → scanners → paper engine, plus the optional testnet mirror. */
export class App {
  readonly startedAt = Date.now();
  readonly config = new ConfigStore();
  readonly db = new Db();
  readonly rest: DeltaRest;
  readonly feed: DeltaFeed;
  readonly candles: CandleStore;
  readonly pool: PinePool;
  readonly registry: ScannerRegistry;
  readonly paper: PaperEngine;
  readonly ml: MlService;
  readonly scanners: ScannerEngine;
  readonly marks = new MarkStore();
  readonly risk: RiskManager;
  readonly executor: ExchangeExecutor | null = null;
  readonly ops: OpsService;
  lastError: string | null = null;
  private marketCache: { at: number; list: any[] } | null = null;
  /** Symbols actually scanned after resolving the universe (list / top N / all). */
  resolvedSymbols: string[] = [];

  constructor(deps: AppDeps = {}) {
    const cfg = () => this.config.get();
    this.rest = deps.rest ?? new DeltaRest();
    this.feed = deps.feed ?? new DeltaFeed();
    this.registry = deps.registry ?? new ScannerRegistry();
    this.candles = new CandleStore(this.rest, this.feed, cfg().historyBars + 50);
    const workers = new WorkerTracker();
    this.pool = new PinePool(Number(process.env.VNEDGE_WORKERS) || undefined, undefined, workers.factory);
    this.paper = new PaperEngine(this.db, cfg);
    this.paper.atrFor = (symbol, tf) => lastAtr(this.candles.get(symbol, tf, { closedOnly: true, limit: 60 }), 14);
    this.ml = new MlService(this.db, () => Object.fromEntries(this.registry.all().map(s => [s.id, s.name])));
    this.scanners = new ScannerEngine({ registry: this.registry, cfgRef: cfg, candles: this.candles, pool: this.pool, paper: this.paper, db: this.db, rest: this.rest, symbolsRef: () => this.resolvedSymbols, ml: this.ml, cfgStore: this.config });
    this.resolvedSymbols = cfg().symbols;
    // 1m candles drive paper fills for every open position
    // `historical` marks bars that a resync or gap fill pulled from REST: they describe the past,
    // so they must not fill new entries or move the live mark (audit: current-time fills from old candles)
    this.candles.on('bar', (e: { symbol: string; tf: string; bar: any; historical?: boolean }) => { if (e.tf === '1m') this.paper.onBar(e.symbol, e.bar, Date.now(), { historical: e.historical === true }); });
    this.candles.on('closed', (e: { symbol: string; tf: string; bar: any; historical?: boolean }) => { if (e.tf === '1m') this.paper.onBar(e.symbol, e.bar, Date.now(), { historical: e.historical === true }); });
    this.feed.on('ticker', (t: WsTicker) => { this.paper.setMark(t.symbol, t.price); this.marks.onWsTicker(t); });
    this.feed.on('status', async (s: { connected: boolean }) => {
      if (s.connected) for (const t of this.candles.tracked()) { try { const n = await this.candles.resync(t.symbol, t.tf); if (n) log.info(`resynced ${t.symbol} ${t.tf}: ${n} bars`); } catch (e: any) { log.warn(`resync failed ${t.symbol} ${t.tf}: ${e?.message}`); } }
    });
    this.risk = new RiskManager({ db: this.db, paper: this.paper, candles: this.candles, cfgRef: cfg });
    this.paper.risk = this.risk;
    this.executor = createExecutor(this.paper, cfg);
    wireRealtime(this);
    this.ops = new OpsService({ cfg, onConfigChange: l => this.config.onChange(l), db: this.db, dataDir: DATA_DIR, feed: this.feed, pool: this.pool, paper: this.paper, marks: this.marks, candles: this.candles, scanners: this.scanners, workers, transport: deps.alertTransport });
    process.on('unhandledRejection', (e: any) => { this.lastError = String(e?.message ?? e); log.error('unhandled rejection', this.lastError); });
    process.on('uncaughtException', (e: any) => { this.lastError = String(e?.message ?? e); log.error('uncaught exception', e?.stack ?? e); });
  }

  /** Resolve the configured universe to concrete Delta symbols. */
  async resolveUniverse(): Promise<string[]> {
    const cfg = this.config.get();
    const u = cfg.universe ?? { mode: 'list', top: 20, exclude: [] };
    let out: string[];
    if (u.mode === 'list') out = cfg.symbols;
    else {
      try {
        const markets = await this.markets(); // sorted by 24h turnover desc
        const ex = new Set((u.exclude ?? []).map(s => s.toUpperCase()));
        const live = markets.filter((m: any) => m.markPrice > 0 && !ex.has(String(m.symbol).toUpperCase())).map((m: any) => String(m.symbol));
        out = u.mode === 'all' ? live : live.slice(0, u.top);
      } catch (e: any) {
        log.warn(`universe resolve failed (${e?.message ?? e}); falling back to symbol list`);
        out = cfg.symbols;
      }
    }
    if (!out.length) out = cfg.symbols;
    const runnable = this.registry.all().filter(s => this.scanners.isActive(s)).length;
    const runs = runnable * out.length * cfg.timeframes.length;
    if (runs > 2000) log.warn(`universe ${u.mode}: ${out.length} symbols × ${runnable} scanners × ${cfg.timeframes.length} tf = ${runs} script runs per bar close — expect several minutes per cycle with ${this.pool.size} workers`);
    this.resolvedSymbols = out;
    return out;
  }

  async start(): Promise<void> {
    this.feed.start();
    // positions of removed scanners keep running to their levels (the engine manages exits regardless of scanner state)
    await this.resolveUniverse();
    this.feed.subscribe('v2/ticker', this.resolvedSymbols);
    subscribeRealtime(this);
    if (this.executor) await this.executor.start();
    this.ops.start();
    // don't block the API on warm-up
    this.scanners.start().catch(e => { this.lastError = String(e?.message ?? e); log.error('scanner start failed', e); });
  }

  async onConfigChanged(): Promise<void> {
    const cfg = this.config.get();
    this.candles.setMaxBars(cfg.historyBars + 50);
    await this.resolveUniverse();
    this.feed.subscribe('v2/ticker', this.resolvedSymbols);
    subscribeRealtime(this);
    await this.scanners.refresh();
  }

  health() {
    const cfg = this.config.get();
    const all = this.registry.all();
    return {
      status: 'ok', uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000), mode: cfg.execution.mode, now: Date.now(),
      feed: { connected: this.feed.connected, lastTickAt: this.feed.lastTickAt, subscriptions: this.feed.subscriptions },
      candles: this.candles.tracked(),
      scanners: { total: all.length, runnable: all.filter(s => s.status === 'ok').length, enabled: all.filter(s => this.scanners.isActive(s)).length },
      universe: { mode: cfg.universe?.mode ?? 'list', symbols: this.resolvedSymbols.length, list: this.resolvedSymbols.slice(0, 50) },
      worker: this.pool.stats, lastError: this.lastError,
      ...this.ops.status(),
    };
  }

  async markets() {
    if (this.marketCache && Date.now() - this.marketCache.at < 30_000) return this.marketCache.list;
    const tickers = await this.rest.tickers();
    const list = tickers.filter(t => t.contract_type === 'perpetual_futures' || !t.contract_type).map(t => ({
      symbol: t.symbol, description: t.description ?? t.symbol, tickSize: Number(t.tick_size ?? 0), contractValue: Number(t.contract_value ?? 0),
      markPrice: Number(t.mark_price ?? t.close), price: Number(t.close ?? t.mark_price), change24hPct: Number(t.mark_change_24h ?? 0), volume24h: Number(t.turnover_usd ?? 0),
    })).sort((a, b) => b.volume24h - a.volume24h);
    this.marketCache = { at: Date.now(), list };
    return list;
  }

  /** Pre-grouped lookups so building the whole scanner list is linear rather than quadratic. */
  private scannerViewIndex() {
    return {
      closed: this.paper.closedByScanner(),
      open: this.paper.openCountByScanner(),
      signals: this.db.countSignalsByScanner(),
      backtests: this.scanners.backtestsByScanner(),
      lastRun: this.scanners.lastRunByScanner(),
    };
  }

  scannerView(id: string, idx?: ReturnType<App['scannerViewIndex']>) {
    const s = this.registry.get(id);
    if (!s) return null;
    const c = this.scanners.scannerConfig(id);
    const stats = idx ? this.paper.scannerStats(id, { closed: idx.closed, open: idx.open }) : this.paper.scannerStats(id);
    stats.signals = idx ? (idx.signals.get(id) ?? 0) : this.db.countSignals(id);
    stats.backtest = idx ? this.scanners.backtestSummary(id, idx.backtests) : this.scanners.backtestSummary(id);
    return {
      id: s.id, name: s.name, author: s.author, file: s.file, url: s.url, status: s.status, reason: s.reason, category: s.category, enabled: this.scanners.isActive(s), hidden: Boolean(c.hidden),
      overlay: s.overlay, pineVersion: s.pineVersion, lines: s.lines, updated: s.updated, patches: s.patches,
      symbols: this.scanners.symbolsFor(id), timeframes: this.scanners.timeframesFor(id), exitMode: c.exitMode,
      lastRun: idx ? (idx.lastRun.get(id) ?? null) : this.scanners.getLastRun(id), stats,
    };
  }

  scannerViews() { const idx = this.scannerViewIndex(); return this.registry.all().map(s => this.scannerView(s.id, idx)); }

  /**
   * The fields the header, dropdowns and pickers actually read. The full view carries per-scanner
   * stats and symbol lists for ~2000 scripts, which is about a hundred times more than a name
   * lookup needs; pages that only resolve names ask for this instead.
   */
  scannerIndex() {
    const lastRun = this.scanners.lastRunByScanner();
    return this.registry.all().map(s => {
      const c = this.scanners.scannerConfig(s.id);
      // `overlay` drives the chart picker and `lastRunError` the fleet error count; both are needed
      // by pages that otherwise only resolve names, and both are a few bytes rather than a stats block
      return { id: s.id, name: s.name, status: s.status, category: s.category, enabled: this.scanners.isActive(s), hidden: Boolean(c.hidden), overlay: s.overlay, lastRunError: lastRun.get(s.id)?.error ?? null };
    });
  }

  /**
   * Did the fills cost what the backtest assumed?
   *
   * Every live fill stores the top of book at that instant. `assumedBps` is what the simulation
   * charged; `observedHalfSpreadBps` is half the quoted spread, which is what crossing it really
   * costs. Their difference, multiplied by two for the round trip and divided by the average stop
   * distance, is the error in R per trade — and the edge is about 0.2R, so this is the number that
   * decides whether the backtest transfers.
   */
  fillQuality(limit = 500) {
    const rows = this.db.all<any>(
      'SELECT * FROM orders WHERE bt=0 AND bid IS NOT NULL AND ask IS NOT NULL ORDER BY at DESC LIMIT ?', limit);
    const assumedBps = this.config.get().paper.slippageBps;
    const bySymbol = new Map<string, { n: number; spread: number; slip: number; quoted: number }>();
    let spreadSum = 0, slipSum = 0, quoted = 0;
    const recent: any[] = [];
    for (const r of rows) {
      const mid = (r.bid + r.ask) / 2;
      if (!(mid > 0)) continue;
      const halfSpreadBps = (r.ask - r.bid) / 2 / mid * 10_000;
      // what this fill actually gave up against the mid, signed so positive always means worse
      const dir = r.side === 'buy' ? 1 : -1;
      const slipBps = ((r.price - mid) / mid) * 10_000 * dir;
      spreadSum += halfSpreadBps; slipSum += slipBps;
      if (r.price_source === 'quote') quoted++;
      const e = bySymbol.get(r.symbol) ?? { n: 0, spread: 0, slip: 0, quoted: 0 };
      e.n++; e.spread += halfSpreadBps; e.slip += slipBps; if (r.price_source === 'quote') e.quoted++;
      bySymbol.set(r.symbol, e);
      if (recent.length < 25) recent.push({ at: r.at, symbol: r.symbol, side: r.side, reason: r.reason, price: r.price, bid: r.bid, ask: r.ask, halfSpreadBps: +halfSpreadBps.toFixed(2), slipBps: +slipBps.toFixed(2), source: r.price_source });
    }
    const n = rows.length || 1;
    const avgSpread = spreadSum / n, avgSlip = slipSum / n;
    const avgStopPct = this.db.get<{ v: number }>(
      "SELECT AVG(ABS(entry_price - sl_original) / entry_price) v FROM positions WHERE bt=0 AND sl_original IS NOT NULL AND entry_price > 0")?.v ?? 0;
    const stopBps = avgStopPct * 10_000;
    const errorBps = (avgSpread - assumedBps) * 2;   // round trip
    return {
      fills: rows.length,
      assumedBps,
      observedHalfSpreadBps: +avgSpread.toFixed(2),
      modelledSlipBps: +avgSlip.toFixed(2),
      quotedShare: rows.length ? +(quoted / rows.length * 100).toFixed(0) : null,
      avgStopBps: +stopBps.toFixed(0),
      /** How wrong the assumption is, per trade, in R. Compare against an edge of roughly 0.2R. */
      errorRPerTrade: stopBps > 0 ? +(errorBps / stopBps).toFixed(3) : null,
      verdict: !rows.length ? 'no quoted fills yet'
        : avgSpread <= assumedBps ? 'the assumption is conservative: real spreads are tighter'
        : `real spreads are ${(avgSpread / Math.max(assumedBps, 0.01)).toFixed(1)}x the assumption`,
      bySymbol: [...bySymbol.entries()].map(([symbol, e]) => ({
        symbol, fills: e.n,
        halfSpreadBps: +(e.spread / e.n).toFixed(2),
        slipBps: +(e.slip / e.n).toFixed(2),
        quotedShare: +(e.quoted / e.n * 100).toFixed(0),
        worseThanAssumed: e.spread / e.n > assumedBps,
      })).sort((a, b) => b.halfSpreadBps - a.halfSpreadBps),
      recent,
    };
  }

  /** Cross-sectional analytics: pairs, scanners, scanner×pair matrix, exits and time-of-day, for backtest and live. */
  analytics() {
    type Agg = { trades: number; wins: number; pnl: number; gp: number; gl: number; fees: number };
    const mk = (): Agg => ({ trades: 0, wins: 0, pnl: 0, gp: 0, gl: 0, fees: 0 });
    const add = (a: Agg, pnl: number, fees: number) => { a.trades++; if (pnl > 0) { a.wins++; a.gp += pnl; } else a.gl += -pnl; a.pnl += pnl; a.fees += fees; };
    const fin = (a: Agg) => ({ trades: a.trades, wins: a.wins, winRatePct: a.trades ? a.wins / a.trades * 100 : 0, pnl: a.pnl, fees: a.fees, profitFactor: a.gl > 0 ? a.gp / a.gl : a.gp > 0 ? 999 : null });
    const names = Object.fromEntries(this.registry.all().map(s => [s.id, { name: s.name, author: s.author }]));
    const active = new Set(this.registry.all().filter(s => this.scanners.isActive(s)).map(s => s.id));
    // backtest side (enabled scanners on their configured symbols only)
    const btSym: Record<string, Agg> = {}, btSc: Record<string, Agg> = {}, btCell: Record<string, Agg> = {};
    for (const b of this.scanners.allBacktests()) {
      if (!active.has(b.id) || !this.scanners.symbolsFor(b.id).includes(b.symbol)) continue;
      for (const t of b.result.trades) {
        add(btSym[b.symbol] ??= mk(), t.pnl, t.fees ?? 0); add(btSc[b.id] ??= mk(), t.pnl, t.fees ?? 0); add(btCell[`${b.id}|${b.symbol}`] ??= mk(), t.pnl, t.fees ?? 0);
      }
    }
    // live side
    const trades = this.paper.trades({ limit: 5000 });
    const lvSym: Record<string, Agg> = {}, lvSc: Record<string, Agg> = {}, lvCell: Record<string, Agg> = {}, exits: Record<string, Agg> = {}, hours: Agg[] = Array.from({ length: 24 }, mk), dows: Agg[] = Array.from({ length: 7 }, mk);
    const btHours: Agg[] = Array.from({ length: 24 }, mk), btDows: Agg[] = Array.from({ length: 7 }, mk);
    for (const t of trades) {
      add(lvSym[t.symbol] ??= mk(), t.pnl, t.fees); add(lvSc[t.scannerId] ??= mk(), t.pnl, t.fees); add(lvCell[`${t.scannerId}|${t.symbol}`] ??= mk(), t.pnl, t.fees);
      add(exits[String(t.exitReason ?? 'unknown')] ??= mk(), t.pnl, t.fees);
      const d = new Date(t.entryAt); add(hours[d.getUTCHours()], t.pnl, t.fees); add(dows[d.getUTCDay()], t.pnl, t.fees);
    }
    for (const b of this.scanners.allBacktests()) { if (!active.has(b.id) || !this.scanners.symbolsFor(b.id).includes(b.symbol)) continue; for (const t of b.result.trades) { const d = new Date(t.entryAt); add(btHours[d.getUTCHours()], t.pnl, t.fees ?? 0); add(btDows[d.getUTCDay()], t.pnl, t.fees ?? 0); } }
    const open = this.paper.openPositions();
    const symbols = [...new Set([...Object.keys(btSym), ...Object.keys(lvSym)])].map(symbol => ({
      symbol, backtest: fin(btSym[symbol] ?? mk()), live: fin(lvSym[symbol] ?? mk()),
      scannersOn: [...active].filter(id => this.scanners.symbolsFor(id).includes(symbol)).length,
      profitableScanners: [...active].filter(id => (btCell[`${id}|${symbol}`]?.pnl ?? 0) > 0).length,
      openPositions: open.filter(p => p.symbol === symbol).length,
      unrealized: open.filter(p => p.symbol === symbol).reduce((a, p) => a + (this.paper.mark(p.symbol) ?? p.entryPrice) * 0 + ((this.paper.mark(p.symbol) ?? p.entryPrice) - p.entryPrice) * (p.side === 'long' ? 1 : -1) * p.contractValue * p.qtyOpen, 0),
    })).sort((a, b) => (b.live.pnl + b.backtest.pnl) - (a.live.pnl + a.backtest.pnl));
    const scanners = [...active].map(id => ({
      id, name: names[id]?.name ?? id, author: names[id]?.author ?? '', symbols: this.scanners.symbolsFor(id).length,
      backtest: fin(btSc[id] ?? mk()), live: fin(lvSc[id] ?? mk()), openPositions: open.filter(p => p.scannerId === id).length,
    })).sort((a, b) => (b.live.pnl + b.backtest.pnl) - (a.live.pnl + a.backtest.pnl));
    const matrix = Object.entries(btCell).map(([k, v]) => { const [id, symbol] = k.split('|'); const lv = lvCell[k]; return { scannerId: id, scannerName: names[id]?.name ?? id, symbol, backtest: fin(v), live: lv ? fin(lv) : null }; });
    for (const [k, v] of Object.entries(lvCell)) if (!btCell[k]) { const [id, symbol] = k.split('|'); matrix.push({ scannerId: id, scannerName: names[id]?.name ?? id, symbol, backtest: fin(mk()), live: fin(v) }); }
    return {
      at: Date.now(), symbols, scanners, matrix,
      exits: Object.entries(exits).map(([reason, a]) => ({ reason, ...fin(a) })).sort((a, b) => b.trades - a.trades),
      hours: hours.map((a, h) => ({ hour: h, live: fin(a), backtest: fin(btHours[h]) })),
      weekdays: dows.map((a, d) => ({ dow: d, live: fin(a), backtest: fin(btDows[d]) })),
      totals: { live: fin(trades.reduce((acc, t) => (add(acc, t.pnl, t.fees), acc), mk())), backtest: fin(Object.values(btSc).reduce((acc, a) => ({ trades: acc.trades + a.trades, wins: acc.wins + a.wins, pnl: acc.pnl + a.pnl, gp: acc.gp + a.gp, gl: acc.gl + a.gl, fees: acc.fees + a.fees }), mk())) },
    };
  }

  async stop() {
    this.executor?.stop();
    this.feed.stop();
    await this.pool.stop();
  }
}

export type { AppConfig };
