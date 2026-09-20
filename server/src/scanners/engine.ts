/**
 * Orchestrator: for every (scanner × symbol × timeframe) runs the Pine script on bar close,
 * extracts events, records signals, and hands entries/exits to the paper engine.
 */
import { EventEmitter } from 'node:events';
import type { AppConfig, ScannerConfig, ExitMode } from '../config.ts';
import { TF_SECONDS } from '../config.ts';
import type { CandleStore, Bar } from '../data/candleStore.ts';
import { lastAtr } from '../data/indicators.ts';
import type { Db } from '../db.ts';
import type { DeltaRest } from '../delta/rest.ts';
import { logger } from '../log.ts';
import type { PaperEngine, MarketInfo } from '../paper/engine.ts';
import { runBacktest, type BacktestResult } from '../paper/backtest.ts';
import type { PinePool } from '../pine/pool.ts';
import type { WorkerResult } from '../pine/worker.ts';
import { extractEvents, type ScanEvent } from './extractor.ts';
import type { ScannerRegistry, LoadedScanner } from './registry.ts';

const log = logger.scoped('scanner');

export interface RunInfo { at: number; ms: number; symbol: string; tf: string; error: string | null; barTime: number | null }

interface Overlay { at: number; plots: WorkerResult['plots']; shapes: WorkerResult['shapes']; labels: WorkerResult['labels'] }

export class ScannerEngine extends EventEmitter {
  private registry: ScannerRegistry;
  private cfgRef: () => AppConfig;
  private candles: CandleStore;
  private pool: PinePool;
  private paper: PaperEngine;
  private db: Db;
  private rest: DeltaRest;
  private lastRun = new Map<string, RunInfo>();
  private overlays = new Map<string, Overlay>();
  private markets = new Map<string, MarketInfo>();
  private inFlight = new Set<string>();
  private backtests = new Map<string, BacktestResult>();
  private warmed = new Set<string>();

  constructor(deps: { registry: ScannerRegistry; cfgRef: () => AppConfig; candles: CandleStore; pool: PinePool; paper: PaperEngine; db: Db; rest: DeltaRest }) {
    super();
    Object.assign(this, deps);
    this.registry = deps.registry; this.cfgRef = deps.cfgRef; this.candles = deps.candles; this.pool = deps.pool; this.paper = deps.paper; this.db = deps.db; this.rest = deps.rest;
    for (const r of this.db.all<any>('SELECT * FROM scanner_runs')) this.lastRun.set(`${r.scanner_id}:${r.symbol}:${r.tf}`, { at: r.at, ms: r.ms, symbol: r.symbol, tf: r.tf, error: r.error, barTime: r.bar_time });
    for (const r of this.db.all<any>('SELECT * FROM backtests')) { try { this.backtests.set(`${r.scanner_id}:${r.symbol}:${r.tf}`, JSON.parse(r.result)); } catch { /* ignore */ } }
    this.candles.on('closed', (e: { symbol: string; tf: string; bar: Bar }) => this.onBarClosed(e.symbol, e.tf, e.bar));
  }

  // ---- configuration helpers ----

  scannerConfig(id: string): ScannerConfig {
    const cfg = this.cfgRef();
    return cfg.scanners[id] ?? { enabled: true, symbols: null, timeframes: null, exitMode: 'both' };
  }
  symbolsFor(id: string): string[] { return this.scannerConfig(id).symbols ?? this.cfgRef().symbols; }
  timeframesFor(id: string): string[] { return this.scannerConfig(id).timeframes ?? this.cfgRef().timeframes; }
  isActive(s: LoadedScanner): boolean { return s.status === 'ok' && this.scannerConfig(s.id).enabled; }

  /** All (symbol, tf) pairs any active scanner needs. */
  requiredSeries(): Array<{ symbol: string; tf: string }> {
    const set = new Map<string, { symbol: string; tf: string }>();
    for (const s of this.registry.all()) {
      if (!this.isActive(s)) continue;
      for (const symbol of this.symbolsFor(s.id)) for (const tf of this.timeframesFor(s.id)) set.set(`${symbol}:${tf}`, { symbol, tf });
    }
    return [...set.values()];
  }

