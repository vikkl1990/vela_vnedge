/**
 * Orchestrator: for every (scanner × symbol × timeframe) runs the Pine script on bar close,
 * extracts events, records signals, and hands entries/exits to the paper engine.
 */
import { EventEmitter } from 'node:events';
import type { AppConfig, ScannerConfig, ExitMode, OosTuneConfig } from '../config.ts';
import { TF_SECONDS } from '../config.ts';
import type { OosSummary } from '../validation/walkForward.ts';
import type { CandleStore, Bar } from '../data/candleStore.ts';
import { lastAtr } from '../data/indicators.ts';
import type { Db } from '../db.ts';
import type { DeltaRest } from '../delta/rest.ts';
import { logger } from '../log.ts';
import type { PaperEngine, MarketInfo } from '../paper/engine.ts';
import { SIMULATION_VERSION } from '../paper/version.ts';
import { runBacktest, type BacktestResult } from '../paper/backtest.ts';
import type { PinePool } from '../pine/pool.ts';
import type { WorkerResult } from '../pine/worker.ts';
import { extractEvents, describeEvent, type ScanEvent } from './extractor.ts';
import { applyRules, labelKey } from './rules.ts';
import type { MlService } from '../ml/service.ts';
import { resolveLevels } from '../paper/logic.ts';
import type { ScannerRegistry, LoadedScanner } from './registry.ts';

const log = logger.scoped('scanner');

export interface RunInfo { at: number; ms: number; symbol: string; tf: string; error: string | null; barTime: number | null }

/** Deeper candle source used for warm backtests only (see data/candleCache.ts). */
export interface HistorySource { getHistory(symbol: string, tf: string, bars: number): Promise<Bar[]> }
/** Walk-forward lookup used by the OOS-aware auto-tune (null when no result exists for the pair). */
export type WalkForwardSource = (scannerId: string, symbol: string, tf: string) => OosSummary | null;
/** Live entry filter (consensus etc.): called before an entry reaches the paper engine. */
export interface EntryCandidate { scannerId: string; scannerName: string; symbol: string; tf: string; side: 'long' | 'short'; barTime: number; price: number; at: number }
export type EntryFilter = (c: EntryCandidate) => { ok: boolean; reason?: string };

