/**
 * Walk-forward validation service: runs every active scanner×symbol×timeframe over the deep
 * candle cache, persists the results (`walk_forward` table) and hands the OOS summaries to the
 * scanner engine's auto-tune.
 */
import type { AppConfig } from '../config.ts';
import { TF_SECONDS } from '../config.ts';
import type { CandleCache } from '../data/candleCache.ts';
import type { Db } from '../db.ts';
import { logger } from '../log.ts';
import { SIMULATION_VERSION } from '../paper/version.ts';
import type { PinePool } from '../pine/pool.ts';
import type { ScannerEngine } from '../scanners/engine.ts';
import { extractEvents } from '../scanners/extractor.ts';
import type { LoadedScanner, ScannerRegistry } from '../scanners/registry.ts';
import { applyRules } from '../scanners/rules.ts';
import { oosSummary, passesRule, walkForward, type OosSummary, type WalkForwardResult } from './walkForward.ts';

const log = logger.scoped('validation');

export interface ValidationDeps {
  db: Db; cfgRef: () => AppConfig; registry: ScannerRegistry; pool: PinePool; cache: CandleCache; scanners: ScannerEngine;
}

export interface RunOptions { scanner?: string; symbol?: string; tf?: string; days?: number }

export interface RunStatus {
  running: boolean; startedAt: number | null; finishedAt: number | null; total: number; done: number; failed: number;
  current: string | null; errors: Array<{ key: string; error: string }>; lastMs: number | null;
}

export interface WalkForwardSummary {
  scannerId: string; scannerName: string; symbol: string; tf: string; at: number; bars: number; from: number; to: number;
  windows: number; selectedWindows: number;
  inSample: WalkForwardResult['inSample']; outOfSample: WalkForwardResult['outOfSample']; outOfSampleAll: WalkForwardResult['outOfSampleAll'];
  /** Passes the configured OOS gate (autoTune.oos thresholds, regardless of `enabled`). */
  oosPass: boolean;
  /** OOS profit factor below 1 — the roadmap's red flag. */
  oosFlag: boolean;
  /** Passes the in-sample rule over the whole history (what the current tuner sees). */
  inSamplePass: boolean;
  enabled: boolean;
}

