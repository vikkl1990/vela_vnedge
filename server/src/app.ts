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
  readonly scanners: ScannerEngine;
  readonly testnet: TestnetExecutor | null = null;
  lastError: string | null = null;
  private marketCache: { at: number; list: any[] } | null = null;

  constructor() {
    const cfg = () => this.config.get();
    this.candles = new CandleStore(this.rest, this.feed, cfg().historyBars + 50);
    this.pool = new PinePool(Number(process.env.VNEDGE_WORKERS) || undefined);
    this.paper = new PaperEngine(this.db, cfg);
    this.scanners = new ScannerEngine({ registry: this.registry, cfgRef: cfg, candles: this.candles, pool: this.pool, paper: this.paper, db: this.db, rest: this.rest });
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

  async start(): Promise<void> {
    this.feed.start();
    this.feed.subscribe('v2/ticker', this.config.get().symbols);
    if (this.testnet) await this.testnet.start();
    // don't block the API on warm-up
    this.scanners.start().catch(e => { this.lastError = String(e?.message ?? e); log.error('scanner start failed', e); });
  }

  async onConfigChanged(): Promise<void> {
    const cfg = this.config.get();
    this.candles.setMaxBars(cfg.historyBars + 50);
    this.feed.subscribe('v2/ticker', cfg.symbols);
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
      id: s.id, name: s.name, file: s.file, url: s.url, status: s.status, reason: s.reason, category: s.category, enabled: this.scanners.isActive(s),
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
