/**
 * Runs the incubator's shadow pairs on live data and trades them in the shadow book.
 *
 * A shadow pair is a scanner on a market that is not in the live fleet. On each bar close it runs
 * exactly like a live pair (same script run, same extraction, same paper engine logic) but its
 * orders go to a separate book (`bt = 2`) that never touches the live account, its risk limits, the
 * executor or the alerts. Those trades are the incubator's evidence: they happened after the pair
 * was picked, so they are free of the selection bias that makes a backtest screen unreliable.
 *
 * Live scanners always go first: shadow runs are queued a little after each bar close and are
 * skipped entirely when the worker queue is backed up.
 */
import { TF_SECONDS, type AppConfig } from '../config.ts';
import type { CandleStore, Bar } from '../data/candleStore.ts';
import type { PinePool } from '../pine/pool.ts';
import type { ScannerRegistry } from '../scanners/registry.ts';
import type { MarketInfo, PaperEngine } from '../paper/engine.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { applyRules, labelKey } from '../scanners/rules.ts';
import { lastAtr } from '../data/indicators.ts';
import { logger } from '../log.ts';
import { IncubatorStore, type PairRow } from './store.ts';
import { ACTIVE_STAGES } from './cycle.ts';

const log = logger.scoped('incubator');
const SYNC_MS = 5 * 60_000;
const DELAY_MS = 20_000;
const MAX_QUEUE = 300;
/** Time a scan is assumed to need once it starts, kept aside from the staleness budget. */
const RUN_ALLOWANCE_MS = 5_000;

export class ShadowRunner {
  private pairs: PairRow[] = [];
  private seen = new Set<string>();
  private labels = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | null = null;
  private deps: { store: IncubatorStore; cfgRef: () => AppConfig; candles: CandleStore; pool: PinePool; registry: ScannerRegistry; paper: PaperEngine; marketInfo: (symbol: string) => Promise<MarketInfo>; subscribe?: (symbols: string[]) => void };
  readonly stats = { runs: 0, skipped: 0, expired: 0, errors: 0, entries: 0, lastBarAt: 0 };

  constructor(deps: ShadowRunner['deps']) { this.deps = deps; }

  get active(): PairRow[] { return this.pairs; }

  /** Markets the shadow book needs live data for: its pairs, plus any with an open shadow position. */
  symbols(): string[] { return [...new Set([...this.pairs.map(r => r.symbol), ...this.deps.paper.openPositions().map(p => p.symbol)])]; }