export class ValidationService {
  private deps: ValidationDeps;
  private results = new Map<string, WalkForwardResult>();
  status: RunStatus = { running: false, startedAt: null, finishedAt: null, total: 0, done: 0, failed: 0, current: null, errors: [], lastMs: null };
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: ValidationDeps) {
    this.deps = deps;
    deps.db.db.exec(`CREATE TABLE IF NOT EXISTS walk_forward (
      scanner_id TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL, at INTEGER NOT NULL, bars INTEGER NOT NULL, from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY (scanner_id, symbol, tf)
    );`);
    for (const r of deps.db.all<any>('SELECT scanner_id, symbol, tf, result FROM walk_forward')) {
      try { const res = JSON.parse(r.result) as WalkForwardResult; if (res.version === SIMULATION_VERSION) this.results.set(`${r.scanner_id}:${r.symbol}:${r.tf}`, res); } catch { /* ignore */ }
    }
    if (this.results.size) log.info(`loaded ${this.results.size} walk-forward results`);
    deps.scanners.setWalkForwardSource((id, symbol, tf) => this.lookup(id, symbol, tf));
    this.schedule();
  }

  static key(id: string, symbol: string, tf: string) { return `${id}:${symbol}:${tf}`; }

  lookup(id: string, symbol: string, tf: string): OosSummary | null {
    const r = this.results.get(ValidationService.key(id, symbol, tf));
    return r ? oosSummary(r) : null;
  }

  get(id: string, symbol: string, tf: string): WalkForwardResult | null { return this.results.get(ValidationService.key(id, symbol, tf)) ?? null; }

  private summarize(r: WalkForwardResult): WalkForwardSummary {
    const cfg = this.deps.cfgRef();
    const oos = cfg.autoTune.oos;
    const o = r.outOfSample;
    const oosPass = o.trades >= oos.minTrades && (o.profitFactor ?? 0) >= oos.minProfitFactor && o.positiveWeeks >= oos.minPositiveWeeks && o.pnl > 0;
    const sc = this.deps.registry.get(r.scannerId);
    return {
      scannerId: r.scannerId, scannerName: r.scannerName, symbol: r.symbol, tf: r.tf, at: r.at, bars: r.bars, from: r.from, to: r.to,
      windows: r.windows.length, selectedWindows: r.selectedWindows, inSample: r.inSample, outOfSample: o, outOfSampleAll: r.outOfSampleAll,
      oosPass, oosFlag: o.trades > 0 && (o.profitFactor ?? 0) < 1, inSamplePass: passesRule(r.inSample, cfg.autoTune.minTrades, cfg.autoTune.minProfitFactor),
      enabled: sc ? this.deps.scanners.isActive(sc) && this.deps.scanners.symbolsFor(sc.id).includes(r.symbol) && this.deps.scanners.timeframesFor(sc.id).includes(r.tf) : false,
    };
  }

  summaries(): WalkForwardSummary[] { return [...this.results.values()].map(r => this.summarize(r)).sort((a, b) => (b.outOfSample.pnl) - (a.outOfSample.pnl)); }

  forScanner(id: string): { scannerId: string; scannerName: string; results: WalkForwardResult[]; summaries: WalkForwardSummary[] } {
    const list = [...this.results.values()].filter(r => r.scannerId === id);
    return { scannerId: id, scannerName: this.deps.registry.get(id)?.name ?? list[0]?.scannerName ?? id, results: list, summaries: list.map(r => this.summarize(r)) };
  }

  /** Pairs a run would cover. */
  jobs(opts: RunOptions = {}): Array<{ s: LoadedScanner; symbol: string; tf: string }> {
    const out: Array<{ s: LoadedScanner; symbol: string; tf: string }> = [];
    const scanners = opts.scanner ? [this.deps.registry.get(opts.scanner)].filter((s): s is LoadedScanner => Boolean(s && s.status === 'ok')) : this.deps.registry.all().filter(s => this.deps.scanners.isActive(s));
    for (const s of scanners) {
      const symbols = opts.symbol ? [opts.symbol] : this.deps.scanners.symbolsFor(s.id);
      const tfs = opts.tf ? [opts.tf] : this.deps.scanners.timeframesFor(s.id);
      for (const symbol of symbols) for (const tf of tfs) if (tf in TF_SECONDS) out.push({ s, symbol, tf });
    }
    return out;
  }

  /** Start a run in the background; returns immediately with the status. */
  start(opts: RunOptions = {}): RunStatus {
    if (this.status.running) return this.status;
    void this.run(opts).catch(e => log.error(`walk-forward run failed: ${e?.message ?? e}`));
    return this.status;
  }

  /** Run walk-forward validation for the selected pairs (sequential per pair; the pool parallelises script runs). */
  async run(opts: RunOptions = {}): Promise<{ jobs: number; done: number; failed: number; ms: number }> {
    if (this.status.running) throw new Error('a walk-forward run is already in progress');
    const cfg = this.deps.cfgRef();
    const wf = cfg.validation.walkForward;
    const days = Math.max(wf.trainDays + wf.testDays, Math.min(cfg.validation.history.days, opts.days ?? wf.days));
    const jobs = this.jobs(opts);
    const t0 = Date.now();
    this.status = { running: true, startedAt: t0, finishedAt: null, total: jobs.length, done: 0, failed: 0, current: null, errors: [], lastMs: null };
    log.info(`walk-forward: ${jobs.length} pairs over ${days} days (train ${wf.trainDays}d / test ${wf.testDays}d / step ${wf.stepDays}d)`);
    // group by symbol so the cache fetches each symbol once and scripts run while the next symbol loads
    const bySymbol = new Map<string, typeof jobs>();
    for (const j of jobs) { const l = bySymbol.get(`${j.symbol}:${j.tf}`) ?? []; l.push(j); bySymbol.set(`${j.symbol}:${j.tf}`, l); }
    const workers: Promise<void>[] = [];
    for (const [key, list] of bySymbol) {
      const [symbol, tf] = key.split(':');
      const barsN = Math.ceil(days * 86_400 / TF_SECONDS[tf]) + 60;
      const p = (async () => {
        let bars: Awaited<ReturnType<CandleCache['getHistory']>>;
        try { bars = await this.deps.cache.getHistory(symbol, tf, barsN); } catch (e: any) { for (const j of list) this.fail(`${j.s.id}:${symbol}:${tf}`, `history: ${e?.message ?? e}`); return; }
        if (bars.length < 300) { for (const j of list) this.fail(`${j.s.id}:${symbol}:${tf}`, `only ${bars.length} bars of history`); return; }
        await Promise.all(list.map(j => this.runPair(j.s, symbol, tf, bars)));
      })();
      workers.push(p);
    }
    await Promise.allSettled(workers);
    const ms = Date.now() - t0;
    this.status = { ...this.status, running: false, finishedAt: Date.now(), current: null, lastMs: ms };
    log.info(`walk-forward complete: ${this.status.done}/${jobs.length} pairs, ${this.status.failed} failed, ${ms}ms`);
    return { jobs: jobs.length, done: this.status.done, failed: this.status.failed, ms };
  }

  private fail(key: string, error: string) {
    this.status.failed++; this.status.done++;
    this.status.errors.push({ key, error }); if (this.status.errors.length > 100) this.status.errors.splice(0, this.status.errors.length - 100);
    log.warn(`walk-forward ${key}: ${error}`);
  }

  private async runPair(s: LoadedScanner, symbol: string, tf: string, bars: Awaited<ReturnType<CandleCache['getHistory']>>): Promise<void> {
    const key = ValidationService.key(s.id, symbol, tf);
    this.status.current = key;
    try {
      const cfg = this.deps.cfgRef();
      const sc = this.deps.scanners.scannerConfig(s.id);
      const market = await this.deps.scanners.marketInfo(symbol);
      const rule = sc.rule ?? null;
      const res = await this.deps.pool.run({ scannerId: s.id, source: s.patched, symbol, tf, tickSize: market.tickSize, bars, tailBars: 'all', plotTail: rule ? bars.length : 10, inputs: sc.inputs && Object.keys(sc.inputs).length ? sc.inputs : undefined });
      if (!res.ok) { this.fail(key, res.error ?? 'script error'); return; }
      const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule, bars, mode: 'backtest' });
      const events = extractEvents(res.alerts, res.shapes, { derived });
      const wf = cfg.validation.walkForward;
      const r = walkForward({ scannerId: s.id, scannerName: s.name, symbol, tf, bars, events, cfg: cfg.paper, exitMode: sc.exitMode, contractValue: market.contractValue, tickSize: market.tickSize,
        opts: { trainDays: wf.trainDays, testDays: wf.testDays, stepDays: wf.stepDays, minTrades: cfg.autoTune.minTrades, minProfitFactor: cfg.autoTune.minProfitFactor } });
      this.results.set(key, r);
      this.deps.db.run('INSERT INTO walk_forward(scanner_id, symbol, tf, at, bars, from_ms, to_ms, result) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scanner_id, symbol, tf) DO UPDATE SET at=excluded.at, bars=excluded.bars, from_ms=excluded.from_ms, to_ms=excluded.to_ms, result=excluded.result', s.id, symbol, tf, r.at, r.bars, r.from, r.to, JSON.stringify(r));
      this.status.done++;
      log.info(`walk-forward ${key}: ${r.windows.length} windows (${r.selectedWindows} selected), OOS ${r.outOfSample.trades} trades PF ${r.outOfSample.profitFactor?.toFixed(2) ?? '-'} pnl ${r.outOfSample.pnl.toFixed(0)}, ${r.outOfSample.positiveWeeks}/${r.outOfSample.weeks} +weeks (${res.ms}ms)`);
    } catch (e: any) {
      this.fail(key, String(e?.message ?? e));
    }
  }

  /** Optional periodic run (validation.walkForward.autoRun): first after 5 min, then every autoTune.intervalHours. */
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    const cfg = this.deps.cfgRef();
    if (!cfg.validation?.walkForward?.autoRun) return;
    const first = this.timer === null && this.status.finishedAt === null;
    this.timer = setTimeout(async () => {
      this.timer = null;
      try { if (!this.status.running) await this.run(); } catch (e: any) { log.error(`scheduled walk-forward failed: ${e?.message ?? e}`); }
      this.schedule();
    }, first ? 5 * 60_000 : Math.max(1, cfg.autoTune.intervalHours) * 3600_000);
    this.timer.unref();
  }

  /** Re-evaluate the schedule after a config change. */
  reschedule() { this.schedule(); }
}
