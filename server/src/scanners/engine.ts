import { SignalInbox, type Delivery, type InboxRow } from './inbox.ts';
import { configFingerprint, sourceHash } from '../paper/fingerprint.ts';
import {ScanRecovery} from './recovery.ts';
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
import { PaperEngine } from '../paper/engine.ts';
import type { MarketInfo } from '../paper/engine.ts';
import { marketSpec } from '../delta/rest.ts';
import { SIMULATION_VERSION } from '../paper/version.ts';
import { runBacktest, type BacktestResult } from '../paper/backtest.ts';
import type { PinePool } from '../pine/pool.ts';
import type { WorkerResult } from '../pine/worker.ts';
import { extractEvents, describeEvent, type ScanEvent } from './extractor.ts';
import { applyRules, labelKey } from './rules.ts';
import type { MlService } from '../ml/service.ts';
import { resolveLevels, trendGateReason, trendNow } from '../paper/logic.ts';
import type { ScannerRegistry, LoadedScanner } from './registry.ts';
import { ScriptHealth } from './health.ts';
import { BarWatermark, MAX_CATCHUP_BARS } from './watermark.ts';
import { backtestPolicy } from '../paper/policy.ts';
import { readingOf } from './reading.ts';

const log = logger.scoped('scanner');

export interface RunInfo { at: number; ms: number; symbol: string; tf: string; error: string | null; barTime: number | null; funnel?: RunFunnel }
/** What one run produced and where it emptied: raw outputs → events → dropped-with-reason → signal outcomes (decision 77). */
export interface RunFunnel {
  raw: { alerts: number; conditions: number; shapes: number; labels: number; plots: number };
  events: { entries: number; exits: number; info: number };
  drops: Record<string, number>;
  /** Outcomes of this bar's signals: opened, pending, reversed, info, and rejected/ignored by reason. */
  actions: Record<string, number>;
  note?: string;
}

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
  /** Incubator owns allocation when enabled; backtests then produce recommendations only. */
  applied?: boolean;
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
  /** Decision 191: an exchange-mirrored account enters at market, so its backtests do too. */
  executorAttached?: () => boolean;
  private registry: ScannerRegistry;
  readonly health: ScriptHealth;
  private cfgRef: () => AppConfig;
  private candles: CandleStore;
  private pool: PinePool;
  private paper: PaperEngine;
  private db: Db;
  readonly inbox: SignalInbox;
  private inboxTimer: ReturnType<typeof setInterval> | null = null;
  private processingReceipts = new Set<string>();
  private stopping = false;
  /** Decision 125: the last bar each live pair acted on, so a deferred or skipped bar's exits are still read. */
  private marks: BarWatermark;
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
    this.registry = deps.registry; this.health = new ScriptHealth(deps.db); this.cfgRef = deps.cfgRef; this.candles = deps.candles; this.pool = deps.pool; this.paper = deps.paper; this.db = deps.db; this.rest = deps.rest;
    this.inbox = new SignalInbox(this.db);
    this.marks = new BarWatermark({ load: () => this.db.kvGet<Record<string, number>>('scanner.liveMarks'), save: rec => this.db.kvSet('scanner.liveMarks', rec) });
    // decision 201: every account run, kept for 14 days — scanner_runs holds only the latest row per cell, so a recovered
    // cell hid the failures before it
    this.db.run('CREATE TABLE IF NOT EXISTS scanner_run_log (scanner_id TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL, at INTEGER NOT NULL, bar_time INTEGER, ms INTEGER, outcome TEXT NOT NULL, error TEXT)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_scanner_run_log ON scanner_run_log(at)');
    this.symbolsRef = deps.symbolsRef ?? (() => this.cfgRef().symbols);
    this.ml = deps.ml ?? null;
    this.cfgStore = deps.cfgStore ?? null;
    // every closed live trade becomes a learning sample
    this.paper.on('trade', (t: any) => { if (this.ml && t.features) this.ml.addLiveSample(t.scannerId, t.symbol, t.tf, t.entryAt, t.features, t.pnl > 0, t.rMultiple ?? 0, t.pnl, String(t.exitReason ?? ''), t.exitAt); });
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
  symbolsFor(id: string): string[] { return [...new Set(this.pairsFor(id).map(p => p.symbol))]; }
  timeframesFor(id: string): string[] { return [...new Set(this.pairsFor(id).map(p => p.tf))]; }
  /** The (market, timeframe) pairs this scanner runs on: its explicit pairs (decision 70), else symbols × timeframes. */
  pairsFor(id: string): Array<{ symbol: string; tf: string }> {
    // A scanner runs only where it was explicitly put (decision 79): its pairs, or the symbols listed in
    // its own config × its timeframes. The global symbol list never feeds a scanner: seventy scanners
    // bulk-enabled with no symbols of their own once became 1,260 live cells overnight.
    const c = this.scannerConfig(id);
    if (c.pairs?.length) return c.pairs.map(p => ({ symbol: p.symbol, tf: p.tf }));
    if (!c.symbols?.length) return [];
    const out: Array<{ symbol: string; tf: string }> = [];
    for (const symbol of c.symbols) for (const tf of c.timeframes ?? this.cfgRef().timeframes) out.push({ symbol, tf });
    return out;
  }
  runsOn(id: string, symbol: string, tf: string): boolean { return this.pairsFor(id).some(p => p.symbol === symbol && p.tf === tf); }
  /** Quarantined scripts are not scheduled: they failed in a way that repeats (see health.ts). */
  isActive(s: LoadedScanner): boolean { const c = this.scannerConfig(s.id); return s.status === 'ok' && c.enabled && !c.hidden && !this.health.isQuarantined(s.id); }

  /** All (symbol, tf) pairs any active scanner needs. */
  requiredSeries(): Array<{ symbol: string; tf: string }> {
    const set = new Map<string, { symbol: string; tf: string }>();
    for(const r of this.cfgRef().paper.entryAlignments??[])set.set(`${r.symbol}:${r.contextTf}`,{symbol:r.symbol,tf:r.contextTf});
    for (const s of this.registry.all()) {
      if (!this.isActive(s)) continue;
      for (const { symbol, tf } of this.pairsFor(s.id)) set.set(`${symbol}:${tf}`, { symbol, tf });
    }
    return [...set.values()];
  }

  async marketInfo(symbol: string): Promise<MarketInfo> {
    let m = this.markets.get(symbol);
    if (m) return m;
    const p = await this.rest.product(symbol);
    m = marketSpec(p);
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
    const apply=!this.cfgRef().incubator?.enabled;
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
        report.push({ id: s.id, name: s.name, applied:false, before, after: before, beforeTimeframes: tfs, afterTimeframes: tfs, disabled: false,
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
      // decision 82: a scanner scheduled by explicit pairs keeps the pairs that passed, never a rebuilt symbols × timeframes product
      const scPairs = this.scannerConfig(s.id).pairs;
      if (apply && scPairs?.length) {
        const kept = scPairs.filter(p => decisions.some(d=>d.keep&&d.symbol===p.symbol&&(d.tf===null||d.tf===p.tf)));
        this.cfgStore?.setScanner(s.id, kept.length ? { pairs: kept } : { enabled: false });
      } else if(apply)this.cfgStore?.setScanner(s.id, disabled ? { enabled: false } : byTf ? { symbols: keepSymbols, timeframes: keepTfs } : { symbols: keepSymbols });
      const provisional = decisions.some(d => d.rule === 'provisional');
      report.push({ id: s.id, name: s.name, applied:apply, before, after: keepSymbols, beforeTimeframes: tfs, afterTimeframes: disabled ? tfs : keepTfs, disabled, rule: oos ? 'oos' : 'in-sample', provisional, dropped, decisions });
      log.info(`${apply ? 'auto-tune applied' : 'backtest recommendation'} ${s.id} [${oos ? 'oos' : 'in-sample'}${provisional ? ', provisional' : ''}]: ${before.length} → ${keepSymbols.length} symbols${byTf ? `, ${tfs.length} → ${keepTfs.length} tfs` : ''}${disabled ? (apply ? ' (disabled: no profitable pair)' : ' (would disable: no profitable pair)') : ''}`);
    }
    this.lastAutoTune = { at: Date.now(), reason: opts.reason ?? 'manual', report };
    return report;
  }

  // ---- lifecycle ----

  /** Track all needed candle series and warm every active scanner (backtest + first live run). */
  async start(): Promise<void> {
    this.stopping=false;
    await this.recoverSignals();
    if(!this.inboxTimer){this.inboxTimer=setInterval(()=>void this.recoverSignals().catch(e=>log.error(`signal recovery failed: ${e?.message??e}`)),5000);this.inboxTimer.unref();}
    const cfg = this.cfgRef();
    const required = this.requiredSeries();
    await Promise.all(required.map(r => this.candles.track(r.symbol, r.tf, cfg.historyBars)));
    for (const s of new Set([...this.symbolsRef(), ...required.map(r => r.symbol)])) await this.candles.track(s, '1m', 300); // fill engine price feed
    const jobs: Promise<void>[] = [];
    for (const s of this.registry.all()) if (this.isActive(s)) for (const { symbol, tf } of this.pairsFor(s.id)) jobs.push(this.warm(s, symbol, tf));
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
    if (!at?.enabled || this.cfgRef().incubator?.enabled) return;
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
    if (!at?.enabled || this.stopping || this.cfgRef().incubator?.enabled) return;
    this.retuneTimer = setTimeout(async () => {
      this.retuneTimer = null;
      try {
        const jobs: Promise<void>[] = [];
        for (const s of this.registry.all()) if (this.isActive(s)) for (const { symbol, tf } of this.pairsFor(s.id)) jobs.push(this.runOnce(s, symbol, tf, { backtest: true, live: false }));
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
    for (const s of this.registry.all()) if (this.isActive(s)) for (const { symbol, tf } of this.pairsFor(s.id)) {
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
    // a backtest from the last six hours is fresh enough (decision 80): a restart must not re-run the fleet's history
    if (prev && Date.now() - prev.at < 6 * 3600_000 && (prev.trades.length === 0 || (prev.trades[0] as any).features)) { log.debug(`warm ${key}: fresh backtest, skipping`); return; }
    try {
      await this.runOnce(s, symbol, tf, { backtest: true, live: true });
    } catch (e: any) { log.error(`warm ${key} failed: ${e?.message ?? e}`); }
  }

  runNow(id: string): number {
    const s = this.registry.get(id);
    if (!s || s.status !== 'ok') return 0;
    let n = 0;
    for (const { symbol, tf } of this.pairsFor(id)) { n++; this.runOnce(s, symbol, tf, { backtest: true, live: true }).catch(e => log.error(`run ${id} failed: ${e?.message ?? e}`)); }
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
    if(this.stopping)return;
    const active = this.registry.all().filter(s => this.isActive(s) && this.runsOn(s.id, symbol, tf));
    if (!active.length) return;
    // backpressure: if the worker queue is already deep (warm-up or an earlier bar still running), skip this bar for this symbol
    // only live work counts here: background jobs queue behind live ones and cannot delay them
    if (this.pool.stats.queuedLive > 500) { for (const s of active) this.logRun(s.id, symbol, tf, bar.time, null, 'skipped', `live queue ${this.pool.stats.queuedLive} deep`); log.warn(`bar closed ${symbol} ${tf}: ${this.pool.stats.queuedLive} live runs already queued — skipping live runs for this bar (reduce scanners × symbols)`); return; }
    log.info(`bar closed ${symbol} ${tf} @ ${new Date(bar.time).toISOString().slice(11, 16)} → running ${active.length} scanners`);
    for (const s of active) this.runOnce(s, symbol, tf, { backtest: false, live: true }).catch(e => log.error(`run ${s.id} ${symbol} ${tf} failed: ${e?.message ?? e}`));
  }

  readonly recovery = new ScanRecovery();
  private lastPrune = 0;
  /** Decision 201: one row per account run (ok, failed or skipped), pruned to 14 days. */
  private logRun(scannerId: string, symbol: string, tf: string, barTime: number | null, ms: number | null, outcome: 'ok' | 'failed' | 'skipped', error: string | null) {
    try {
      const now = Date.now();
      this.db.run('INSERT INTO scanner_run_log(scanner_id, symbol, tf, at, bar_time, ms, outcome, error) VALUES (?,?,?,?,?,?,?,?)', scannerId, symbol, tf, now, barTime, ms, outcome, error ? error.slice(0, 300) : null);
      if (now - this.lastPrune > 3600_000) { this.lastPrune = now; this.db.run('DELETE FROM scanner_run_log WHERE at < ?', now - 14 * 86_400_000); }
    } catch (e: any) { log.warn(`run log not written: ${e?.message ?? e}`); }
  }

  /** Decision 201: each account cell's runs over the last `hours` — the record the latest-row status hides. */
  runHealth(hours = 24): Array<{ scannerId: string; symbol: string; tf: string; ok: number; failed: number; skipped: number; lastFailAt: number | null; lastError: string | null }> {
    return this.db.all<any>(`SELECT scanner_id scannerId, symbol, tf, SUM(outcome='ok') ok, SUM(outcome='failed') failed, SUM(outcome='skipped') skipped,
      MAX(CASE WHEN outcome!='ok' THEN at END) lastFailAt, (SELECT error FROM scanner_run_log l2 WHERE l2.scanner_id=l.scanner_id AND l2.symbol=l.symbol AND l2.tf=l.tf AND l2.outcome!='ok' ORDER BY at DESC LIMIT 1) lastError
      FROM scanner_run_log l WHERE at >= ? GROUP BY scanner_id, symbol, tf ORDER BY (SUM(outcome!='ok')) DESC, scanner_id`, Date.now() - hours * 3600_000);
  }

  /** Store what this run produced and where it emptied, on the run record and in the row the Scanners page reads. */
  private recordFunnel(id: string, symbol: string, tf: string, info: RunInfo, res: WorkerResult, events: RunFunnel['events'], drops: Record<string, number>, actions: string[], note?: string) {
    const tally: Record<string, number> = {};
    for (const a of actions) {
      const k = a === 'opened' || a === 'reversed' || a === 'info' || a === 'none' ? a : a.startsWith('pending') ? 'pending' : `${a.split(':')[0]}: ${(a.split(':')[1] ?? '').trim().slice(0, 60)}`;
      tally[k] = (tally[k] ?? 0) + 1;
    }
    info.funnel = {
      raw: { alerts: res.alerts.filter(a => a.type === 'alert').length, conditions: res.alerts.filter(a => a.type === 'alertcondition').length, shapes: res.shapes.reduce((n, sh) => n + sh.times.length, 0), labels: res.labels.length, plots: res.plots.length },
      events, drops, actions: tally, ...(note ? { note } : {}),
    };
    try { this.db.run('UPDATE scanner_runs SET funnel=? WHERE scanner_id=? AND symbol=? AND tf=?', JSON.stringify(info.funnel), id, symbol, tf); } catch { /* the record is advisory */ }
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
    // decision 184: compared by value — a config write that rebuilds an unchanged object must not discard the run's events
    const scannerConfigAtStart = JSON.stringify(this.cfgRef().scanners[s.id] ?? null);
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
      const runJob = async (b: Bar[], tailBars: number | 'all') => {
        const live=mode.live && tailBars!=='all';
        const deadline=b.at(-1)!.time+(TF_SECONDS[tf]??0)*1000+Math.min(cfg.paper.maxSignalAgeSec||300,300)*1000;
        const execute=(retry=false)=>this.pool.run({scannerId:s.id,source:s.patched,symbol,tf,tickSize:market.tickSize,bars:b,tailBars,plotTail:rule?b.length:400,inputs,timezone:sc.timezone},
          {priority:live?'live':'background',...(retry?{deadlineMs:Math.max(1,deadline-Date.now())}:{})});
        const first=await execute();
        if(!live||first.ok||!first.error?.startsWith('memory-shared:'))return first;
        return this.recovery.recover(first,()=>{
          this.logRun(s.id,symbol,tf,b.at(-1)!.time,first.ms,'failed',first.error??null);
          log.info(`${key}: retrying current bar after shared memory pressure`);
          return execute(true);
        },
          ()=>this.isActive(s)&&this.runsOn(s.id,symbol,tf)&&JSON.stringify(this.cfgRef().scanners[s.id]??null)===scannerConfigAtStart
            &&this.candles.get(symbol,tf,{closedOnly:true,limit:1}).at(-1)?.time===b.at(-1)!.time,
          ()=>this.pool.rssReader()<this.pool.memoryGuardBytes*.9,deadline);
      };
      // decision 193: the live job returns every bar back to the watermark (capped), so a stall's exits are still there to read
      const READ = readingOf(cfg.scanners[s.id], s.id, (TF_SECONDS[tf] ?? 0) * 1000, s.patched, s.variantOf);   // decision 195
      const win = this.marks.window(key, bars.at(-1)!.time, tf);
      const res = await runJob(mode.backtest ? btBars : bars, mode.backtest ? 'all' : win.tailBars);
      // a deep backtest run does not see the last bars the way the live run does → separate live run
      const liveRes = mode.live && btBars !== bars ? await runJob(bars, win.tailBars) : res;
      if (mode.live && win.missed > 0) log.warn(`${key}: ${win.missed} bar(s) since the last acted-on bar are beyond the ${MAX_CATCHUP_BARS}-bar catch-up; exits raised there were not read`);
      const info: RunInfo = { at, ms: res.ms + (liveRes === res ? 0 : liveRes.ms), symbol, tf, error: res.ok ? null : res.error ?? 'unknown', barTime: bars.at(-1)!.time };
      this.lastRun.set(key, info);
      this.db.run('INSERT INTO scanner_runs(scanner_id, symbol, tf, at, ms, error, bar_time) VALUES (?,?,?,?,?,?,?) ON CONFLICT(scanner_id, symbol, tf) DO UPDATE SET at=excluded.at, ms=excluded.ms, error=excluded.error, bar_time=excluded.bar_time', s.id, symbol, tf, at, res.ms, info.error, info.barTime);
      if (mode.live) { const err = res.ok && liveRes.ok ? null : (liveRes.ok ? res.error : liveRes.error) ?? 'unknown'; this.logRun(s.id, symbol, tf, info.barTime, res.ms + (liveRes === res ? 0 : liveRes.ms), err ? 'failed' : 'ok', err); }
      if (!res.ok) {
        log.warn(`${key} error: ${res.error}`);
        if (this.health.record(s.id, res.error)) log.warn(`${s.id} quarantined: ${res.error} — it will not be scheduled again until released`);
        this.emit('scanner', { id: s.id, lastRun: info });
        return;
      }
      this.health.clear(s.id);
      const ov = liveRes.ok ? liveRes : res;
      this.overlays.set(key, { at, plots: ov.plots, shapes: ov.shapes, labels: ov.labels });

      const exitMode: ExitMode = sc.exitMode;
      const prevLabels = this.seenLabels.get(key);
      const currentLabels = new Set(ov.labels.map(labelKey));
      const newLabelKeys = prevLabels ? new Set([...currentLabels].filter(k => !prevLabels.has(k))) : new Set<string>();
      this.seenLabels.set(key, currentLabels);
      if (mode.backtest) {
        const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule, bars: btBars, mode: 'backtest', ...READ.rule });
        const events = extractEvents(res.alerts, res.shapes, { barMs: (TF_SECONDS[tf] ?? 0) * 1000, drawn: res.labels, scannerId: s.id, derived, ...READ.extract });
        // decision 191: the account's own policy — entry model, exit rules with script protection, trend and chop gates
        const bt = runBacktest({ scannerId: s.id, scannerName: s.name, symbol, tf, bars: btBars, events, ...backtestPolicy(this.cfgRef(), s.id, tf, 'account', { executor: this.executorAttached?.() }), exitMode, contractValue: market.contractValue, tickSize: market.tickSize });
        this.backtests.set(key, bt);
        if (this.ml) this.ml.replaceBacktestSamples(s.id, symbol, tf, bt.trades.filter((t: any) => t.features).map((t: any) => ({ at: t.entryAt, features: t.features, win: t.pnl > 0, r: t.rMultiple ?? 0, pnl: t.pnl, exitReason: String(t.exitReason ?? ''), resolvedAt: t.exitAt ?? null })));
        this.db.run('INSERT INTO backtests(scanner_id, symbol, tf, at, bars, result) VALUES (?,?,?,?,?,?) ON CONFLICT(scanner_id, symbol, tf) DO UPDATE SET at=excluded.at, bars=excluded.bars, result=excluded.result', s.id, symbol, tf, bt.at, bt.bars, JSON.stringify(bt));
        log.info(`backtest ${key}: ${bt.stats.trades} trades, win ${bt.stats.winRatePct.toFixed(0)}%, pnl ${bt.stats.pnl.toFixed(0)} (${res.ms}ms)`);
      }
      // A pending job cannot trade after disable/removal or a configuration change.
      if (mode.live && this.isActive(s) && JSON.stringify(this.cfgRef().scanners[s.id] ?? null) === scannerConfigAtStart
          && this.runsOn(s.id, symbol, tf)) {
        const lastBar = bars.at(-1)!;
        if (!liveRes.ok) { log.warn(`${key} live run error: ${liveRes.error}`); return; }
        // A run that was not triggered by this bar's close — a warm-up, a newly enabled scanner, a
        // config change — looks at whatever bar closed last, which on 15m averages seven minutes old.
        // Acting on it is impossible (the engine rejects it as stale), so emitting the signal only
        // fills the feed with rows that can never become trades.
        const maxAge = cfg.paper.maxSignalAgeSec ?? 0;
        const barAge = PaperEngine.signalAgeSec({ barTime: lastBar.time }, tf, Date.now());
        if (maxAge > 0 && barAge > maxAge) {
          // decision 193: entries on an old bar are stale, but an exit raised since the watermark still reduces risk
          const staleDerived = applyRules({ scannerId: s.id, alerts: liveRes.alerts, shapes: liveRes.shapes, labels: liveRes.labels, plots: liveRes.plots, rule, bars, mode: 'live', newLabelKeys, ...READ.rule });
          const exits = extractEvents(liveRes.alerts, liveRes.shapes, { drawn: liveRes.labels, scannerId: s.id, sinceBarTime: win.since, derived: staleDerived, ...READ.extract })
            .filter(ev => ev.kind === 'exit');
          for (const ev of exits) await this.handleLiveEvent(s, symbol, tf, ev, bars, market, exitMode, lastBar);
          this.recordFunnel(s.id, symbol, tf, info, liveRes, { entries: 0, exits: 0, info: 0 }, {}, [], `bar ${barAge.toFixed(0)}s old (max ${maxAge}s): stats only, no live signals`);
          this.marks.advance(key, lastBar.time);
          log.debug(`${key}: last closed bar is ${barAge.toFixed(0)}s old (max ${maxAge}s) — stats only, no live signals`);
          this.emit('scanner', { id: s.id, lastRun: info, stats: this.paper.scannerStats(s.id) });
          return;
        }
        const derived = applyRules({ scannerId: s.id, alerts: liveRes.alerts, shapes: liveRes.shapes, labels: liveRes.labels, plots: liveRes.plots, rule, bars, mode: 'live', newLabelKeys, ...READ.rule });
        const drops: Record<string, number> = {};
        // decision 125: read from the bar after the last one this pair acted on, so an exit on a deferred or skipped bar is seen
        const since = win.since;
        const events = extractEvents(liveRes.alerts, liveRes.shapes, { drawn: liveRes.labels, scannerId: s.id, sinceBarTime: since, derived, ...READ.extract, drops })
          .filter(ev => { if (ev.kind === 'entry' && ev.barTime < lastBar.time) { drops['entry: superseded bar'] = (drops['entry: superseded bar'] ?? 0) + 1; return false; } return true; });
        if (since < lastBar.time && events.some(ev => ev.barTime < lastBar.time)) log.info(`${key}: ${events.filter(ev => ev.barTime < lastBar.time).length} event(s) from a superseded bar read on this run`);
        for (const ev of events) await this.handleLiveEvent(s, symbol, tf, ev, bars, market, exitMode, lastBar);
        this.marks.advance(key, lastBar.time);
        const acts = this.db.all<{ action: string }>('SELECT action FROM signals WHERE scanner_id=? AND symbol=? AND tf=? AND bar_time=?', s.id, symbol, tf, lastBar.time).map(r => r.action);
        this.recordFunnel(s.id, symbol, tf, info, liveRes, { entries: events.filter(e => e.kind === 'entry').length, exits: events.filter(e => e.kind === 'exit').length, info: events.filter(e => e.kind === 'info').length }, drops, acts);
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

  /**
   * Why the trend gate refuses this entry, or null. The scanner's own mode wins over the default, so
   * a mean-reversion scanner can fade the trend while a breakout scanner follows it (decision 33).
   */
  trendGateBlock(scannerId: string, symbol: string, tf: string, side: 'long' | 'short'): string | null {
    const cfg = this.cfgRef();
    const g = cfg.paper.trendGate;
    if (!g?.enabled) return null;
    const mode = this.scannerConfig(scannerId).trendGate ?? g.mode;
    if (mode === 'off') return null;
    const trendTf = g.tf && g.tf !== tf ? g.tf : tf;
    const closes = this.candles.get(symbol, trendTf, { closedOnly: true, limit: g.emaLen * 4 }).map(b => b.close);
    return trendGateReason(side, trendNow(closes, g.emaLen), mode);
  }

  /**
   * Decision 116: a shadow pair's event offered to the account. It goes down the same path as a live scanner's —
   * the signal row, the trend gate, the risk manager's gates and caps, the probability, the paper engine — with
   * its label marked so the Signals page says where it came from. The shadow book keeps its own copy.
   */
  async ingestEvent(s: LoadedScanner, symbol: string, tf: string, ev: ScanEvent, bars: Bar[], market: MarketInfo, exitMode: ExitMode, lastBar: Bar): Promise<void> {
    await this.handleLiveEvent(s, symbol, tf, ev, bars, market, exitMode, lastBar, true);
  }

  /** Stop recovery and future scanner intake before worker shutdown. */
  stop() {
    this.stopping=true;
    if(this.inboxTimer)clearInterval(this.inboxTimer);this.inboxTimer=null;
    if(this.retuneTimer)clearTimeout(this.retuneTimer);this.retuneTimer=null;
  }

  async recoverSignals():Promise<void>{
    if(this.stopping)return;
    for(const row of this.inbox.pending()){
      try{await this.processReceipt(row,true);}catch(e){log.warn(`signal #${row.signal_id} recovery pending: ${(e as Error).message}`);}
    }
  }

  private deliveryFingerprint(s:LoadedScanner,tf:string):string {
    return configFingerprint(this.cfgRef(),s.id,tf,{source:sourceHash(s.patched),book:0}).fp;
  }

  private async handleLiveEvent(s: LoadedScanner, symbol: string, tf: string, ev: ScanEvent, bars: Bar[], market: MarketInfo, exitMode: ExitMode, lastBar: Bar, copied = false) {
    if(this.stopping)throw new Error('scanner is stopping before signal receipt');
    const now=Date.now();
    const delivery:Delivery={version:1,scannerId:s.id,scannerName:s.name,symbol,tf,ev,bars,market,exitMode,lastBar,copied,
      pilotRequested:copied&&!(this.isActive(s)&&this.runsOn(s.id,symbol,tf))&&Boolean(this.cfgRef().incubator.mirror?.pilot),
      fingerprint:this.deliveryFingerprint(s,tf),
      accountResetAt:this.db.kvGet<number>('paper.resetAt')??null,
      targetPositionId:this.paper.openPositions().find(p=>p.scannerId===s.id&&p.symbol===symbol&&p.tf===tf&&(!ev.side||p.side===ev.side))?.id??null,
      targetPendingIds:this.paper.pendingEntries().filter(p=>p.scannerId===s.id&&p.symbol===symbol&&p.tf===tf&&(!ev.side||p.side===ev.side)).map(p=>p.id)};
    const label=copied?`${ev.label} (shadow mirror)`.slice(0,80):ev.label;
    const levelsSource=ev.kind==='entry'?(ev.sl&&ev.tp.length?'script':ev.sl||ev.tp.length?'mixed':'atr-fallback'):null;
    const row=this.inbox.accept(delivery,{at:now,barTime:ev.barTime,scannerId:s.id,scannerName:s.name,symbol,tf,kind:ev.kind,side:ev.side??null,
      price:ev.price??null,sl:ev.sl??null,tp:ev.tp,score:ev.score??null,label,message:ev.message,summary:describeEvent(ev),source:ev.source,levelsSource,
      action:'received:awaiting decision',positionId:null});
    if(row?.state==='pending')await this.processReceipt(row,row.attempts>0);
  }

  private async processReceipt(row:InboxRow,recovery:boolean):Promise<void>{
    if(this.stopping||this.processingReceipts.has(row.event_key))return;
    this.processingReceipts.add(row.event_key);
    try{
      const current=this.db.get<InboxRow>('SELECT * FROM signal_inbox WHERE event_key=?',row.event_key);
      if(!current||current.state==='done'||!current.payload)return;
      const delivery=JSON.parse(current.payload) as Delivery;
      if(delivery.version!==1)throw new Error('unsupported signal receipt version');
      this.inbox.attempt(row);
      // Exchange command recovery needs its own reconciliation; never replay a paper receipt into it.
      if(recovery&&this.cfgRef().execution.mode!=='paper')throw new Error('signal recovery paused outside paper mode; reconciliation required');
      const loaded=this.registry.get?.(delivery.scannerId)??this.registry.all().find(s=>s.id===delivery.scannerId);
      const scanner=loaded??({id:delivery.scannerId,name:delivery.scannerName} as LoadedScanner);
      const invalidEntry=()=>{
        if(delivery.ev.kind!=='entry')return null;
        if(delivery.accountResetAt!==(this.db.kvGet<number>('paper.resetAt')??null))return 'rejected:account reset before signal decision';
        const maxMs=Math.min(60_000,(this.cfgRef().paper.maxSignalAgeSec||60)*1000);
        if(Date.now()-row.received_at>maxMs)return 'rejected:interrupted entry expired before recovery';
        if(!loaded||this.deliveryFingerprint(loaded,delivery.tf)!==delivery.fingerprint)return 'rejected:source or policy changed before signal decision';
        if(!delivery.copied&&(!this.isActive(loaded)||!this.runsOn(loaded.id,delivery.symbol,delivery.tf)))return 'rejected:scanner allocation no longer active';
        return null;
      };
      if(!invalidEntry()&&delivery.ev.kind==='entry')await this.paper.prepareEntryDepth?.(delivery.symbol);
      if(this.stopping)return;
      const blocked=invalidEntry();
      const target=this.paper.openPositions().find(p=>p.id===delivery.targetPositionId);
      if(recovery&&!blocked&&(delivery.ev.kind==='entry'||(delivery.ev.kind==='exit'&&target&&delivery.exitMode!=='levels'))){
        const side=delivery.ev.kind==='entry'?(delivery.ev.side==='long'?'buy':'sell'):(target?.side==='long'?'sell':'buy');
        if(!this.paper.hasFreshPrice(delivery.symbol,side))throw new Error('waiting for fresh market price after interruption');
      }
      this.paper.commitDecision(()=>{
        const result=blocked?{action:blocked,positionId:null}:this.applyDelivery(scanner,delivery,row.signal_id,recovery);
        this.inbox.complete(row,result.action,result.positionId);
      });
      const sig=this.db.signalById(row.signal_id);
      if(sig){this.emit('signal',sig);log.info(`SIGNAL ${sig.kind} ${sig.symbol} ${sig.tf} ${sig.label} → ${sig.action} [${sig.scannerId}]`);}
    }catch(e){this.inbox.fail(row,e);throw e;}
    finally{this.processingReceipts.delete(row.event_key);}
  }

  private applyDelivery(s:LoadedScanner,delivery:Delivery,sigId:number,recovery=false):{action:string;positionId:number|null}{
    const {symbol,tf,bars,market,exitMode,lastBar,copied,pilotRequested}=delivery;
    const ev=recovery&&delivery.ev.kind==='entry'?{...delivery.ev,price:this.paper.mark(symbol)??delivery.ev.price}:delivery.ev;
    const refPrice=this.paper.mark(symbol)??lastBar.close,now=Date.now();
    let action='none',positionId:number|null=null;
    if (ev.kind === 'entry' && ev.side) {
      const atr = lastAtr(bars, 14);
      // entry-time features + ML probability (levels are provisional here: script levels or ATR fallback)
      let features: Record<string, number> | undefined; let mlProb: number | null = null;
      if (this.ml && atr) {
        const price = ev.price && ev.price > 0 ? ev.price : refPrice;
        const levels = resolveLevels({ side: ev.side, price, sl: ev.sl, tp: ev.tp, atr }, this.cfgRef().paper, market.tickSize);
        if (!('error' in levels)) {
          features = this.ml.features({ bars, i: bars.length - 1, ev, entry: price, sl: levels.sl, tp1: levels.tp[0], atr, levelsSource: levels.source });
          const sc = this.ml.score(s.id, features as any, { tf }); mlProb = sc?.prob ?? null;
        }
      }
      const mlCfg = this.cfgRef().ml;
      const scoreOverride = mlCfg.useAsScore && ev.score === undefined && mlProb !== null ? mlProb * 100 : undefined;
      const trendBlock = this.trendGateBlock(s.id, symbol, tf, ev.side);
      const gate = trendBlock ? null : this.entryFilter ? this.entryFilter({ scannerId: s.id, scannerName: s.name, symbol, tf, side: ev.side, barTime: ev.barTime, price: ev.price && ev.price > 0 ? ev.price : refPrice, at: now }) : null;
      const configNow = this.cfgRef();
      const pilot = copied && !(this.isActive(s) && this.runsOn(s.id, symbol, tf)) ? configNow.incubator.mirror?.pilot : undefined;
      const pilotDay = Math.floor(now / 86400_000);
      const savedPilot = this.db.kvGet<{day:number;entries:number}>('incubator.copyPilot');
      const pilotEntries = savedPilot?.day === pilotDay ? savedPilot.entries : 0;
      const pilotOpen = [...this.paper.openPositions(), ...this.paper.pendingEntries()].filter(p => p.features?.copy_pilot === 1).length;
      const pilotBlock = copied && (!configNow.incubator.mirror?.enabled || (pilotRequested && !pilot)) ? 'copy pilot disabled' : pilot ? configNow.execution.mode !== 'paper' || !configNow.incubator.mirror?.enabled ? 'copy pilot disabled' : pilotEntries >= pilot.maxDailyEntries ? 'copy pilot daily entry limit' : pilotOpen >= pilot.maxOpenPositions ? 'copy pilot open position limit' : null : null;
      if (pilotBlock) {
        action = `rejected:${pilotBlock}`;
      } else if (trendBlock) {
        action = `rejected:${trendBlock}`;
      } else if (gate && !gate.ok) {
        action = `rejected:${gate.reason ?? 'filter'}`;
      } else if (mlCfg.minProb > 0 && mlProb !== null && mlProb < mlCfg.minProb) {
        action = `rejected:ml ${(mlProb * 100).toFixed(0)}% < ${(mlCfg.minProb * 100).toFixed(0)}%`;
      } else {
        const d = this.paper.onEntry(ev, { scannerId: s.id, scannerName: s.name, symbol, tf, market, atr, refPrice, at: now, signalId: sigId, exitMode, features: pilot ? {...features,copy_pilot:1} : features, mlProb, scoreOverride, sizeScale: pilot?.sizeScale });
        if (pilot && ['opened','reversed','pending'].includes(d.action)) this.db.kvSet('incubator.copyPilot',{day:pilotDay,entries:pilotEntries+1});
        action = d.action === 'opened' || d.action === 'reversed' ? d.action : `${d.action}:${d.reason ?? ''}`;
        positionId = d.position?.id ?? d.pendingId ?? null;
      }
      if (mlProb !== null) this.db.run('UPDATE signals SET ml_prob=? WHERE id=?', mlProb, sigId);
    } else if (ev.kind === 'exit') {
      const pos = this.paper.onScriptExit(s.id, symbol, tf, ev.exitType ?? 'close', ev.price, now, exitMode, ev.side, {positionId:delivery.targetPositionId,pendingIds:delivery.targetPendingIds});
      action = pos ? (pos.status === 'closed' ? 'closed' : 'reduced') : 'ignored:no position';
      positionId = pos?.id ?? null;
    } else {
      action = 'info';
    }
    return {action,positionId};
  }
}