  start() {
    // each pair runs on its own timeframe: the daily screen is 15m, but a survey can admit 1h or 4h pairs
    this.deps.candles.on('closed', (e: { symbol: string; tf: string; bar: Bar; historical?: boolean }) => {
      if (!e.historical && this.pairs.some(r => r.tf === e.tf)) this.onBarClosed(e.symbol, e.tf);
    });
    void this.sync();
    this.timer = setInterval(() => void this.sync(), SYNC_MS);
    this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Pick up stage changes made by the daily job or the API, and make sure their candles are live. */
  async sync(): Promise<void> {
    const cfg = this.deps.cfgRef();
    if (!cfg.incubator?.enabled) { this.pairs = []; return; }
    this.pairs = this.deps.store.list(ACTIVE_STAGES).filter(r => r.tf in TF_SECONDS && this.deps.registry.get(r.scannerId)?.status === 'ok');
    // symbols of open shadow positions keep their 1m feed until those positions close
    const symbols = new Set(this.symbols());
    this.deps.subscribe?.([...symbols]);
    for (const symbol of symbols) {
      try {
        for (const tf of new Set(this.pairs.filter(r => r.symbol === symbol).map(r => r.tf))) if (!this.deps.candles.has(symbol, tf)) await this.deps.candles.track(symbol, tf, cfg.historyBars);
        if (!this.deps.candles.has(symbol, '1m')) await this.deps.candles.track(symbol, '1m', 300);
      } catch (e: any) { log.warn(`shadow: cannot track ${symbol}: ${e?.message ?? e}`); }
    }
  }

  private onBarClosed(symbol: string, tf: string) {
    const due = this.pairs.filter(r => r.symbol === symbol && r.tf === tf);
    if (!due.length) return;
    const barAt = Date.now();
    setTimeout(() => {
      if (this.deps.pool.stats.queued > MAX_QUEUE) { this.stats.skipped += due.length; log.warn(`shadow: worker queue ${this.deps.pool.stats.queued} deep, skipping ${due.length} runs on ${symbol}`); return; }
      for (const r of due) this.run(r, barAt).catch(e => { this.stats.errors++; log.warn(`shadow ${r.scannerId} ${symbol}: ${e?.message ?? e}`); });
    }, DELAY_MS).unref();
  }

  /**
   * How long this run is still worth doing. A signal older than `maxSignalAgeSec` is rejected at the
   * engine, so a scan that cannot finish inside what is left of that window should never occupy a
   * worker — it would cost the CPU and still produce a rejected signal.
   */
  private budgetMs(cfg: AppConfig, barAt: number): number {
    const age = cfg.paper.maxSignalAgeSec > 0 ? cfg.paper.maxSignalAgeSec * 1000 : 300_000;
    return Math.max(0, age - (Date.now() - barAt) - RUN_ALLOWANCE_MS);
  }

  private async run(r: PairRow, barAt = Date.now()): Promise<void> {
    const s = this.deps.registry.get(r.scannerId);
    if (!s || s.status !== 'ok') return;
    const cfg = this.deps.cfgRef();
    const bars = this.deps.candles.get(r.symbol, r.tf, { closedOnly: true, limit: cfg.historyBars });
    if (bars.length < 50) return;
    const market = await this.deps.marketInfo(r.symbol);
    // the scanner's configured input overrides, exactly as a live run of it would use
    const inputs = cfg.scanners[s.id]?.inputs;
    const budget = this.budgetMs(cfg, barAt);
    if (budget <= 0) { this.stats.expired++; return; }
    const res = await this.deps.pool.run(
      { scannerId: s.id, source: s.patched, symbol: r.symbol, tf: r.tf, tickSize: market.tickSize, bars, tailBars: 3, plotTail: 400, inputs: inputs && Object.keys(inputs).length ? inputs : undefined },
      { deadlineMs: budget });
    this.stats.runs++; this.stats.lastBarAt = bars.at(-1)!.time;
    if (!res.ok) { if (/too late to be useful/.test(res.error ?? '')) this.stats.expired++; else this.stats.errors++; return; }
    const key = `${r.scannerId}:${r.symbol}:${r.tf}`;
    const prev = this.labels.get(key);
    const current = new Set(res.labels.map(labelKey));
    const newLabelKeys = prev ? new Set([...current].filter(k => !prev.has(k))) : new Set<string>();
    this.labels.set(key, current);
    const lastBar = bars.at(-1)!;
    const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: cfg.scanners[s.id]?.rule ?? null, bars, mode: 'live', newLabelKeys });
    const events = extractEvents(res.alerts, res.shapes, { sinceBarTime: lastBar.time, derived });
    const exitMode = cfg.scanners[s.id]?.exitMode ?? 'both';
    for (const ev of events) {
      const id = `${key}:${ev.barTime}:${ev.kind}:${ev.side ?? ''}:${ev.label}`;
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      if (this.seen.size > 20_000) this.seen = new Set([...this.seen].slice(-10_000));
      const now = Date.now();
      if (ev.kind === 'entry' && ev.side) {
        const d = this.deps.paper.onEntry(ev, { scannerId: s.id, scannerName: s.name, symbol: r.symbol, tf: r.tf, market, atr: lastAtr(bars, 14), refPrice: this.deps.paper.mark(r.symbol) ?? lastBar.close, at: now, signalId: null, exitMode });
        if (d.action === 'opened' || d.action === 'reversed') this.stats.entries++;
      } else if (ev.kind === 'exit') {
        this.deps.paper.onScriptExit(s.id, r.symbol, r.tf, ev.exitType ?? 'close', ev.price, now, exitMode, ev.side);
      }
    }
  }
}