  async marketInfo(symbol: string): Promise<MarketInfo> {
    let m = this.markets.get(symbol);
    if (m) return m;
    const p = await this.rest.product(symbol);
    m = { contractValue: Number(p?.contract_value ?? 0.001), tickSize: Number(p?.tick_size ?? 0.5) };
    this.markets.set(symbol, m);
    return m;
  }

  getLastRun(id: string): RunInfo | null {
    let best: RunInfo | null = null;
    for (const [k, v] of this.lastRun) if (k.startsWith(id + ':') && (!best || v.at > best.at)) best = v;
    return best;
  }
  getOverlay(id: string, symbol: string, tf: string): Overlay | undefined { return this.overlays.get(`${id}:${symbol}:${tf}`); }
  getBacktest(id: string, symbol: string, tf: string): BacktestResult | undefined { return this.backtests.get(`${id}:${symbol}:${tf}`); }
  backtestSummary(id: string): BacktestResult['stats'] | null {
    const list = [...this.backtests.entries()].filter(([k]) => k.startsWith(id + ':')).map(([, v]) => v);
    if (!list.length) return null;
    // aggregate across symbols/timeframes
    const agg: any = { trades: 0, wins: 0, losses: 0, pnl: 0, fees: 0, grossProfit: 0, grossLoss: 0, maxDrawdownPct: 0, open: 0 };
    let rSum = 0, rN = 0;
    for (const b of list) { for (const k of ['trades', 'wins', 'losses', 'pnl', 'fees', 'grossProfit', 'grossLoss', 'open'] as const) agg[k] += (b.stats as any)[k] ?? 0; agg.maxDrawdownPct = Math.max(agg.maxDrawdownPct, b.stats.maxDrawdownPct); if (b.stats.avgR !== null) { rSum += b.stats.avgR * b.stats.trades; rN += b.stats.trades; } }
    agg.winRatePct = agg.trades ? agg.wins / agg.trades * 100 : 0;
    agg.profitFactor = agg.grossLoss > 0 ? agg.grossProfit / agg.grossLoss : (agg.grossProfit > 0 ? 999 : null);
    agg.avgR = rN ? rSum / rN : null; agg.expectancy = agg.avgR;
    agg.pnlPct = this.cfgRef().paper.initialEquity ? agg.pnl / this.cfgRef().paper.initialEquity * 100 : 0;
    agg.avgWin = agg.wins ? agg.grossProfit / agg.wins : 0; agg.avgLoss = agg.losses ? agg.grossLoss / agg.losses : 0;
    return agg;
  }

  // ---- lifecycle ----

  /** Track all needed candle series and warm every active scanner (backtest + first live run). */
  async start(): Promise<void> {
    const cfg = this.cfgRef();
    const required = this.requiredSeries();
    await Promise.all(required.map(r => this.candles.track(r.symbol, r.tf, cfg.historyBars)));
    for (const s of cfg.symbols) await this.candles.track(s, '1m', 300); // fill engine price feed
    const jobs: Promise<void>[] = [];
    for (const s of this.registry.all()) if (this.isActive(s)) for (const symbol of this.symbolsFor(s.id)) for (const tf of this.timeframesFor(s.id)) jobs.push(this.warm(s, symbol, tf));
    log.info(`warming ${jobs.length} scanner runs`);
    await Promise.allSettled(jobs);
    log.info('warm-up complete');
  }

