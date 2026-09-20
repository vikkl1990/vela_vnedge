import { ConfigStore, type AppConfig } from './config.ts';
import { CandleStore } from './data/candleStore.ts';
import { Db } from './db.ts';
import { DeltaRest } from './delta/rest.ts';
import { DeltaFeed } from './delta/ws.ts';
import { logger } from './log.ts';
import { PaperEngine } from './paper/engine.ts';
import { PinePool } from './pine/pool.ts';
import { ScannerEngine } from './scanners/engine.ts';
import { ScannerRegistry } from './scanners/registry.ts';
import { TestnetExecutor } from './execution/testnet.ts';
import { MlService } from './ml/service.ts';

const log = logger.scoped('app');

/** Composition root: wires feed → candles → scanners → paper engine, plus the optional testnet mirror. */
export class App {
  readonly startedAt = Date.now();
  readonly config = new ConfigStore();
  readonly db = new Db();
  readonly rest = new DeltaRest();
  readonly feed = new DeltaFeed();
  readonly candles: CandleStore;
  readonly pool: PinePool;
  readonly registry = new ScannerRegistry();
  readonly paper: PaperEngine;
  readonly ml: MlService;
  readonly scanners: ScannerEngine;
  readonly testnet: TestnetExecutor | null = null;
  lastError: string | null = null;
  private marketCache: { at: number; list: any[] } | null = null;
  /** Symbols actually scanned after resolving the universe (list / top N / all). */
  resolvedSymbols: string[] = [];

  constructor() {
    const cfg = () => this.config.get();
    this.candles = new CandleStore(this.rest, this.feed, cfg().historyBars + 50);
    this.pool = new PinePool(Number(process.env.VNEDGE_WORKERS) || undefined);
    this.paper = new PaperEngine(this.db, cfg);
    this.ml = new MlService(this.db, () => Object.fromEntries(this.registry.all().map(s => [s.id, s.name])));
    this.scanners = new ScannerEngine({ registry: this.registry, cfgRef: cfg, candles: this.candles, pool: this.pool, paper: this.paper, db: this.db, rest: this.rest, symbolsRef: () => this.resolvedSymbols, ml: this.ml, cfgStore: this.config });
    this.resolvedSymbols = cfg().symbols;
    // 1m candles drive paper fills for every open position
    this.candles.on('bar', (e: { symbol: string; tf: string; bar: any }) => { if (e.tf === '1m') this.paper.onBar(e.symbol, e.bar); });
    this.candles.on('closed', (e: { symbol: string; tf: string; bar: any }) => { if (e.tf === '1m') this.paper.onBar(e.symbol, e.bar); });
    this.feed.on('ticker', (t: { symbol: string; price: number }) => this.paper.setMark(t.symbol, t.price));
    this.feed.on('status', async (s: { connected: boolean }) => {
      if (s.connected) for (const t of this.candles.tracked()) { try { const n = await this.candles.resync(t.symbol, t.tf); if (n) log.info(`resynced ${t.symbol} ${t.tf}: ${n} bars`); } catch (e: any) { log.warn(`resync failed ${t.symbol} ${t.tf}: ${e?.message}`); } }
    });
    if (cfg().execution.mode === 'testnet' && process.env.DELTA_API_KEY && process.env.DELTA_API_SECRET) {
      this.testnet = new TestnetExecutor(this.paper, this.rest);
      log.warn('execution.mode=testnet: paper fills will be mirrored to the Delta India DEMO account');
    }
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
    // positions left behind by scanners that were removed while the server was down
    for (const p of this.paper.openPositions()) { const c = this.config.get().scanners[p.scannerId]; if (c?.hidden) { this.paper.closeManual(p.id, 'removed'); log.info(`closed stale position #${p.id} of removed scanner ${p.scannerId}`); } }
    await this.resolveUniverse();
    this.feed.subscribe('v2/ticker', this.resolvedSymbols);
    if (this.testnet) await this.testnet.start();
    // don't block the API on warm-up
    this.scanners.start().catch(e => { this.lastError = String(e?.message ?? e); log.error('scanner start failed', e); });
  }

  async onConfigChanged(): Promise<void> {
    const cfg = this.config.get();
    this.candles.setMaxBars(cfg.historyBars + 50);
    await this.resolveUniverse();
    this.feed.subscribe('v2/ticker', this.resolvedSymbols);
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

  scannerView(id: string) {
    const s = this.registry.get(id);
    if (!s) return null;
    const c = this.scanners.scannerConfig(id);
    const stats = this.paper.scannerStats(id);
    stats.signals = this.db.countSignals(id);
    stats.backtest = this.scanners.backtestSummary(id);
    return {
      id: s.id, name: s.name, author: s.author, file: s.file, url: s.url, status: s.status, reason: s.reason, category: s.category, enabled: this.scanners.isActive(s), hidden: Boolean(c.hidden),
      overlay: s.overlay, pineVersion: s.pineVersion, lines: s.lines, updated: s.updated, patches: s.patches,
      symbols: this.scanners.symbolsFor(id), timeframes: this.scanners.timeframesFor(id), exitMode: c.exitMode,
      lastRun: this.scanners.getLastRun(id), stats,
    };
  }

  scannerViews() { return this.registry.all().map(s => this.scannerView(s.id)); }

  async stop() {
    this.feed.stop();
    await this.pool.stop();
  }
}

export type { AppConfig };
