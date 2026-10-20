import { lastAtr } from './data/indicators.ts';
import { scriptModeExit, scriptModeProtection, trendSide } from './paper/logic.ts';
import { IncubatorStore } from './incubator/store.ts';
import { ShadowRunner } from './incubator/shadow.ts';
import { dailyReport } from './analytics/daily.ts';
import { listTrackers, removeTracker, saveTracker, trackerView } from './incubator/tracker.ts';
import { approve as incubatorApprove, demote as incubatorDemote, reject as incubatorReject, evaluate as incubatorEvaluate, admitOnly as incubatorAdmitOnly, candidateBlockers, syncLive as incubatorSyncLive, autoPromote as incubatorAutoPromote, livePairs } from './incubator/cycle.ts';
import { pairStats } from './incubator/gate.ts';
import { ConfigStore, type ScannerConfig, DATA_DIR, type AppConfig } from './config.ts';
import { learnBook } from './analytics/learning.ts';
import { goLive } from './analytics/golive.ts';
import { ContextCollector } from './context/collector.ts';
import { CandleStore } from './data/candleStore.ts';
import { Db } from './db.ts';
import { DeltaRest } from './delta/rest.ts';
import { DeltaFeed, type WsTicker } from './delta/ws.ts';
import { logger } from './log.ts';
import { configFingerprint } from './paper/fingerprint.ts';
import { PaperEngine } from './paper/engine.ts';
import { PinePool } from './pine/pool.ts';
import { ScannerEngine } from './scanners/engine.ts';
import { ScannerRegistry } from './scanners/registry.ts';
import { createExecutor, type ExchangeExecutor } from './execution/testnet.ts';
import { subscribeRealtime, wireRealtime } from './execution/wiring.ts';
import { TF_SECONDS } from './config.ts';
import { MarketGate } from './risk/marketGate.ts';
import { ProfileStore, brokenRun, classifyRun, summarizeKind, type ProfileRow } from './scanners/profile.ts';
import { extractEvents } from './scanners/extractor.ts';
import { applyRules } from './scanners/rules.ts';
import { MarkStore } from './data/marks.ts';
import { RiskManager } from './risk/manager.ts';
import { MlService } from './ml/service.ts';
import { FeatureEnricher } from './ml/enrich.ts';
import { theCall, yardstick, type YardTrade } from './ml/yardstick.ts';
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
  /** The incubator's shadow book: same engine, separate rows (`bt = 2`), never the live account. */
  readonly shadow: PaperEngine;
  readonly incubatorStore: IncubatorStore;
  readonly incubator: ShadowRunner;
  readonly ml: MlService;
  /** Decision 108: entry-time features for trades opened without them, costed once from the candle store. */
  readonly enricher: FeatureEnricher;
  readonly scanners: ScannerEngine;
  readonly profiles: ProfileStore;
  readonly marketGate: MarketGate;
  private marketTimer: ReturnType<typeof setInterval> | null = null;
  private huntSeenAt = 0;
  private huntTimer: ReturnType<typeof setInterval> | null = null;
  readonly marks = new MarkStore();
  readonly risk: RiskManager;
  readonly executor: ExchangeExecutor | null = null;
  readonly ops: OpsService;
  readonly context: ContextCollector;
  lastError: string | null = null;
  private marketCache: { at: number; list: any[] } | null = null;
  /** Symbols actually scanned after resolving the universe (list / top N / all). */
  resolvedSymbols: string[] = [];

  constructor(deps: AppDeps = {}) {
    const cfg = () => this.config.get();
    this.rest = deps.rest ?? new DeltaRest();
    this.feed = deps.feed ?? new DeltaFeed();
    this.registry = deps.registry ?? new ScannerRegistry();
    this.profiles = new ProfileStore(this.db);
    this.candles = new CandleStore(this.rest, this.feed, cfg().historyBars + 50);
    const workers = new WorkerTracker();
    this.pool = new PinePool(Number(process.env.VNEDGE_WORKERS) || undefined, undefined, workers.factory);
    this.paper = new PaperEngine(this.db, cfg);
    this.paper.atrFor = (symbol, tf) => lastAtr(this.candles.get(symbol, tf, { closedOnly: true, limit: 60 }), 14);
    // Shadow pairs are judged in R, so the shadow book sizes against a purse no pair can exhaust
    // and has no position cap: a shadow trade is never skipped because another one holds margin.
    let shadowBase: AppConfig | null = null, shadowCfg: AppConfig | null = null;
    const shadowRef = () => {
      const c = cfg();
      if (c !== shadowBase) { shadowBase = c; shadowCfg = { ...c, paper: { ...c.paper, initialEquity: 10_000_000, maxOpenPositions: 100_000, sizingMode: c.paper.sizingMode === 'margin' ? 'risk' : c.paper.sizingMode } }; }
      return shadowCfg!;
    };
    this.shadow = new PaperEngine(this.db, shadowRef, { book: 2 });
    this.shadow.atrFor = this.paper.atrFor;
    // a scanner's own exit rules reach both books the same way (decision 38)
    // decision 113: a scanner on exit mode `script` trades its own exits; the bot's targets and trail are off for it
    const scannerExit = (id: string) => { const c = cfg(); const sc = c.scanners[id]; return sc?.exitMode === 'script' ? { ...(sc.exit ?? {}), ...scriptModeExit(c.paper) } : sc?.exit; };
    // decision 159: script-exit trades add the bot's trail and floor from `scriptExitTrailFrom`; decision 160: a trade
    // already open then is protected too, its trail starting from that moment (trailStop); decision 161: both books
    const protectedExit = (id: string) => {
      const o = scannerExit(id); const c = cfg(); const from = c.paper.scriptExitTrailFrom;
      return c.scanners[id]?.exitMode === 'script' && from !== undefined && Date.now() >= from ? { ...o, ...scriptModeProtection(c.paper) } : o;
    };
    this.paper.scannerExit = protectedExit;
    this.shadow.scannerExit = protectedExit;
    // the same trend both books and the backtest use: closes of the position's own timeframe
    const trendFor = (symbol: string, tf: string) => {
      const len = cfg().paper.trendExit?.emaLen ?? 20;
      const closes = this.candles.get(symbol, tf, { closedOnly: true, limit: len * 4 }).map(b => b.close);
      return closes.length >= len ? trendSide(closes, len) : undefined;
    };
    this.paper.trendFor = trendFor;
    this.shadow.trendFor = trendFor;
    this.incubatorStore = new IncubatorStore(this.db);
    this.ml = new MlService(this.db, () => Object.fromEntries(this.registry.all().map(s => [s.id, s.name])));
    this.ml.excluded = () => this.scanners.health.quarantined();
    this.enricher = new FeatureEnricher(this.db, this.candles);
    this.scanners = new ScannerEngine({ registry: this.registry, cfgRef: cfg, candles: this.candles, pool: this.pool, paper: this.paper, db: this.db, rest: this.rest, symbolsRef: () => this.resolvedSymbols, ml: this.ml, cfgStore: this.config });
    this.resolvedSymbols = cfg().symbols;
    this.incubator = new ShadowRunner({
      store: this.incubatorStore, cfgRef: cfg, candles: this.candles, pool: this.pool, registry: this.registry, paper: this.shadow, marketInfo: s => this.scanners.marketInfo(s), ml: this.ml,
      marketVerdict: s => { const v = this.marketGate?.verdict(s); return v ? { allowed: v.allowed, reasons: v.reasons } : null; },
      mirror: (s, symbol, tf, ev, bars, market, exitMode, lastBar) => this.scanners.ingestEvent(s, symbol, tf, ev, bars, market, exitMode, lastBar),
      subscribe: symbols => { this.feed.subscribe('v2/ticker', symbols); subscribeRealtime(this); },
      accountFocus: () => {
        const open = this.paper.openPositions(); const c = cfg();
        const cap = Math.min(c.paper.maxOpenPositions || Infinity, c.risk?.maxPositionsTotal || Infinity);
        return { held: new Set(open.map(p => p.symbol)), full: open.length >= cap };
      },
    });
    // 1m candles drive paper fills for every open position
    // `historical` marks bars that a resync or gap fill pulled from REST: they describe the past,
    // so they must not fill new entries or move the live mark (audit: current-time fills from old candles)
    const onMinute = (e: { symbol: string; tf: string; bar: any; historical?: boolean }) => {
      if (e.tf !== '1m') return;
      this.paper.onBar(e.symbol, e.bar, Date.now(), { historical: e.historical === true });
      this.shadow.onBar(e.symbol, e.bar, Date.now(), { historical: e.historical === true });
    };
    this.candles.on('bar', onMinute);
    this.candles.on('closed', onMinute);
    this.feed.on('ticker', (t: WsTicker) => { this.paper.setMark(t.symbol, t.price); this.shadow.setMark(t.symbol, t.price); this.marks.onWsTicker(t); });
    this.feed.on('status', async (s: { connected: boolean }) => {
      if (s.connected) for (const t of this.candles.tracked()) { try { const n = await this.candles.resync(t.symbol, t.tf); if (n) log.info(`resynced ${t.symbol} ${t.tf}: ${n} bars`); } catch (e: any) { log.warn(`resync failed ${t.symbol} ${t.tf}: ${e?.message}`); } }
    });
    this.marketGate = new MarketGate({
      db: this.db, candles: this.candles, markets: () => this.markets(), cfgRef: cfg,
      book: async symbol => {
        const cv = (await this.markets()).find(m => m.symbol === symbol)?.contractValue || 1;
        const ob = await this.rest.orderbook(symbol, 25);
        const side = (l: Array<{ price: string; size: string | number }>) => (l ?? []).map(x => [Number(x.price), Number(x.size) * cv] as [number, number]);
        return { bids: side(ob.buy), asks: side(ob.sell) };
      },
    });
    this.risk = new RiskManager({ db: this.db, paper: this.paper, candles: this.candles, cfgRef: cfg, marketGate: this.marketGate });
    this.paper.risk = this.risk;
    this.executor = createExecutor(this.paper, cfg);
    wireRealtime(this);
    // flow intelligence from public data, once an hour (decision 101)
    this.context = new ContextCollector({ db: this.db, rest: this.rest, symbols: () => [...new Set([...this.resolvedSymbols, ...this.incubator.symbols()])] });
    this.context.start();
    this.ops = new OpsService({ cfg, onConfigChange: l => this.config.onChange(l), db: this.db, dataDir: DATA_DIR, feed: this.feed, pool: this.pool, paper: this.paper, marks: this.marks, candles: this.candles, scanners: this.scanners, workers, transport: deps.alertTransport, peakEquity: () => this.risk.peakEquity() });
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
    // markets today: judged now and every refreshMinutes, over the fleet's and the incubator's markets
    // decision 157: a market the gate allows again lets its waiting candidates in at once, not at the next night's hunt
    const refreshMarkets = () => { const own = [...new Set([...this.resolvedSymbols, ...this.incubator.symbols()])]; return this.marketGate.universe(own).then(list => this.marketGate.refresh(list, undefined, own)).then(() => this.incubatorAdmit('market gate')).catch(e => log.warn(`markets today failed: ${e?.message ?? e}`)); };
    // once the candle store has warmed up (the ATR test needs bars), then hourly
    setTimeout(refreshMarkets, 3 * 60_000).unref?.();
    void refreshMarkets();
    this.marketTimer = setInterval(refreshMarkets, Math.max(1, this.config.get().risk.marketGate?.refreshMinutes ?? 60) * 60_000);
    this.marketTimer.unref?.();
    // the daily screen runs in its own process; when it finishes, the hunt runs here so promotions land in the live config
    this.huntSeenAt = this.db.kvGet<any>('incubator.lastRun')?.at ?? 0;
    this.huntTimer = setInterval(() => {
      const at = this.db.kvGet<any>('incubator.lastRun')?.at ?? 0;
      if (at > this.huntSeenAt) { this.huntSeenAt = at; this.incubatorEvaluate('hunter').catch(e => log.warn(`hunt failed: ${e?.message ?? e}`)); }
      // decision 157: between hunts, free slots are filled as soon as a candidate can take one (a slot freed, a re-screen landed)
      else this.incubatorAdmit('timer').catch(e => log.warn(`admission failed: ${e?.message ?? e}`));
    }, 10 * 60_000);
    this.huntTimer.unref?.();
    this.ops.start();
    // don't block the API on warm-up
    this.scanners.start().catch(e => { this.lastError = String(e?.message ?? e); log.error('scanner start failed', e); });
    // the incubator's live rows follow the config from the first second (decision 83): a fleet edited on disk and restarted used to
    // keep its new cells in the shadow stage until the next hunt
    { const synced = incubatorSyncLive(this.incubatorStore, this.config.get()); if (synced.added || synced.removed) log.info(`incubator live rows synced to the config: +${synced.added} −${synced.removed}`); }
    this.incubator.start();
  }

  /**
   * The executor and its transport are built once (review finding 2): a change to the execution
   * mode, host opt-in or bracket setting while running would change the label and not the wires.
   * The change is refused with the reason; a restart applies it.
   */
  assertExecutionUnchanged(next: Partial<AppConfig['execution']> | undefined): void {
    if (!next) return;
    const cur = this.config.get().execution;
    const running = this.executor ? { mode: this.executor.mode, allowProduction: cur.allowProduction, bracket: cur.bracket } : { mode: 'paper', allowProduction: cur.allowProduction, bracket: cur.bracket };
    const changes: string[] = [];
    if (next.mode !== undefined && next.mode !== running.mode) changes.push(`mode ${running.mode} → ${next.mode}`);
    if (next.allowProduction !== undefined && next.allowProduction !== running.allowProduction) changes.push(`allowProduction ${running.allowProduction} → ${next.allowProduction}`);
    if (next.bracket !== undefined && next.bracket !== running.bracket) changes.push(`bracket ${running.bracket} → ${next.bracket}`);
    if (changes.length) throw new Error(`execution settings cannot change while running (${changes.join(', ')}): restart the service to apply them`);
  }

  /**
   * Flatten the exchange account in order: no new entries, let queued execution work settle, cancel
   * everything and close every exchange position, then reconcile (review finding 3).
   */
  async flattenExchange(actor: string) {
    if (!this.executor) throw new Error('execution.mode is paper: no exchange account attached');
    this.risk.kill(`flatten by ${actor}`, false);
    await this.executor.flush();
    const result = await this.executor.closeAll({ confirm: true });
    await this.executor.flush();
    const reconcile = await this.executor.reconcile();
    log.error(`FLATTEN by ${actor}: ${result.closed.length} position(s) closed, ${result.cancelled.length} product(s) cancelled; reconcile ${reconcile.ok ? 'in step' : `${reconcile.drift.length} drift(s)`}; entries stay paused until resumed`);
    return { ...result, reconcile };
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
      attention: this.attention(),
      ...this.ops.status(),
    };
  }

  /**
   * Every gate between a setup and real money, with its live state (the Gate Center, decision 99).
   * Nothing here is computed anew: each row reads the state its owner already keeps, so the page
   * can never disagree with the gate that acts. `blocking` stops entries now, `armed` is a rule
   * that would stop one, `open` lets them through, `off` is disabled, `attention` needs the operator.
   */
  gates() {
    type Gate = { key: string; group: string; name: string; state: 'open' | 'armed' | 'blocking' | 'off' | 'attention'; value: string; rule: string; next: string; href?: string };
    const cfg = this.config.get();
    const now = Date.now();
    const r = this.risk.state();
    const rc = cfg.risk;
    const g: Gate[] = [];
    const pct = (v: number, d = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}%`;
    // --- the account's own limits ---
    g.push({ key: 'kill', group: 'Account', name: 'Kill switch', state: r.halted ? 'blocking' : 'armed', value: r.halted ? (r.haltReason ?? 'halted') : 'not tripped', rule: 'No new entries while halted; open positions keep their exits', next: r.halted ? 'Resume on the Overview once the cause is understood' : 'Pause entries on the Overview to halt by hand', href: '/' });
    g.push({ key: 'day', group: 'Account', name: 'Daily loss limit', state: r.day.tripped ? 'blocking' : rc.maxDailyLossPct > 0 ? 'armed' : 'off', value: `${pct(r.day.pnlPct)} today of −${rc.maxDailyLossPct}%`, rule: 'Trips the kill switch for the day', next: r.day.tripped ? 'Resets at 00:00 UTC, or Resume' : 'Settings → risk → max daily loss', href: '/settings' });
    g.push({ key: 'week', group: 'Account', name: 'Weekly loss limit', state: r.week.tripped ? 'blocking' : rc.maxWeeklyLossPct > 0 ? 'armed' : 'off', value: `${pct(r.week.pnlPct)} this week of −${rc.maxWeeklyLossPct}%`, rule: 'Trips the kill switch for the week', next: 'Settings → risk → max weekly loss', href: '/settings' });
    g.push({ key: 'dd', group: 'Account', name: 'Drawdown scaling', state: r.leverageMult < 1 ? 'blocking' : rc.ddScale?.length ? 'armed' : 'off', value: `−${r.drawdownPct.toFixed(1)}% from the peak · risk ×${r.leverageMult.toFixed(2)}`, rule: 'Risk per trade and leverage shrink with the drawdown', next: r.leverageMult < 1 ? 'Recovers as equity climbs back toward the peak' : 'Settings → risk → drawdown scale', href: '/settings' });
    g.push({ key: 'positions', group: 'Account', name: 'Position caps', state: r.positions.max != null && r.positions.open + r.positions.pending >= r.positions.max ? 'blocking' : 'armed', value: `${r.positions.open} open, ${r.positions.pending} pending of ${r.positions.max ?? '∞'} · ${r.positions.maxPerSymbol ?? '∞'} per market · ${r.positions.maxPerScanner ?? '∞'} per scanner`, rule: 'Total, per market and per scanner', next: 'Settings → risk → positions', href: '/settings' });
    g.push({ key: 'exposure', group: 'Account', name: 'BTC-beta exposure', state: r.exposure.limitPct > 0 ? ((r.exposure as any).pct ?? 0) >= r.exposure.limitPct ? 'blocking' : 'armed' : 'off', value: `${((r.exposure as any).pct ?? 0).toFixed(1)}% of ${r.exposure.limitPct}% on ${r.exposure.tf}`, rule: 'Correlated exposure to BTC is capped', next: 'Settings → risk → max beta exposure', href: '/settings' });
    const cooling = Object.values(r.scanners).filter((s: any) => s.inCooldown).length;
    g.push({ key: 'cooldown', group: 'Account', name: 'Loss cooldown', state: cooling ? 'blocking' : rc.cooldownAfterLosses > 0 ? 'armed' : 'off', value: cooling ? `${cooling} scanner${cooling > 1 ? 's' : ''} cooling down` : `after ${rc.cooldownAfterLosses} losses in a row, ${rc.cooldownMinutes} min`, rule: 'A scanner that loses N in a row sits out', next: 'Settings → risk → cooldown', href: '/settings' });
    g.push({ key: 'reentry', group: 'Account', name: 'Re-entry and burst', state: (rc.reentryCooldownMinutes ?? 0) > 0 || (rc.burstWindowSec ?? 0) > 0 ? 'armed' : 'off', value: `${rc.reentryCooldownMinutes ?? 0} min after a stop on the same market · one entry per side per ${rc.burstWindowSec ?? 0}s`, rule: 'No immediate re-entry after a stop, no bursts of the same side', next: 'Settings → risk', href: '/settings' });
    // --- the market ---
    const mt = this.db.kvGet<{ at: number; enabled: boolean; markets: Array<{ symbol: string; allowed: boolean; tracked: boolean }> }>('risk.marketsToday');
    const tracked = (mt?.markets ?? []).filter(m => m.tracked !== false), allowed = tracked.filter(m => m.allowed);
    const stale = mt ? now - mt.at > 2 * 3600_000 : true;
    g.push({ key: 'market', group: 'Market', name: 'Markets today', state: !rc.marketGate?.enabled ? 'off' : stale ? 'attention' : allowed.length ? 'armed' : 'blocking', value: mt ? `${allowed.length} of ${tracked.length} scanned markets allowed${stale ? ' · judgement stale' : ''}` : 'no judgement yet', rule: `Book under ${rc.marketGate?.maxBookCostPct ?? '?'}% round trip, turnover over $${((rc.marketGate?.minTurnoverUsd ?? 0) / 1e6).toFixed(2)}M, ATR over ${rc.regime?.minAtrPct ?? '?'}%`, next: stale ? 'Re-judge on the Overview' : 'The Overview lists every market and its reason', href: '/' });
    g.push({ key: 'regime', group: 'Market', name: 'Regime', state: rc.regime?.enabled ? 'armed' : 'off', value: `ATR ≥ ${rc.regime?.minAtrPct ?? 0}%${(rc.regime as any)?.minEr ? ` · efficiency ≥ ${(rc.regime as any).minEr}` : ''}${rc.regime?.noWeekend ? ' · no weekend entries' : ''}`, rule: 'No entries in dead or choppy markets', next: 'Settings → risk → regime', href: '/settings' });
    // --- the trade ---
    const ratio = cfg.paper.minRiskFeeRatio ?? 0;
    g.push({ key: 'cost', group: 'Trade', name: 'Stop versus round-trip cost', state: ratio >= 6 ? 'armed' : ratio > 0 ? 'attention' : 'off', value: `stop ≥ ${ratio}× fees plus the live spread`, rule: 'A stop that cannot pay the round trip is refused before it loses (decision 96)', next: ratio < 6 ? 'Settings → Paper account → minimum stop over round-trip fee: 6 (measured in decision 96)' : 'As measured', href: '/settings' });
    g.push({ key: 'liq', group: 'Trade', name: 'Liquidation headroom', state: cfg.paper.liquidation ? 'armed' : 'off', value: `leverage capped so the stop sits inside liquidation by 25% of the stop, on each market's maintenance margin`, rule: 'The stop must trade before the exchange liquidates (decision 94)', next: 'Automatic per market', href: '/trades' });
    g.push({ key: 'size', group: 'Trade', name: 'Risk per trade and size caps', state: 'armed', value: `${cfg.paper.riskPerTradePct}% of equity · stop ≤ ${cfg.paper.maxStopLossPct}% · leverage ≤ ${cfg.paper.maxLeverage}× or the market's own`, rule: 'Lots from the stop distance; never more than the caps allow', next: 'Settings → Paper account', href: '/settings' });
    // --- the pipeline ---
    const inc = cfg.incubator;
    const shadowN = this.incubatorStore.counts?.()?.shadow ?? null;
    g.push({ key: 'mirror', group: 'Pipeline', name: 'Shadow mirror', state: inc.mirror?.enabled ? 'open' : 'off', value: inc.mirror?.enabled ? 'on: the account takes every shadow pair\'s signals under its own gates and caps' : 'off: only promoted cells trade the account', rule: 'Decision 116. With the mirror on, the shadow book is the fleet; the risk manager, the efficiency gate, the cost rule, the market gate and the position caps still decide every entry.', next: inc.mirror?.enabled ? 'switch off in Settings → Incubator to go back to promoted cells only' : 'switch on in Settings → Incubator to let the account take the shadow book\'s signals', href: '/incubator' });
    g.push({ key: 'shadow', group: 'Pipeline', name: 'Shadow book capacity', state: shadowN != null && shadowN >= inc.maxShadow ? 'attention' : 'open', value: shadowN != null ? `${shadowN} pairs of ${inc.maxShadow}` : `cap ${inc.maxShadow}`, rule: 'Candidates enter only while there is room', next: shadowN != null && shadowN >= inc.maxShadow ? 'Raise incubator.maxShadow in Settings, or wait for retirements' : 'Room for new candidates', href: '/incubator' });
    const start = this.db.kvGet<{ at: number }>('incubator.lastStart'), run = this.db.kvGet<{ at: number }>('incubator.lastRun');
    const died = start && (!run || run.at < start.at) && now - start.at > 7 * 3600_000;
    g.push({ key: 'nightly', group: 'Pipeline', name: 'Nightly screen', state: died ? 'attention' : run && now - run.at > 2 * 86400_000 ? 'attention' : 'open', value: run ? `last finished ${Math.round((now - run.at) / 3600_000)} h ago on ${inc.tf}` : 'never finished', rule: 'Disabled scripts are screened every night, then the shadow book is judged', next: inc.tf === '15m' ? 'Settings → incubator timeframe: 1h (the timeframe that pays costs, decision 96)' : 'Runs at 01:00 UTC', href: '/incubator' });
    g.push({ key: 'promote', group: 'Pipeline', name: 'Promotion', state: 'armed', value: `≤ ${inc.promote.maxPerWeek} a week · fleet ≤ ${inc.promote.maxFleet} cells · ${livePairs(cfg).length} live now`, rule: '30 shadow trades over 14 days, PF 1.2, positive weeks, then a proposal', next: 'Incubator → Waiting for your decision', href: '/incubator' });
    // --- the way out ---
    const l = this.learning();
    const gl = l.golive;
    g.push({ key: 'golive', group: 'Real money', name: 'Go-live rule', state: gl.ok ? 'open' : 'blocking', value: `${gl.checks.filter((c: any) => c.ok).length} of ${gl.checks.length} checks pass`, rule: 'Every check with its number; keys stay unset until all are green', next: gl.ok ? 'All green' : `Failing: ${gl.checks.filter((c: any) => !c.ok).map((c: any) => c.name ?? c.label ?? c.key).slice(0, 3).join(', ')}`, href: '/analytics' });
    const alerts = this.ops.alerts.status();
    g.push({ key: 'alerts', group: 'Real money', name: 'Alert channel', state: alerts.configured ? 'open' : 'attention', value: alerts.configured ? `${alerts.channel ?? 'channel'} · ${alerts.sent ?? 0} sent` : 'not configured', rule: 'A halt, a stranded position or a hunt result must reach a person', next: alerts.configured ? 'Configured' : 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the service environment', href: '/exchange' });
    const ex = cfg.execution;
    const live = ex.allowProduction === true && process.env.DELTA_LIVE === '1';
    g.push({ key: 'execution', group: 'Real money', name: 'Execution lock', state: ex.mode === 'paper' ? 'blocking' : live ? 'attention' : 'armed', value: `mode ${ex.mode} · host ${live ? 'production' : 'demo'} · ${ex.bracket ? 'brackets on' : 'market orders, reduce-only exits'}`, rule: 'Production needs allowProduction and DELTA_LIVE=1 both; the mode cannot change at runtime', next: ex.mode === 'paper' ? 'Paper until the go-live rule is green' : 'Keys live only in the service environment', href: '/exchange' });
    return { at: now, gates: g, summary: { blocking: g.filter(x => x.state === 'blocking').length, attention: g.filter(x => x.state === 'attention').length } };
  }

  /**
   * What the operator must know before anything else: a daily job that died, a scanner in the
   * account that is not running. Each item names the fault and the page that acts on it. The
   * dashboard shows the list on the Overview; an empty list is the normal state.
   */
  attention(): Array<{ key: string; text: string; href: string }> {
    const cfg = this.config.get();
    const now = Date.now();
    const items: Array<{ key: string; text: string; href: string }> = [];
    const names = new Map(this.registry.all().map(s => [s.id, s.name]));
    const sick = Object.entries(cfg.scanners).filter(([id, c]) => c.enabled && !c.hidden && this.scanners.health.isQuarantined(id));
    if (sick.length) {
      const list = sick.slice(0, 3).map(([id]) => `${names.get(id) ?? id} (${this.scanners.health.row(id)?.reason ?? 'quarantined'})`).join(', ');
      items.push({ key: 'quarantined-live', text: `${sick.length} scanner${sick.length > 1 ? 's' : ''} in the account ${sick.length > 1 ? 'are' : 'is'} quarantined and not running: ${list}${sick.length > 3 ? ', …' : ''}`, href: '/scanners?book=account' });
    }
    const start = this.db.kvGet<{ at: number; slice: string }>('incubator.lastStart');
    const run = this.db.kvGet<{ at: number }>('incubator.lastRun');
    if (start && (!run || run.at < start.at) && now - start.at > 7 * 3600_000) {
      items.push({ key: 'incubate-died', text: `the daily screen started ${Math.round((now - start.at) / 3600_000)} h ago and never finished: the shadow book has not been judged since ${run ? new Date(run.at).toISOString().slice(0, 10) : 'ever'}`, href: '/incubator' });
    } else if (cfg.incubator.enabled && run && now - run.at > 2 * 86400_000) {
      items.push({ key: 'incubate-stale', text: `the daily screen last finished ${Math.round((now - run.at) / 86400_000)} days ago`, href: '/incubator' });
    }
    // decision 110: on 23 September the scans ran ten minutes late for twelve hours and 86 entries were refused as stale without a word
    const stale = this.db.get<{ n: number }>("SELECT COUNT(*) n FROM signals WHERE kind='entry' AND action LIKE 'rejected:stale%' AND at > ?", now - 2 * 3600_000)?.n ?? 0;
    if (stale >= 3) items.push({ key: 'scans-late', text: `scans are running late: ${stale} entries refused as stale in the last 2 h (the bar had closed more than the allowed age before the scan ran)`, href: '/signals' });
    return items;
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
      profiles: this.profiles.summaries(),
      books: this.scannerBooks(),
      week: this.weekFunnelByScanner(),
    };
  }

  /** The last seven days of entry signals per scanner, by what became of them (decision 87): the week explained, not just the last run. */
  private weekFunnelByScanner() {
    const out = new Map<string, { entries: number; opened: number; gate: number; fee: number; regime: number; guard: number; other: number }>();
    const rows = this.db.all<{ scanner_id: string; k: string; n: number }>(`SELECT scanner_id, CASE WHEN action IN ('opened','reversed') OR action LIKE 'pending%' THEN 'opened' WHEN action LIKE 'rejected:risk market%' THEN 'gate' WHEN action LIKE 'rejected:stop too tight%' THEN 'fee' WHEN action LIKE 'rejected:risk regime%' THEN 'regime' WHEN action LIKE 'rejected:risk re-entry%' OR action LIKE 'rejected:risk burst%' THEN 'guard' ELSE 'other' END k, COUNT(*) n FROM signals WHERE kind='entry' AND at > ? GROUP BY 1, 2`, Date.now() - 7 * 86_400_000);
    for (const r of rows) { const w = out.get(r.scanner_id) ?? { entries: 0, opened: 0, gate: 0, fee: 0, regime: 0, guard: 0, other: 0 }; w.entries += r.n; (w as any)[r.k] += r.n; out.set(r.scanner_id, w); }
    return out;
  }

  /** Which books each scanner is in (decision 64): markets it trades in the account, markets it is proving in the shadow book. */
  private scannerBooks() {
    const out = new Map<string, { account: string[]; shadow: string[]; proposed: string[] }>();
    for (const r of this.incubatorStore.list(['live', 'demote_proposed', 'shadow', 'proposed'])) {
      const b = out.get(r.scannerId) ?? { account: [], shadow: [], proposed: [] };
      (r.stage === 'live' || r.stage === 'demote_proposed' ? b.account : r.stage === 'proposed' ? b.proposed : b.shadow).push(`${r.symbol} ${r.tf}`);
      out.set(r.scannerId, b);
    }
    return out;
  }

  scannerView(id: string, idx?: ReturnType<App['scannerViewIndex']>) {
    const s = this.registry.get(id);
    if (!s) return null;
    const c = this.scanners.scannerConfig(id);
    const stats = idx ? this.paper.scannerStats(id, { closed: idx.closed, open: idx.open }) : this.paper.scannerStats(id);
    stats.signals = idx ? (idx.signals.get(id) ?? 0) : this.db.countSignals(id);
    stats.backtest = idx ? this.scanners.backtestSummary(id, idx.backtests) : this.scanners.backtestSummary(id);
    const prof = idx ? (idx.profiles.get(id) ?? null) : (() => { const rows = this.profiles.forScanner(id); return rows.length ? { kind: summarizeKind(rows)!, at: Math.max(...rows.map(r => r.at)), tfs: new Set(rows.map(r => r.tf)).size } : null; })();
    const health = this.scanners.health.row(id);
    return {
      id: s.id, name: s.name, author: s.author, file: s.file, url: s.url, status: s.status, reason: s.reason, category: s.category, enabled: Boolean(c.enabled && !c.hidden), active: this.scanners.isActive(s), hidden: Boolean(c.hidden),
      overlay: s.overlay, pineVersion: s.pineVersion, lines: s.lines, updated: s.updated, patches: s.patches,
      symbols: this.scanners.symbolsFor(id), timeframes: this.scanners.timeframesFor(id), pairs: c.pairs ?? null, exitMode: c.exitMode,
      // how the script is read (decision 48): its entry channel, timezone, derivation rule, input overrides and exit overrides
      reads: { sources: c.sources ?? null, timezone: c.timezone ?? null, rule: c.rule ?? null, inputs: c.inputs ?? null, exit: c.exit ?? null, labels: c.labels ?? null, edge: c.edge ?? null, invert: Boolean(c.invert) },
      // what it produced when last profiled, and whether the runtime has given up on it
      kind: prof?.kind ?? null, profiledAt: prof?.at ?? null, health: health ? { fails: health.fails, lastAt: health.lastAt, lastError: health.lastError, reason: health.reason, quarantined: health.quarantined } : null,
      lastRun: idx ? (idx.lastRun.get(id) ?? null) : this.scanners.getLastRun(id), stats,
      books: (idx ? idx.books : this.scannerBooks()).get(id) ?? { account: [], shadow: [], proposed: [] },
      week: (idx ? idx.week : this.weekFunnelByScanner()).get(id) ?? null,
    };
  }

  scannerViews() { const idx = this.scannerViewIndex(); return this.registry.all().map(s => this.scannerView(s.id, idx)); }

  /**
   * Run one script on a market across timeframes and record what it produced. Background priority:
   * the live scan is never delayed by a profile. Returns the rows it stored.
   */
  async profileScanner(id: string, opts: { market?: string; tfs?: string[] } = {}): Promise<ProfileRow[]> {
    const s = this.registry.get(id);
    if (!s) throw new Error('unknown scanner');
    const market = opts.market ?? 'ETHUSD';
    const tfs = opts.tfs ?? ['15m', '1h', '4h'];
    const BARS: Record<string, number> = { '5m': 4000, '15m': 4000, '1h': 3000, '4h': 2000 };
    const product = await this.rest.product(market);
    const tickSize = Number(product?.tick_size ?? 0.5);
    const cfg = this.config.get();
    const out: ProfileRow[] = [];
    for (const tf of tfs) {
      const at = Date.now();
      if (s.status !== 'ok') { out.push({ scannerId: id, market, tf, at, ...brokenRun(s.reason ?? s.status) }); continue; }
      const candles = await this.rest.recentCandles(market, tf, BARS[tf] ?? 3000, TF_SECONDS[tf]);
      const bars = candles.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
      const c = cfg.scanners[id];
      const inputs = c?.inputs && Object.keys(c.inputs).length ? c.inputs : undefined;
      const res = await this.pool.run({ scannerId: id, source: s.patched, symbol: market, tf, tickSize, bars, tailBars: 'all', plotTail: bars.length, inputs, timezone: c?.timezone }, { priority: 'background' });
      if (!res.ok) { out.push({ scannerId: id, market, tf, at, ...brokenRun(res.error ?? 'failed', res.ms) }); continue; }
      const derived = applyRules({ scannerId: id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: c?.rule ?? null, bars, mode: 'backtest' });
      const events = extractEvents(res.alerts, res.shapes, { derived, sources: c?.sources, edge: c?.edge });
      out.push({ scannerId: id, market, tf, at, ...classifyRun(res, events) });
    }
    for (const r of out) this.profiles.save(r);
    return out;
  }

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
      // `enabled` is the setting as the operator left it; `active` is whether the scheduler runs it (status ok, not quarantined).
      // Showing a quarantined scanner as disabled hid the quarantine behind a switch that would not have changed anything.
      return { id: s.id, name: s.name, status: s.status, category: s.category, enabled: Boolean(c.enabled && !c.hidden), active: this.scanners.isActive(s), hidden: Boolean(c.hidden), overlay: s.overlay, lastRunError: lastRun.get(s.id)?.error ?? null };
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
  /** Median risk per closed account trade as a share of the equity at entry, over the last 30 closed trades so a sizing change shows within weeks; null before five trades. */
  realisedRiskPct(): number | null {
    const rows = this.db.all<{ risk: number; at: number }>("SELECT risk_amount AS risk, entry_at AS at FROM positions WHERE bt=0 AND status='closed' AND risk_amount > 0 ORDER BY entry_at DESC LIMIT 30").reverse();
    if (rows.length < 5) return null;
    const eq = this.db.all<{ at: number; equity: number }>('SELECT at, equity FROM equity WHERE scanner_id IS NULL ORDER BY at');
    let j = 0; const pcts: number[] = [];
    for (const r of rows) { while (j + 1 < eq.length && eq[j + 1].at <= r.at) j++; const e = eq[j]?.equity; if (e && e > 0) pcts.push(r.risk / e * 100); }
    if (pcts.length < 5) return null;
    pcts.sort((a, b) => a - b); return pcts[pcts.length >> 1];
  }

  /** What the journal teaches, in R, for the live book and the shadow book (decision 63). */
  learning() {
    const toLearn = (book: number) => (t: any) => ({ scannerId: t.scannerId, scannerName: t.scannerName, symbol: t.symbol, tf: t.tf, side: t.side, entryAt: t.entryAt, exitAt: t.exitAt, pnl: t.pnl, fees: t.fees, rMultiple: t.rMultiple, exitReason: t.exitReason ?? null, peakR: t.peakR ?? null, riskAmount: t.riskAmount, configFp: t.configFp ?? null, features: this.featuresOf(book, t) });
    const since = Date.now() - 30 * 86_400_000;
    const liveAll = this.paper.trades({ limit: 5000 }).map(toLearn(this.paper.book));
    const live = learnBook(liveAll);
    // the book under the settings that are live now (decision 90): the only part of the journal a change today can be judged on
    const fpCache = new Map<string, string>();
    const fpFor = (sid: string, tf: string) => { const k = `${sid}|${tf}`; let v = fpCache.get(k); if (!v) { v = configFingerprint(this.config.get(), sid, tf).fp; fpCache.set(k, v); } return v; };
    const current = learnBook(liveAll.filter(t => t.configFp && t.configFp === fpFor(t.scannerId, t.tf)));
    const shadow = learnBook(this.shadow.trades({ limit: 20000 }).filter(t => (t.exitAt ?? 0) >= since).map(toLearn(this.shadow.book)));
    this.enricher.flush();
    const counts = this.incubatorStore.counts();
    const hunt = this.db.kvGet<any>('incubator.lastHunt') ?? null;
    const ages = this.incubatorStore.list(['shadow']).map(r => (Date.now() - r.since) / 86_400_000).sort((a, b) => a - b);
    const funnel = { stages: counts, lastHunt: hunt, shadowAgeDays: { median: ages.length ? ages[ages.length >> 1] : null, over30: ages.filter(a => a > 30).length }, gate: this.config.get().incubator.gate ?? null };
    // the go-live rule (decision 65): the journal's R series through the fleet's own halts, plus the checks a rule can state
    const cfg = this.config.get();
    const liveTrades = this.paper.trades({ limit: 5000 }).filter(t => Number.isFinite(t.exitAt));
    const span = liveTrades.length > 1 ? (Math.max(...liveTrades.map(t => t.exitAt!)) - Math.min(...liveTrades.map(t => t.entryAt))) / 86_400_000 : 1;
    const halts = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM positions WHERE bt=0 AND status='closed' AND exit_reason='risk-kill' AND exit_at > ?", since)?.n ?? 0;
    const riskState = this.risk.state();
    const golive = goLive({
      rs: [...liveTrades].sort((a, b) => a.exitAt! - b.exitAt!).map(t => (typeof t.rMultiple === 'number' && Number.isFinite(t.rMultiple) ? t.rMultiple : 0)),
      // the risk actually taken, not the configured intention: quality sizing and the stop cap set the size, so measure risk_amount against equity at entry (decision 69)
      tradesPerDay: liveTrades.length / Math.max(1, span), riskPct: this.realisedRiskPct() ?? cfg.paper.riskPerTradePct, dailyLossPct: cfg.risk.maxDailyLossPct, maxLossPct: cfg.risk.maxWeeklyLossPct || 30,
      drawdownAlertPct: cfg.risk.ddScale?.[0]?.ddPct ?? 10, lb90: live.lb90, haltsInWindow: halts + (riskState.day.tripped ? 1 : 0) + (riskState.week.tripped ? 1 : 0), alertsConfigured: this.ops.alerts.configured,
    });
    return { at: Date.now(), live, current, shadow: { ...shadow, windowDays: 30 }, funnel, golive };
  }

  /** The trade's entry-time features: its own when it carries them, else computed from the bars closed at its entry (decision 108). */
  private featuresOf(book: number, t: any): Record<string, number> | null {
    return this.enricher.featuresFor({ book, id: t.id, symbol: t.symbol, tf: t.tf, side: t.side, entryAt: t.entryAt, entryPrice: t.entryPrice, sl: t.sl ?? null, tp: t.tp ?? null, levelsSource: t.levelsSource ?? null, features: t.features ?? null });
  }

  /**
   * Would the model's gate have paid (decision 108)? Every closed trade of the last `days` in both books,
   * with the probability it had at entry or, failing that, the one the current model gives its entry
   * after the fact; the shadow book is the out-of-sample judge.
   */
  mlYardstick(days = 60) {
    const since = Date.now() - days * 86_400_000;
    const collect = (engine: PaperEngine): YardTrade[] => engine.trades({ limit: 20000 })
      .filter(t => Number.isFinite(t.exitAt) && (t.exitAt ?? 0) >= since && Number.isFinite(t.rMultiple))
      .map(t => {
        const r = t.rMultiple as number;
        if (typeof t.mlProb === 'number' && Number.isFinite(t.mlProb)) return { r, prob: t.mlProb, scored: 'entry' as const };
        const f = this.featuresOf(engine.book, t);
        const prob = f ? this.ml.score(t.scannerId, f as any, { record: false })?.prob ?? null : null;
        return { r, prob, scored: prob === null ? null : ('later' as const) };
      });
    const live = yardstick(collect(this.paper)), shadow = yardstick(collect(this.shadow));
    this.enricher.flush();
    const snap = this.ml.insights();
    return { at: Date.now(), windowDays: days, model: { trainedAt: snap.trainedAt, holdoutAuc: snap.global?.model?.auc ?? null, samples: snap.samples }, config: this.config.get().ml, enriched: this.enricher.size(), live, shadow, call: theCall(live, shadow) };
  }

  /** Account exits by reason and the totals, in dollars (decision 108): the cuts the journal does not already give in R. */
  /** Decision 139: the operator's trackers with each member cell's shadow record since the tracker began. */
  trackers() { return listTrackers(this.db).map(t => trackerView(this.db, this.incubatorStore, t)); }
  saveTracker(def: { id: string; name: string; scanners: string[]; symbols: string[]; tfs: string[] }) { const r = saveTracker(this.db, this.incubatorStore, def); void this.incubator.sync(); return r; }
  removeTracker(id: string) { const n = removeTracker(this.db, this.incubatorStore, id); void this.incubator.sync(); return { removed: n }; }

  /** Decision 136: one row per UTC day for the books and the incubator, newest first, today partial. */
  dailyReport(days = 30) { return dailyReport(this.db, this.paper.stats().initialEquity, Math.max(1, Math.min(120, days))); }

  analytics() {
    type Agg = { trades: number; wins: number; pnl: number; gp: number; gl: number; fees: number };
    const mk = (): Agg => ({ trades: 0, wins: 0, pnl: 0, gp: 0, gl: 0, fees: 0 });
    const add = (a: Agg, pnl: number, fees: number) => { a.trades++; if (pnl > 0) { a.wins++; a.gp += pnl; } else a.gl += -pnl; a.pnl += pnl; a.fees += fees; };
    const fin = (a: Agg) => ({ trades: a.trades, wins: a.wins, winRatePct: a.trades ? a.wins / a.trades * 100 : 0, pnl: a.pnl, fees: a.fees, profitFactor: a.gl > 0 ? a.gp / a.gl : a.gp > 0 ? 999 : null });
    const trades = this.paper.trades({ limit: 5000 });
    const exits: Record<string, Agg> = {}; const total = mk();
    for (const t of trades) { add(exits[String(t.exitReason ?? 'unknown')] ??= mk(), t.pnl, t.fees); add(total, t.pnl, t.fees); }
    return {
      at: Date.now(),
      exits: Object.entries(exits).map(([reason, a]) => ({ reason, ...fin(a) })).sort((a, b) => b.trades - a.trades),
      totals: { live: fin(total) },
    };
  }


  // ---- incubator ----

  /** Everything the Incubator page shows: stages, the evidence behind each pair, and the audit trail. */
  incubatorView() {
    const cfg = this.config.get();
    const now = Date.now();
    const openShadow = new Map<string, number>();
    for (const p of this.shadow.openPositions()) { const k = `${p.scannerId}|${p.symbol}|${p.tf}`; openShadow.set(k, (openShadow.get(k) ?? 0) + 1); }
    const names = new Map(this.registry.all().map(s => [s.id, s.name]));
    const markets = this.incubatorStore.marketsToday();
    const since14 = now - 14 * 86400_000;
    const pairs = this.incubatorStore.list().map(r => {
      const book = r.stage === 'live' || r.stage === 'demote_proposed' ? 0 : 2;
      const judged = r.stage !== 'candidate' && r.stage !== 'retired';
      const key = `${r.scannerId}|${r.symbol}|${r.tf}`;
      const trades = judged ? this.incubatorStore.trades(r.scannerId, r.symbol, r.tf, book) : [];
      return {
        ...r, scannerName: names.get(r.scannerId) ?? r.scannerId,
        stats: judged ? pairStats(trades, r.since, now) : null,
        openShadow: openShadow.get(key) ?? 0,
        // decision 104: whether the account could trade this market today, and why not
        market: markets.get(r.symbol) ?? null,
        // decision 112: what became of the cell's signals in the last 14 days, from the account's record or the shadow runner's
        funnel: book === 0 ? this.incubatorStore.signalFunnel(r.scannerId, r.symbol, r.tf, since14) : judged ? this.incubator.funnelOf(key, since14) : null,
        lastTradeAt: trades.length ? Math.max(...trades.map(t => t.entryAt)) : null,
      };
    });
    return {
      enabled: cfg.incubator.enabled, config: cfg.incubator, counts: this.incubatorStore.counts(),
      fleet: livePairs(cfg).length, promotionsThisWeek: this.incubatorStore.promotionsSince(now - 7 * 86400_000),
      lastRun: this.db.kvGet('incubator.lastRun') ?? null, lastStart: this.db.kvGet('incubator.lastStart') ?? null, lastHunt: this.db.kvGet<any>('incubator.lastHunt') ?? null, runner: { ...this.incubator.stats, active: this.incubator.active.length },
      pairs, events: this.incubatorStore.events(100),
      // decision 157: why the candidates that passed their screen are not in the shadow book, right now
      candidates: candidateBlockers(this.incubatorStore, cfg, now, { needsRescreen: id => this.registry.get(id)?.scriptType === 'strategy' }),
      lastAdmit: this.db.kvGet<any>('incubator.lastAdmit') ?? null,
    };
  }

  async incubatorDecide(id: number, action: 'approve' | 'reject' | 'demote', actor: string, note: string | null = null) {
    const setScanner = (sid: string, patch: Partial<ScannerConfig>) => { this.config.setScanner(sid, patch); };
    const r = action === 'approve' ? incubatorApprove(this.incubatorStore, this.config.get(), id, actor, setScanner)
      : action === 'demote' ? incubatorDemote(this.incubatorStore, this.config.get(), id, actor, setScanner, note)
      : incubatorReject(this.incubatorStore, id, actor, note);
    if (action !== 'reject') await this.onConfigChanged();
    await this.incubator.sync();
    log.info(`incubator: ${actor} ${action}d ${r.scannerId} ${r.symbol} ${r.tf} → ${r.stage}`);
    return r;
  }

  /** Re-judge shadow and live pairs now (the daily job does this too, after screening). */
  /**
   * The hunt: judge the shadow book, promote what the gate proposed when `promote.auto` is on, and
   * say what happened. Runs on the owner's click and every time the daily screen finishes.
   */
  /** Decision 157: admission alone, as often as the market gate and the timer allow; judging stays with the hunt. */
  async incubatorAdmit(actor: string): Promise<string[]> {
    const admitted = incubatorAdmitOnly(this.incubatorStore, this.config.get(), Date.now(), { needsRescreen: id => this.registry.get(id)?.scriptType === 'strategy' });
    if (admitted.length) {
      await this.incubator.sync();
      this.db.kvSet('incubator.lastAdmit', { at: Date.now(), actor, admitted });
      log.info(`incubator: ${admitted.length} admitted to the shadow book (${actor}): ${admitted.slice(0, 5).join(', ')}${admitted.length > 5 ? ' …' : ''}`);
    }
    return admitted;
  }

  async incubatorEvaluate(actor: string) {
    const cfg = this.config.get();
    const synced = incubatorSyncLive(this.incubatorStore, cfg);
    const report = incubatorEvaluate(this.incubatorStore, cfg, Date.now(), { needsRescreen: id => this.registry.get(id)?.scriptType === 'strategy' });
    let promoted: string[] = [], blocked: string[] = [];
    if (cfg.incubator.promote.auto && report.proposed.length) {
      ({ promoted, blocked } = incubatorAutoPromote(this.incubatorStore, cfg, (sid, patch) => { this.config.setScanner(sid, patch); }));
      if (promoted.length) await this.onConfigChanged();
    }
    await this.incubator.sync();
    const screen = this.db.kvGet<any>('incubator.lastRun');
    const hunt = { at: Date.now(), actor, screen: screen ? { at: screen.at, slice: screen.slice, runs: screen.runs, passed: screen.passed, newCandidates: screen.new, quarantined: screen.quarantined, minutes: Math.round((screen.ms ?? 0) / 60000) } : null,
      admitted: report.admitted, proposed: report.proposed, promoted, blocked, retired: report.retired, demoteProposed: report.demoteProposed, brewing: report.brewing, free: report.free, auto: Boolean(cfg.incubator.promote.auto) };
    this.db.kvSet('incubator.lastHunt', hunt);
    if (promoted.length || report.proposed.length || report.retired.length || report.demoteProposed.length) {
      const lines = [`Pair hunt (${actor})`, screen ? `screen: ${screen.runs} runs, ${screen.passed} passed, ${screen.new} new` : '', `admitted ${report.admitted.length} · proposed ${report.proposed.length} · promoted ${promoted.length} · retired ${report.retired.length}`,
        ...promoted.map(p => `+ LIVE ${p}`), ...report.proposed.filter(p => !promoted.includes(p)).map(p => `? proposed ${p}`), ...blocked.map(b => `! ${b}`), ...report.demoteProposed.map(p => `- demotion proposed ${p}`)].filter(Boolean);
      void this.ops.alerts.raise('incubator.hunt', lines.join('\n')).catch(() => undefined);
    }
    log.info(`incubator: evaluated by ${actor}: ${report.proposed.length} proposed, ${promoted.length} promoted, ${report.retired.length} retired, ${report.admitted.length} admitted, ${report.demoteProposed.length} proposed for demotion`);
    return { synced, report, promoted, blocked };
  }

  async stop() {
    this.incubator.stop();
    this.executor?.stop();
    if (this.marketTimer) clearInterval(this.marketTimer);
    if (this.huntTimer) clearInterval(this.huntTimer);
    this.feed.stop();
    await this.pool.stop();
  }
}

export type { AppConfig };