  /** Called when config changed: subscribe new series, warm newly enabled scanners. */
  async refresh(): Promise<void> {
    const cfg = this.cfgRef();
    for (const r of this.requiredSeries()) if (!this.candles.has(r.symbol, r.tf)) await this.candles.track(r.symbol, r.tf, cfg.historyBars);
    for (const s of cfg.symbols) if (!this.candles.has(s, '1m')) await this.candles.track(s, '1m', 300);
    const jobs: Promise<void>[] = [];
    for (const s of this.registry.all()) if (this.isActive(s)) for (const symbol of this.symbolsFor(s.id)) for (const tf of this.timeframesFor(s.id)) {
      if (!this.warmed.has(`${s.id}:${symbol}:${tf}`)) jobs.push(this.warm(s, symbol, tf));
    }
    await Promise.allSettled(jobs);
  }

  /** Full-history run: backtest for stats + overlay; live signals only for the last closed bar. */
  private async warm(s: LoadedScanner, symbol: string, tf: string): Promise<void> {
    const key = `${s.id}:${symbol}:${tf}`;
    this.warmed.add(key);
    try {
      await this.runOnce(s, symbol, tf, { backtest: true, live: true });
    } catch (e: any) { log.error(`warm ${key} failed: ${e?.message ?? e}`); }
  }

  runNow(id: string): number {
    const s = this.registry.get(id);
    if (!s || s.status !== 'ok') return 0;
    let n = 0;
    for (const symbol of this.symbolsFor(id)) for (const tf of this.timeframesFor(id)) { n++; this.runOnce(s, symbol, tf, { backtest: true, live: true }).catch(e => log.error(`run ${id} failed: ${e?.message ?? e}`)); }
    return n;
  }

  async runBacktestNow(id: string, symbol: string, tf: string): Promise<BacktestResult | null> {
    const s = this.registry.get(id);
    if (!s || s.status !== 'ok') return null;
    await this.candles.track(symbol, tf, this.cfgRef().historyBars);
    await this.runOnce(s, symbol, tf, { backtest: true, live: false });
    return this.getBacktest(id, symbol, tf) ?? null;
  }

  private onBarClosed(symbol: string, tf: string, bar: Bar) {
    if (tf === '1m') return; // price feed only
    const active = this.registry.all().filter(s => this.isActive(s) && this.symbolsFor(s.id).includes(symbol) && this.timeframesFor(s.id).includes(tf));
    if (!active.length) return;
    log.info(`bar closed ${symbol} ${tf} @ ${new Date(bar.time).toISOString().slice(11, 16)} → running ${active.length} scanners`);
    for (const s of active) this.runOnce(s, symbol, tf, { backtest: false, live: true }).catch(e => log.error(`run ${s.id} ${symbol} ${tf} failed: ${e?.message ?? e}`));
  }

  // ---- the core run ----