export interface AutoTuneDecision {
  symbol: string; tf: string | null; keep: boolean;
  /** Which rule decided: `oos` (walk-forward out-of-sample), `in-sample` (backtest), `provisional` (OOS requested but no walk-forward data → in-sample fallback). */
  rule: 'oos' | 'in-sample' | 'provisional';
  trades: number; pnl: number; profitFactor: number | null; positiveWeeks: number | null; reason: string;
}
export interface AutoTuneReport {
  id: string; name: string; before: string[]; after: string[]; beforeTimeframes: string[]; afterTimeframes: string[]; disabled: boolean;
  /** Rule requested for this run (`oos` when autoTune.oos.enabled). */
  rule: 'oos' | 'in-sample';
  /** True when at least one decision fell back to in-sample for lack of walk-forward data. */
  provisional: boolean;
  dropped: Array<{ symbol: string; trades: number; pnl: number }>;
  decisions: AutoTuneDecision[];
  /** True when the scanner was left untouched because none of its pairs has a backtest yet. */
  skipped?: boolean;
}

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
  /**
   * One deferred run per scanner/symbol/timeframe. A bar that closes while the previous run is
   * still going used to be dropped outright, losing that bar's entries and script exits; the
   * newest request is now held here and dispatched when the running job finishes. Only the
   * newest is kept: older bars are already superseded by the time we get to them.
   */
  private deferred = new Map<string, { s: LoadedScanner; symbol: string; tf: string; mode: { backtest: boolean; live: boolean } }>();
  private backtests = new Map<string, BacktestResult>();
  private warmed = new Set<string>();
  private seenLabels = new Map<string, Set<string>>();
  private symbolsRef: () => string[];
  private ml: MlService | null;
  private cfgStore: { setScanner(id: string, patch: Partial<ScannerConfig>): ScannerConfig } | null = null;
  private history: HistorySource | null = null;
  private wfSource: WalkForwardSource | null = null;
  private entryFilter: EntryFilter | null = null;
  /** Last auto-tune report (any trigger) with the rule applied per decision. */
  lastAutoTune: { at: number; reason: string; report: AutoTuneReport[] } | null = null;

  constructor(deps: { registry: ScannerRegistry; cfgRef: () => AppConfig; candles: CandleStore; pool: PinePool; paper: PaperEngine; db: Db; rest: DeltaRest; symbolsRef?: () => string[]; ml?: MlService; cfgStore?: { setScanner(id: string, patch: Partial<ScannerConfig>): ScannerConfig } }) {
    super();
    this.registry = deps.registry; this.cfgRef = deps.cfgRef; this.candles = deps.candles; this.pool = deps.pool; this.paper = deps.paper; this.db = deps.db; this.rest = deps.rest;
    this.symbolsRef = deps.symbolsRef ?? (() => this.cfgRef().symbols);
    this.ml = deps.ml ?? null;
    this.cfgStore = deps.cfgStore ?? null;
    // every closed live trade becomes a learning sample
    this.paper.on('trade', (t: any) => { if (this.ml && t.features) this.ml.addLiveSample(t.scannerId, t.symbol, t.tf, t.entryAt, t.features, t.pnl > 0, t.rMultiple ?? 0, t.pnl, String(t.exitReason ?? '')); });
    for (const r of this.db.all<any>('SELECT * FROM scanner_runs')) this.lastRun.set(`${r.scanner_id}:${r.symbol}:${r.tf}`, { at: r.at, ms: r.ms, symbol: r.symbol, tf: r.tf, error: r.error, barTime: r.bar_time });
    for (const r of this.db.all<any>('SELECT * FROM backtests')) { try { const result = JSON.parse(r.result); if (result.version === SIMULATION_VERSION) this.backtests.set(`${r.scanner_id}:${r.symbol}:${r.tf}`, result); } catch { /* ignore */ } }
    this.candles.on('closed', (e: { symbol: string; tf: string; bar: Bar }) => this.onBarClosed(e.symbol, e.tf, e.bar));
    // one-off backfill of readable summaries for signals stored before the column existed
    for (const r of this.db.all<any>("SELECT * FROM signals WHERE summary = '' OR summary IS NULL")) {
      const ev: ScanEvent = { kind: r.kind, side: r.side ?? undefined, exitType: undefined, price: r.price ?? undefined, sl: r.sl ?? undefined, tp: JSON.parse(r.tp || '[]'), score: r.score ?? undefined, label: r.label, message: r.message, source: r.source, barTime: r.bar_time, barIndex: -1 };
      if (ev.kind === 'exit') { const m = String(r.label).match(/TP\s?(\d)/i); ev.exitType = m ? (`tp${m[1]}` as any) : /SL/i.test(r.label) ? 'sl' : /BE/i.test(r.label) ? 'be' : /REVERSAL|FLIP/i.test(r.label) ? 'flip' : 'close'; }
      this.db.run('UPDATE signals SET summary=? WHERE id=?', describeEvent(ev), r.id);
    }
  }

  /** Deep candle history for warm backtests (validation module); live runs keep the in-memory bars. */
  setHistorySource(h: HistorySource | null) { this.history = h; }
  /** Walk-forward results for the OOS-aware auto-tune. */
  setWalkForwardSource(f: WalkForwardSource | null) { this.wfSource = f; }
  /** Live entry filter (e.g. consensus); `null` removes it. */
  setEntryFilter(f: EntryFilter | null) { this.entryFilter = f; }

  // ---- configuration helpers ----

  /**
   * A scanner the configuration has never heard of is OFF.
   *
   * It used to default to enabled, which meant dropping a .pine file into the folder — or pulling
   * an import someone else made — put it straight into the live fleet on the next restart, across
   * the whole symbol universe. Adding a file should not start trading it; turning it on should be
   * a decision someone made.
   */
  scannerConfig(id: string): ScannerConfig {
    const cfg = this.cfgRef();
    return cfg.scanners[id] ?? { enabled: false, symbols: null, timeframes: null, exitMode: 'both' };
  }
  symbolsFor(id: string): string[] { return this.scannerConfig(id).symbols ?? this.symbolsRef(); }
  timeframesFor(id: string): string[] { return this.scannerConfig(id).timeframes ?? this.cfgRef().timeframes; }
  isActive(s: LoadedScanner): boolean { const c = this.scannerConfig(s.id); return s.status === 'ok' && c.enabled && !c.hidden; }

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
  allBacktests(): Array<{ id: string; symbol: string; tf: string; result: BacktestResult }> { return [...this.backtests.entries()].map(([k, result]) => { const [id, symbol, tf] = k.split(':'); return { id, symbol, tf, result }; }); }
  /** Backtests grouped by scanner id; the per-scanner filter was rescanning the whole map each time. */
  backtestsByScanner(): Map<string, BacktestResult[]> {
    const m = new Map<string, BacktestResult[]>();
    for (const [k, v] of this.backtests) { const id = k.slice(0, k.indexOf(':')); const l = m.get(id); if (l) l.push(v); else m.set(id, [v]); }
    return m;
  }

  /** Newest run per scanner id, grouped in one pass. */
  lastRunByScanner(): Map<string, RunInfo> {
    const m = new Map<string, RunInfo>();
    for (const [k, v] of this.lastRun) { const id = k.slice(0, k.indexOf(':')); const b = m.get(id); if (!b || v.at > b.at) m.set(id, v); }
    return m;
  }

  backtestSummary(id: string, pre?: Map<string, BacktestResult[]>): BacktestResult['stats'] | null {
    const list = pre ? (pre.get(id) ?? []) : [...this.backtests.entries()].filter(([k]) => k.startsWith(id + ':')).map(([, v]) => v);
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

  /**
   * Restrict each enabled scanner to the symbols (and, with `tuneTimeframes`, timeframes) where
   * it is profitable; scanners with no qualifying pair are disabled. Two rules:
   *  - in-sample (default): the warm backtest has ≥ minTrades trades, pnl > 0 and PF ≥ minProfitFactor;
   *  - oos (`autoTune.oos.enabled`): the walk-forward OUT-OF-SAMPLE result has ≥ oos.minTrades trades,
   *    PF ≥ oos.minProfitFactor and ≥ oos.minPositiveWeeks positive weeks. Pairs without walk-forward
   *    data fall back to the in-sample rule and are marked `provisional`.
   * Every decision in the report says which rule was applied.
   */
  autoTune(opts: { minTrades?: number; minProfitFactor?: number; oos?: OosTuneConfig | null; tuneTimeframes?: boolean; reason?: string } = {}): AutoTuneReport[] {
    const minTrades = opts.minTrades ?? 3, minPf = opts.minProfitFactor ?? 1;
    const oos = opts.oos && opts.oos.enabled ? opts.oos : null;
    const byTf = Boolean(opts.tuneTimeframes);
    const report: AutoTuneReport[] = [];
    const inSample = (id: string, symbol: string, tfs: string[]): AutoTuneDecision => {
      let trades = 0, pnl = 0, gp = 0, gl = 0;
      for (const tf of tfs) { const b = this.backtests.get(`${id}:${symbol}:${tf}`); if (!b) continue; trades += b.stats.trades; pnl += b.stats.pnl; gp += b.stats.grossProfit; gl += b.stats.grossLoss; }
      const pf = gl > 0 ? gp / gl : gp > 0 ? 999 : 0;
      const keep = trades >= minTrades && pnl > 0 && pf >= minPf;
      return { symbol, tf: tfs.length === 1 && byTf ? tfs[0] : null, keep, rule: oos ? 'provisional' : 'in-sample', trades, pnl, profitFactor: trades ? pf : null, positiveWeeks: null,
        reason: keep ? `in-sample: ${trades} trades, PF ${pf.toFixed(2)}` : `in-sample: ${trades} trades, pnl ${pnl.toFixed(0)}, PF ${pf.toFixed(2)} (need ≥ ${minTrades} trades, pnl > 0, PF ≥ ${minPf})` };
    };
    const outOfSample = (symbol: string, tf: string, w: OosSummary): AutoTuneDecision => {
      const pf = w.profitFactor ?? 0;
      const keep = w.trades >= oos!.minTrades && pf >= oos!.minProfitFactor && w.positiveWeeks >= oos!.minPositiveWeeks && w.pnl > 0;
      return { symbol, tf: byTf ? tf : null, keep, rule: 'oos', trades: w.trades, pnl: w.pnl, profitFactor: w.profitFactor, positiveWeeks: w.positiveWeeks,
        reason: `${keep ? 'OOS' : 'OOS fail'}: ${w.trades} trades, PF ${pf.toFixed(2)}, ${w.positiveWeeks}/${w.weeks} positive weeks over ${w.selectedWindows}/${w.windows} selected windows${keep ? '' : ` (need ≥ ${oos!.minTrades} trades, PF ≥ ${oos!.minProfitFactor}, ≥ ${oos!.minPositiveWeeks} positive weeks, pnl > 0)`}` };
    };
    for (const s of this.registry.all()) {
      if (!this.isActive(s)) continue;
      const before = this.symbolsFor(s.id);
      const tfs = this.timeframesFor(s.id);
      // A scanner enabled moments ago has no backtest yet; disabling it for "0 trades" would
      // silently undo the operator's change, so leave unmeasured scanners alone until they warm.
      if (!before.some(sym => tfs.some(tf => this.backtests.has(`${s.id}:${sym}:${tf}`)))) {
        report.push({ id: s.id, name: s.name, before, after: before, beforeTimeframes: tfs, afterTimeframes: tfs, disabled: false,
          rule: oos ? 'oos' : 'in-sample', provisional: false, dropped: [], decisions: [], skipped: true });
        log.info(`auto-tune ${s.id}: skipped, no backtest yet`);
        continue;
      }
      const decisions: AutoTuneDecision[] = [];
      for (const symbol of before) {
        const groups: string[][] = byTf ? tfs.map(tf => [tf]) : [tfs];
        for (const g of groups) {
          if (!oos) { decisions.push(inSample(s.id, symbol, g)); continue; }
          const wf = g.map(tf => ({ tf, w: this.wfSource?.(s.id, symbol, tf) ?? null })).filter((x): x is { tf: string; w: OosSummary } => x.w !== null);
          if (!wf.length) { decisions.push(inSample(s.id, symbol, g)); continue; }
          // symbol-level (non-tf) mode: keep the symbol when any of its timeframes passes OOS
          const ds = wf.map(x => outOfSample(symbol, x.tf, x.w));
          if (byTf) decisions.push(...ds);
          else { const best = ds.find(d => d.keep) ?? ds.sort((a, b) => b.pnl - a.pnl)[0]; decisions.push({ ...best, tf: null }); }
        }
      }
      const keepSymbols = [...new Set(decisions.filter(d => d.keep).map(d => d.symbol))];
      const keepTfs = byTf ? [...new Set(decisions.filter(d => d.keep).map(d => d.tf!))] : tfs;
      const dropped = before.filter(sym => !keepSymbols.includes(sym)).map(sym => { const ds = decisions.filter(d => d.symbol === sym); return { symbol: sym, trades: ds.reduce((a, d) => a + d.trades, 0), pnl: ds.reduce((a, d) => a + d.pnl, 0) }; });
      const disabled = keepSymbols.length === 0 || keepTfs.length === 0;
      // store explicit lists (null would mean "follow the universe" and re-widen on the next universe change)
      this.cfgStore?.setScanner(s.id, disabled ? { enabled: false } : byTf ? { symbols: keepSymbols, timeframes: keepTfs } : { symbols: keepSymbols });
      const provisional = decisions.some(d => d.rule === 'provisional');
      report.push({ id: s.id, name: s.name, before, after: keepSymbols, beforeTimeframes: tfs, afterTimeframes: disabled ? tfs : keepTfs, disabled, rule: oos ? 'oos' : 'in-sample', provisional, dropped, decisions });
      log.info(`auto-tune ${s.id} [${oos ? 'oos' : 'in-sample'}${provisional ? ', provisional' : ''}]: ${before.length} → ${keepSymbols.length} symbols${byTf ? `, ${tfs.length} → ${keepTfs.length} tfs` : ''}${disabled ? ' (disabled: no profitable pair)' : ''}`);
    }
    this.lastAutoTune = { at: Date.now(), reason: opts.reason ?? 'manual', report };
    return report;
  }

  // ---- lifecycle ----

  /** Track all needed candle series and warm every active scanner (backtest + first live run). */
  async start(): Promise<void> {
    const cfg = this.cfgRef();
    const required = this.requiredSeries();
    await Promise.all(required.map(r => this.candles.track(r.symbol, r.tf, cfg.historyBars)));
    for (const s of new Set([...this.symbolsRef(), ...required.map(r => r.symbol)])) await this.candles.track(s, '1m', 300); // fill engine price feed
    const jobs: Promise<void>[] = [];
    for (const s of this.registry.all()) if (this.isActive(s)) for (const symbol of this.symbolsFor(s.id)) for (const tf of this.timeframesFor(s.id)) jobs.push(this.warm(s, symbol, tf));
    log.info(`warming ${jobs.length} scanner runs`);
    await Promise.allSettled(jobs);
    log.info('warm-up complete');
    this.maybeAutoTune('warm-up');
    this.scheduleRetune();
  }

  private retuneTimer: ReturnType<typeof setTimeout> | null = null;

  /** Apply auto-tune when enabled; emits scanner updates so the dashboard refreshes. */
  private maybeAutoTune(reason: string) {
    const at = this.cfgRef().autoTune;
    if (!at?.enabled) return;
    const report = this.autoTune({ minTrades: at.minTrades, minProfitFactor: at.minProfitFactor, oos: at.oos ?? null, tuneTimeframes: at.tuneTimeframes ?? false, reason });
    const changed = report.filter(r => r.disabled || r.after.length !== r.before.length);
    const skipped = report.filter(r => r.skipped).length;
    log.info(`auto-tune (${reason}): ${report.length} scanners checked, ${changed.length} changed, ${report.filter(r => r.disabled).length} disabled${skipped ? `, ${skipped} skipped (not backtested yet)` : ''}`);
    for (const r of report) this.emit('scanner', { id: r.id, lastRun: this.getLastRun(r.id), stats: this.paper.scannerStats(r.id) });
  }

  /** Periodic: re-backtest every active scanner on its current symbols, then re-tune. */
  private scheduleRetune() {
    if (this.retuneTimer) clearTimeout(this.retuneTimer);
    const at = this.cfgRef().autoTune;
    if (!at?.enabled) return;
    this.retuneTimer = setTimeout(async () => {
      this.retuneTimer = null;
      try {
        const jobs: Promise<void>[] = [];
        for (const s of this.registry.all()) if (this.isActive(s)) for (const symbol of this.symbolsFor(s.id)) for (const tf of this.timeframesFor(s.id)) jobs.push(this.runOnce(s, symbol, tf, { backtest: true, live: false }));
        log.info(`scheduled re-backtest: ${jobs.length} runs`);
        await Promise.allSettled(jobs);
        this.maybeAutoTune('scheduled');
      } catch (e: any) { log.error(`scheduled retune failed: ${e?.message ?? e}`); }
      this.scheduleRetune();
    }, Math.max(1, at.intervalHours) * 3600_000);
    this.retuneTimer.unref();
  }

  /** Called when config changed: subscribe new series, warm newly enabled scanners. */
  async refresh(): Promise<void> {
    const cfg = this.cfgRef();
    for (const r of this.requiredSeries()) if (!this.candles.has(r.symbol, r.tf)) await this.candles.track(r.symbol, r.tf, cfg.historyBars);
    for (const s of new Set([...this.symbolsRef(), ...this.requiredSeries().map(r => r.symbol)])) if (!this.candles.has(s, '1m')) await this.candles.track(s, '1m', 300);
    const jobs: Promise<void>[] = [];
    for (const s of this.registry.all()) if (this.isActive(s)) for (const symbol of this.symbolsFor(s.id)) for (const tf of this.timeframesFor(s.id)) {
      if (!this.warmed.has(`${s.id}:${symbol}:${tf}`)) jobs.push(this.warm(s, symbol, tf));
    }
    if (jobs.length) { log.info(`warming ${jobs.length} scanner runs in the background`); void Promise.allSettled(jobs).then(() => { log.info('warm-up complete'); this.maybeAutoTune('refresh'); }); }
    this.scheduleRetune();
  }

  /** Full-history run: backtest for stats + overlay; live signals only for the last closed bar. */
  private async warm(s: LoadedScanner, symbol: string, tf: string): Promise<void> {
    const key = `${s.id}:${symbol}:${tf}`;
    this.warmed.add(key);
    // resume: a backtest from the last hour that already carries ML features does not need re-running
    const prev = this.backtests.get(key);
    if (prev && Date.now() - prev.at < 3600_000 && (prev.trades.length === 0 || (prev.trades[0] as any).features)) { log.debug(`warm ${key}: fresh backtest, skipping`); return; }
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
    const active = this.registry.all().filter(s => this.isActive(s) && this.symbolsFor(s.id).includes(symbol) && this.timeframesFor(s.id).includes(tf));
    if (!active.length) return;
    // backpressure: if the worker queue is already deep (warm-up or an earlier bar still running), skip this bar for this symbol
    if (this.pool.stats.queued > 500) { log.warn(`bar closed ${symbol} ${tf}: worker queue ${this.pool.stats.queued} deep — skipping live runs for this bar (reduce scanners × symbols)`); return; }
    log.info(`bar closed ${symbol} ${tf} @ ${new Date(bar.time).toISOString().slice(11, 16)} → running ${active.length} scanners`);
    for (const s of active) this.runOnce(s, symbol, tf, { backtest: false, live: true }).catch(e => log.error(`run ${s.id} ${symbol} ${tf} failed: ${e?.message ?? e}`));
  }

  // ---- the core run ----

  private async runOnce(s: LoadedScanner, symbol: string, tf: string, mode: { backtest: boolean; live: boolean }): Promise<void> {
    const key = `${s.id}:${symbol}:${tf}`;
    if (this.inFlight.has(key)) {
      const prev = this.deferred.get(key);
      // keep the newest request, but never lose a live run behind a backtest-only one
      this.deferred.set(key, { s, symbol, tf, mode: { backtest: mode.backtest || (prev?.mode.backtest ?? false), live: mode.live || (prev?.mode.live ?? false) } });
      log.debug(`defer ${key}: already running`);
      return;
    }
    this.inFlight.add(key);
    const scannerConfigAtStart = this.cfgRef().scanners[s.id];
    const at = Date.now();
    try {
      const cfg = this.cfgRef();
      const sc = this.scannerConfig(s.id);
      const bars = this.candles.get(symbol, tf, { closedOnly: true, limit: cfg.historyBars });
      if (bars.length < 50) throw new Error(`only ${bars.length} bars`);
      const market = await this.marketInfo(symbol);
      // warm backtests may use a deeper cached history; live runs always use the in-memory bars
      let btBars = bars;
      const deepN = cfg.validation?.history?.backtestBars ?? 0;
      if (mode.backtest && this.history && deepN > bars.length) {
        try { const deep = await this.history.getHistory(symbol, tf, deepN); if (deep.length > bars.length) btBars = deep; } catch (e: any) { log.warn(`deep history ${symbol} ${tf} unavailable (${e?.message ?? e}); using ${bars.length} in-memory bars`); }
      }
      const rule = sc.rule ?? null;
      const inputs = sc.inputs && Object.keys(sc.inputs).length ? sc.inputs : undefined;
      const runJob = (b: Bar[], tailBars: number | 'all') => this.pool.run({ scannerId: s.id, source: s.patched, symbol, tf, tickSize: market.tickSize, bars: b, tailBars, plotTail: rule ? b.length : 400, inputs });
      const res = await runJob(mode.backtest ? btBars : bars, mode.backtest ? 'all' : 3);
      // a deep backtest run does not see the last bars the way the live run does → separate live run
      const liveRes = mode.live && btBars !== bars ? await runJob(bars, 3) : res;
      const info: RunInfo = { at, ms: res.ms + (liveRes === res ? 0 : liveRes.ms), symbol, tf, error: res.ok ? null : res.error ?? 'unknown', barTime: bars.at(-1)!.time };
      this.lastRun.set(key, info);
      this.db.run('INSERT INTO scanner_runs(scanner_id, symbol, tf, at, ms, error, bar_time) VALUES (?,?,?,?,?,?,?) ON CONFLICT(scanner_id, symbol, tf) DO UPDATE SET at=excluded.at, ms=excluded.ms, error=excluded.error, bar_time=excluded.bar_time', s.id, symbol, tf, at, res.ms, info.error, info.barTime);
      if (!res.ok) { log.warn(`${key} error: ${res.error}`); this.emit('scanner', { id: s.id, lastRun: info }); return; }
      const ov = liveRes.ok ? liveRes : res;
      this.overlays.set(key, { at, plots: ov.plots, shapes: ov.shapes, labels: ov.labels });

      const exitMode: ExitMode = sc.exitMode;
      const prevLabels = this.seenLabels.get(key);
      const currentLabels = new Set(ov.labels.map(labelKey));
      const newLabelKeys = prevLabels ? new Set([...currentLabels].filter(k => !prevLabels.has(k))) : new Set<string>();
      this.seenLabels.set(key, currentLabels);
      if (mode.backtest) {
        const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule, bars: btBars, mode: 'backtest' });
        const events = extractEvents(res.alerts, res.shapes, { derived });
        const bt = runBacktest({ scannerId: s.id, scannerName: s.name, symbol, tf, bars: btBars, events, cfg: this.cfgRef().paper, exitMode, contractValue: market.contractValue, tickSize: market.tickSize });
        this.backtests.set(key, bt);
        if (this.ml) this.ml.replaceBacktestSamples(s.id, symbol, tf, bt.trades.filter((t: any) => t.features).map((t: any) => ({ at: t.entryAt, features: t.features, win: t.pnl > 0, r: t.rMultiple ?? 0, pnl: t.pnl, exitReason: String(t.exitReason ?? '') })));
        this.db.run('INSERT INTO backtests(scanner_id, symbol, tf, at, bars, result) VALUES (?,?,?,?,?,?) ON CONFLICT(scanner_id, symbol, tf) DO UPDATE SET at=excluded.at, bars=excluded.bars, result=excluded.result', s.id, symbol, tf, bt.at, bt.bars, JSON.stringify(bt));
        log.info(`backtest ${key}: ${bt.stats.trades} trades, win ${bt.stats.winRatePct.toFixed(0)}%, pnl ${bt.stats.pnl.toFixed(0)} (${res.ms}ms)`);
      }
      // A pending job cannot trade after disable/removal or a configuration change.
      if (mode.live && this.isActive(s) && this.cfgRef().scanners[s.id] === scannerConfigAtStart
          && this.symbolsFor(s.id).includes(symbol) && this.timeframesFor(s.id).includes(tf)) {
        const lastBar = bars.at(-1)!;
        if (!liveRes.ok) { log.warn(`${key} live run error: ${liveRes.error}`); return; }
        const derived = applyRules({ scannerId: s.id, alerts: liveRes.alerts, shapes: liveRes.shapes, labels: liveRes.labels, plots: liveRes.plots, rule, bars, mode: 'live', newLabelKeys });
        const events = extractEvents(liveRes.alerts, liveRes.shapes, { sinceBarTime: lastBar.time, derived });
        for (const ev of events) this.handleLiveEvent(s, symbol, tf, ev, bars, market, exitMode, lastBar);
      }
      this.emit('scanner', { id: s.id, lastRun: info, stats: this.paper.scannerStats(s.id) });
    } finally {
      this.inFlight.delete(key);
      const next = this.deferred.get(key);
      if (next) {
        this.deferred.delete(key);
        // run on the next tick so the finished job's stack unwinds before the follow-up starts
        setImmediate(() => void this.runOnce(next.s, next.symbol, next.tf, next.mode).catch(e => log.error(`deferred run ${key} failed: ${e?.message ?? e}`)));
      }
    }
  }

  private handleLiveEvent(s: LoadedScanner, symbol: string, tf: string, ev: ScanEvent, bars: Bar[], market: MarketInfo, exitMode: ExitMode, lastBar: Bar) {
    if (this.db.signalExists(s.id, symbol, tf, ev.barTime, ev.kind, ev.side ?? null, ev.label)) return;
    const refPrice = this.paper.mark(symbol) ?? lastBar.close;
    const now = Date.now();
    let action = 'none'; let positionId: number | null = null;
    const levelsSource = ev.kind === 'entry' ? (ev.sl && ev.tp.length ? 'script' : ev.sl || ev.tp.length ? 'mixed' : 'atr-fallback') : null;
    const sigId = this.db.insertSignal({ at: now, barTime: ev.barTime, scannerId: s.id, scannerName: s.name, symbol, tf, kind: ev.kind, side: ev.side ?? null, price: ev.price ?? null, sl: ev.sl ?? null, tp: ev.tp, score: ev.score ?? null, label: ev.label, message: ev.message, summary: describeEvent(ev), source: ev.source, levelsSource, action, positionId });
    if (sigId === null) return;

    if (ev.kind === 'entry' && ev.side) {
      const atr = lastAtr(bars, 14);
      // entry-time features + ML probability (levels are provisional here: script levels or ATR fallback)
      let features: Record<string, number> | undefined; let mlProb: number | null = null;
      if (this.ml && atr) {
        const price = ev.price && ev.price > 0 ? ev.price : refPrice;
        const levels = resolveLevels({ side: ev.side, price, sl: ev.sl, tp: ev.tp, atr }, this.cfgRef().paper, market.tickSize);
        if (!('error' in levels)) {
          features = this.ml.features({ bars, i: bars.length - 1, ev, entry: price, sl: levels.sl, tp1: levels.tp[0], atr, levelsSource: levels.source });
          const sc = this.ml.score(s.id, features as any); mlProb = sc?.prob ?? null;
        }
      }
      const mlCfg = this.cfgRef().ml;
      const scoreOverride = mlCfg.useAsScore && ev.score === undefined && mlProb !== null ? mlProb * 100 : undefined;
      const gate = this.entryFilter ? this.entryFilter({ scannerId: s.id, scannerName: s.name, symbol, tf, side: ev.side, barTime: ev.barTime, price: ev.price && ev.price > 0 ? ev.price : refPrice, at: now }) : null;
      if (gate && !gate.ok) {
        action = `rejected:${gate.reason ?? 'filter'}`;
      } else if (mlCfg.minProb > 0 && mlProb !== null && mlProb < mlCfg.minProb) {
        action = `rejected:ml ${(mlProb * 100).toFixed(0)}% < ${(mlCfg.minProb * 100).toFixed(0)}%`;
      } else {
        const d = this.paper.onEntry(ev, { scannerId: s.id, scannerName: s.name, symbol, tf, market, atr, refPrice, at: now, signalId: sigId, exitMode, features, mlProb, scoreOverride });
        action = d.action === 'opened' || d.action === 'reversed' ? d.action : `${d.action}:${d.reason ?? ''}`;
        positionId = d.position?.id ?? null;
      }
      if (mlProb !== null) this.db.run('UPDATE signals SET ml_prob=? WHERE id=?', mlProb, sigId);
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