  private async runOnce(s: LoadedScanner, symbol: string, tf: string, mode: { backtest: boolean; live: boolean }): Promise<void> {
    const key = `${s.id}:${symbol}:${tf}`;
    if (this.inFlight.has(key)) { log.debug(`skip ${key}: already running`); return; }
    this.inFlight.add(key);
    const at = Date.now();
    try {
      const bars = this.candles.get(symbol, tf, { closedOnly: true, limit: this.cfgRef().historyBars });
      if (bars.length < 50) throw new Error(`only ${bars.length} bars`);
      const market = await this.marketInfo(symbol);
      const res = await this.pool.run({ scannerId: s.id, source: s.patched, symbol, tf, tickSize: market.tickSize, bars, tailBars: mode.backtest ? 'all' : 3, plotTail: 400 });
      const info: RunInfo = { at, ms: res.ms, symbol, tf, error: res.ok ? null : res.error ?? 'unknown', barTime: bars.at(-1)!.time };
      this.lastRun.set(key, info);
      this.db.run('INSERT INTO scanner_runs(scanner_id, symbol, tf, at, ms, error, bar_time) VALUES (?,?,?,?,?,?,?) ON CONFLICT(scanner_id, symbol, tf) DO UPDATE SET at=excluded.at, ms=excluded.ms, error=excluded.error, bar_time=excluded.bar_time', s.id, symbol, tf, at, res.ms, info.error, info.barTime);
      if (!res.ok) { log.warn(`${key} error: ${res.error}`); this.emit('scanner', { id: s.id, lastRun: info }); return; }
      this.overlays.set(key, { at, plots: res.plots, shapes: res.shapes, labels: res.labels });

      const exitMode: ExitMode = this.scannerConfig(s.id).exitMode;
      if (mode.backtest) {
        const events = extractEvents(res.alerts, res.shapes);
        const bt = runBacktest({ scannerId: s.id, scannerName: s.name, symbol, tf, bars, events, cfg: this.cfgRef().paper, exitMode, contractValue: market.contractValue, tickSize: market.tickSize });
        this.backtests.set(key, bt);
        this.db.run('INSERT INTO backtests(scanner_id, symbol, tf, at, bars, result) VALUES (?,?,?,?,?,?) ON CONFLICT(scanner_id, symbol, tf) DO UPDATE SET at=excluded.at, bars=excluded.bars, result=excluded.result', s.id, symbol, tf, bt.at, bt.bars, JSON.stringify(bt));
        log.info(`backtest ${key}: ${bt.stats.trades} trades, win ${bt.stats.winRatePct.toFixed(0)}%, pnl ${bt.stats.pnl.toFixed(0)} (${res.ms}ms)`);
      }
      if (mode.live) {
        const lastBar = bars.at(-1)!;
        const events = extractEvents(res.alerts, res.shapes, { sinceBarTime: lastBar.time });
        for (const ev of events) this.handleLiveEvent(s, symbol, tf, ev, bars, market, exitMode, lastBar);
      }
      this.emit('scanner', { id: s.id, lastRun: info, stats: this.paper.scannerStats(s.id) });
    } finally {
      this.inFlight.delete(key);
    }
  }

  private handleLiveEvent(s: LoadedScanner, symbol: string, tf: string, ev: ScanEvent, bars: Bar[], market: MarketInfo, exitMode: ExitMode, lastBar: Bar) {
    if (this.db.signalExists(s.id, symbol, tf, ev.barTime, ev.kind, ev.side ?? null, ev.label)) return;
    const refPrice = this.paper.mark(symbol) ?? lastBar.close;
    const now = Date.now();
    let action = 'none'; let positionId: number | null = null;
    const levelsSource = ev.kind === 'entry' ? (ev.sl && ev.tp.length ? 'script' : ev.sl || ev.tp.length ? 'mixed' : 'atr-fallback') : null;
    const sigId = this.db.insertSignal({ at: now, barTime: ev.barTime, scannerId: s.id, scannerName: s.name, symbol, tf, kind: ev.kind, side: ev.side ?? null, price: ev.price ?? null, sl: ev.sl ?? null, tp: ev.tp, score: ev.score ?? null, label: ev.label, message: ev.message, source: ev.source, levelsSource, action, positionId });
    if (sigId === null) return;

    if (ev.kind === 'entry' && ev.side) {
      const d = this.paper.onEntry(ev, { scannerId: s.id, scannerName: s.name, symbol, tf, market, atr: lastAtr(bars, 14), refPrice, at: now, signalId: sigId, exitMode });
      action = d.action === 'opened' || d.action === 'reversed' ? d.action : `${d.action}:${d.reason ?? ''}`;
      positionId = d.position?.id ?? null;
    } else if (ev.kind === 'exit') {
      const pos = this.paper.onScriptExit(s.id, symbol, tf, ev.exitType ?? 'close', ev.price, now, exitMode, ev.side);
      action = pos ? (pos.status === 'closed' ? 'closed' : 'reduced') : 'ignored:no position';
      positionId = pos?.id ?? null;
    } else {
      action = 'info';
    }
    this.db.updateSignalAction(sigId, action, positionId);
    const sig = this.db.signalById(sigId);
    if (sig) { this.emit('signal', sig); log.info(`SIGNAL ${ev.kind} ${ev.side ?? ''} ${symbol} ${tf} ${ev.label} → ${action} [${s.id}]`); }
  }
}
