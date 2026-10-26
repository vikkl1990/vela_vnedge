import { ShadowDispatch } from './dispatch.ts';
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
import { TF_SECONDS, type AppConfig, type RiskConfig } from '../config.ts';
import { BarWatermark } from '../scanners/watermark.ts';
import { regimeRefusal } from '../risk/manager.ts';
import type { CandleStore, Bar } from '../data/candleStore.ts';
import type { PinePool } from '../pine/pool.ts';
import type { LoadedScanner, ScannerRegistry } from '../scanners/registry.ts';
import type { ScanEvent } from '../scanners/extractor.ts';
import type { ExitMode } from '../config.ts';
import type { MarketInfo, PaperEngine } from '../paper/engine.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { applyRules, labelKey } from '../scanners/rules.ts';
import { lastAtr } from '../data/indicators.ts';
import { resolveLevels, trendGateReason, trendNow } from '../paper/logic.ts';
import type { Features, FeatureInputs } from '../ml/features.ts';
import { logger } from '../log.ts';
import { mirrorRefusal } from './gate.ts';
import { IncubatorStore, funnelClass, type PairRow, type SignalFunnel } from './store.ts';
import { ACTIVE_STAGES } from './cycle.ts';
import { readingOf } from '../scanners/reading.ts';

const log = logger.scoped('incubator');
const SYNC_MS = 5 * 60_000;
/** Decision 112: how long a shadow pair's signal record is kept, and how many entries per pair. */
const FUNNEL_MS = 14 * 86_400_000;
const FUNNEL_CAP = 120;
const FUNNEL_SAVE_MS = 10_000;

export type FunnelKind = 'opened' | 'pending' | 'regime' | 'cost' | 'market' | 'quote' | 'other';

/**
 * The cell-intrinsic gates the account applies, asked of a shadow entry (decision 112): the market gate and the
 * regime gate, by the same rules. Account-state gates (loss limits, caps, burst, cooldowns) stay live-only, because
 * they depend on what else the book holds and would make shadow evidence depend on the fleet's luck.
 */
export function shadowRefusal(inp: { regime: RiskConfig['regime'] | undefined; scannerId: string; symbol: string; at: number; price: number; atr?: number; bars: Bar[]; market: { allowed: boolean; reasons: string[] } | null | undefined }): { kind: 'market' | 'regime'; reason: string } | null {
  if (inp.market && !inp.market.allowed) return { kind: 'market', reason: `market: ${inp.market.reasons.join('; ') || 'not allowed'}` };
  const regime = regimeRefusal(inp.regime, inp.scannerId, { at: inp.at, price: inp.price, atr: inp.atr }, inp.bars);
  return regime ? { kind: 'regime', reason: regime } : null;
}
const DELAY_MS = 20_000;
/** Decision 201: background shadow scans stop above this share of the pool's memory guard. */
const SHADOW_MEMORY_SHARE = 0.85;
/** Time a scan is assumed to need once it starts, kept aside from the staleness budget. */
const RUN_ALLOWANCE_MS = 5_000;

export class ShadowRunner {
  private pairs: PairRow[] = [];
  private dispatch: ShadowDispatch<{r:PairRow;barAt:number;seenAt:number}>;
  private dispatchTimer: NodeJS.Timeout | null = null;
  private nextDispatchSave=0;
  get dispatchStats(){return this.dispatch.stats;}
  private seen = new Set<string>();
  private labels = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | null = null;
  private deps: { store: IncubatorStore; cfgRef: () => AppConfig; candles: CandleStore; pool: PinePool; registry: ScannerRegistry; paper: PaperEngine; marketInfo: (symbol: string) => Promise<MarketInfo>; /** Decision 116: the account takes the shadow pair's events too, under its own gates, when `incubator.mirror.enabled`. */ mirror?: (s: LoadedScanner, symbol: string, tf: string, ev: ScanEvent, bars: Bar[], market: MarketInfo, exitMode: ExitMode, lastBar: Bar) => void; /** Decision 112: the market gate's verdict on a symbol today, as the account reads it. */ marketVerdict?: (symbol: string) => { allowed: boolean; reasons: string[] } | null; /** Decision 108: every shadow entry carries the model's features and probability, as a live entry does. */ ml?: { features(inp: FeatureInputs): Features; score(scannerId: string, f: Features, opts?: { record?: boolean; tf?: string }): { prob: number } | null }; subscribe?: (symbols: string[]) => void; /** Decision 166: what the account can act on now, to order a wave's scans by it. */ accountFocus?: () => { held: Set<string>; full: boolean }; /** Decision 201: whether the account holds an open position on this scanner, market and timeframe — its exits must reach the account whatever the copy setting. */ accountHolds?: (scannerId: string, symbol: string, tf: string) => boolean };
  private marketsCache: { at: number; map: Map<string, { turnoverUsd: number | null }> } | null = null;
  /** The market gate's 24h turnover for a symbol (null when unjudged), read at most once a minute. */
  private turnoverOf(symbol: string): number | null {
    if (!this.marketsCache || Date.now() - this.marketsCache.at > 60_000) this.marketsCache = { at: Date.now(), map: this.deps.store.marketsToday() };
    return this.marketsCache.map.get(symbol)?.turnoverUsd ?? null;
  }
  readonly stats = { runs: 0, skipped: 0, expired: 0, errors: 0, entries: 0, refused: 0, mirrored: 0, /** Decision 201: exits forwarded for positions the account holds, with copying off. */ exitsForHeld: 0, /** Decision 201: background scans skipped near the memory guard. */ memorySkipped: 0, /** Decision 193: runs dropped because the pair, its stage or its scanner changed while they queued. */ superseded: 0, /** Decision 177: entries the account was not offered because the pair had no record yet or the market is thin. */ mirrorHeld: 0, lastBarAt: 0,
    /** The last error per scanner, so a script failing on every bar is visible rather than a bare count. */
    lastErrors: {} as Record<string, { error: string; at: number; count: number; symbol: string; tf: string }> };
  /** Decision 112: per shadow pair, what became of its signals — [at, class], newest last. */
  private funnel: Map<string, Array<[number, string]>>;
  private funnelDirty = false;
  private funnelTimer: NodeJS.Timeout | null = null;

  /** Decision 125: the last bar each pair acted on, so a skipped bar's exits are still read. */
  private marks: BarWatermark;
  constructor(deps: ShadowRunner['deps']) {
    this.marks = new BarWatermark({ load: () => deps.store.liveMarks(), save: rec => deps.store.setLiveMarks(rec) });
    this.deps = deps;
    this.dispatch=new ShadowDispatch({
      limit:()=>Math.max(1,(deps.pool.size??1)-(deps.pool.reserved??0)),
      ready:()=>!deps.pool.stats.queuedLive && deps.pool.rssReader()<deps.pool.memoryGuardBytes*SHADOW_MEMORY_SHARE,
      run:({r,barAt,seenAt})=>this.run(r,barAt,false,seenAt),
      error:(e,{r})=>{this.noteError(r,String((e as any)?.message??e));log.warn(`shadow ${r.scannerId} ${r.symbol}: ${String(e)}`);}
    });
    this.funnel = new Map(Object.entries(deps.store.shadowFunnel()));
    // decision 190: a resting order is `pending` until the book fills or cancels it; then its funnel entry is rewritten
    deps.paper.on?.('order', (o: { positionId: number; reason: string }) => { if (o.reason === 'entry') this.resolvePending(o.positionId, 'opened'); });
    deps.paper.on?.('pending', (ev: { type: string; id?: number }) => { if (ev.type === 'cancelled' && ev.id !== undefined) this.resolvePending(ev.id, 'other'); });
  }

  private pendingFunnel = new Map<number, { key: string; at: number }>();
  private resolvePending(id: number, kind: FunnelKind): void {
    const p = this.pendingFunnel.get(id);
    if (!p) return;
    this.pendingFunnel.delete(id);
    const list = this.funnel.get(p.key);
    const i = list?.findIndex(x => x[0] === p.at && x[1] === 'pending') ?? -1;
    if (list && i >= 0) { list[i] = [p.at, kind]; this.funnelDirty = true; this.saveFunnelSoon(); }
  }

  /** Record what became of one signal on a pair. */
  private note(key: string, kind: FunnelKind, at: number): void {
    const list = this.funnel.get(key) ?? [];
    list.push([at, kind]);
    const cut = at - FUNNEL_MS;
    const kept = list.filter(x => x[0] >= cut).slice(-FUNNEL_CAP);
    this.funnel.set(key, kept);
    this.funnelDirty = true;
    this.saveFunnelSoon();
  }

  private saveFunnelSoon(): void {
    if (!this.funnelTimer) { this.funnelTimer = setTimeout(() => { this.funnelTimer = null; this.saveFunnel(); }, FUNNEL_SAVE_MS); this.funnelTimer.unref(); }
  }

  saveFunnel(): void {
    if (!this.funnelDirty) return;
    try { this.deps.store.setShadowFunnel(Object.fromEntries(this.funnel)); this.funnelDirty = false; } catch (e: any) { log.warn(`shadow funnel not saved: ${e?.message ?? e}`); }
  }

  /** What became of a pair's signals since `since`, in the shape the live cells' record has. */
  funnelOf(key: string, since: number): SignalFunnel {
    const f: SignalFunnel = { entries: 0, opened: 0, pending: 0, regime: 0, cost: 0, market: 0, quote: 0, other: 0, lastOpenAt: null };
    for (const [at, k] of this.funnel.get(key) ?? []) {
      if (at < since) continue;
      f.entries++; const kk = (k in f ? k : 'other') as FunnelKind; f[kk]++;
      if (kk === 'opened') f.lastOpenAt = Math.max(f.lastOpenAt ?? 0, at);
    }
    return f;
  }

  get active(): PairRow[] { return this.pairs; }

  /** Markets the shadow book needs live data for: its pairs, plus any with an open shadow position. */
  symbols(): string[] { return [...new Set([...this.pairs.map(r => r.symbol), ...this.deps.paper.openPositions().map(p => p.symbol)])]; }

  start() {
    // each pair runs on its own timeframe: the daily screen is 15m, but a survey can admit 1h or 4h pairs
    this.deps.candles.on('closed', (e: { symbol: string; tf: string; bar: Bar; historical?: boolean }) => {
      if (!e.historical && this.pairs.some(r => r.tf === e.tf)) this.onBarClosed(e.symbol, e.tf, e.bar.time + TF_SECONDS[e.tf] * 1000);
    });
    this.dispatchTimer=setInterval(()=>{this.dispatch.drain();if(Date.now()>=this.nextDispatchSave){try{this.deps.store.setDispatchStats?.({...this.dispatchStats,at:Date.now()});}catch(e){log.warn(`shadow dispatch metrics save failed: ${String(e)}`);}this.nextDispatchSave=Date.now()+5000;}},100);this.dispatchTimer.unref();
    void this.sync();
    this.timer = setInterval(() => void this.sync(), SYNC_MS);
    this.timer.unref();
  }

  stop() { this.dispatch.stop();if(this.dispatchTimer)clearInterval(this.dispatchTimer);this.dispatchTimer=null; if (this.timer) clearInterval(this.timer); this.timer = null; this.saveFunnel(); }

  /** Pick up stage changes made by the daily job or the API, and make sure their candles are live. */
  async sync(): Promise<void> {
    const cfg = this.deps.cfgRef();
    if (!cfg.incubator?.enabled) { this.pairs = [];this.dispatch.prune(new Set()); return; }
    this.pairs = this.deps.store.list([...ACTIVE_STAGES, 'tracked']).filter(r => r.tf in TF_SECONDS && this.deps.registry.get(r.scannerId)?.status === 'ok');
    this.dispatch.prune(new Set(this.pairs.map(r=>`${r.scannerId}:${r.symbol}:${r.tf}`)));
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

  private onBarClosed(symbol: string, tf: string, closedAt = Date.now()) {
    const due = this.pairs.filter(r => r.symbol === symbol && r.tf === tf);
    if (!due.length) return;
    // measured from when the bar actually closed, not from now: tracking a new market announces its
    // newest closed bar mid-cycle, and a scan of a bar that old could never be traded
    const barAt = closedAt, seenAt = Date.now();
    // decision 165: a pair the account may copy is scanned at once, in the pool's `mirror` tier (after the account's own
    // scans, before background work); the 20 s wait and the background queue had put the account's mirrored entries a
    // median 54 s after the bar's close
    const mirror = this.deps.cfgRef().incubator?.mirror?.enabled === true && Boolean(this.deps.mirror);
    // decision 201: a pair holding a position — in the account (copied before copying was switched off) or in the shadow
    // book itself — is scanned in the mirror tier and never dropped under backpressure: an exit there is a position's
    const shadowHeld = new Set(this.deps.paper.openPositions().filter(p => p.symbol === symbol && p.tf === tf).map(p => p.scannerId));
    const holds = (r: PairRow) => shadowHeld.has(r.scannerId) || this.deps.accountHolds?.(r.scannerId, r.symbol, r.tf) === true;
    // decision 166: what can change the account first — its live pairs and any pair on a symbol it holds (an exit there
    // is money), then pairs it could enter now (not full, symbol free, market allowed), then the rest of the book
    const focus = this.deps.accountFocus?.();
    const canEnter = (r: PairRow) => !!focus && !focus.full && !focus.held.has(r.symbol) && this.deps.marketVerdict?.(r.symbol)?.allowed !== false;
    const rank = (r: PairRow) => (r.stage === 'live' || focus?.held.has(r.symbol) ? 0 : canEnter(r) ? 1 : 2);
    // In copy mode, unqualified research cells must not consume the urgent lane.
    const copyable=(r:PairRow)=>r.stage!=='tracked' && (r.stage==='live' || !mirrorRefusal(this.deps.cfgRef().incubator.mirror,this.deps.store.trades(r.scannerId,r.symbol,r.tf,2),this.turnoverOf(r.symbol)));
    const urgent=due.filter(r=>holds(r)||(mirror&&copyable(r))).sort((a,b)=>rank(a)-rank(b));
    const later = due.filter(r => !urgent.includes(r));
    const launch = (rows: PairRow[], live: boolean) => {
      if (!rows.length) return;
      if (!live) {
        const cfg=this.deps.cfgRef();
        const deadline=barAt+(cfg.paper.maxSignalAgeSec>0?cfg.paper.maxSignalAgeSec*1000:300000)-RUN_ALLOWANCE_MS;
        for(const r of rows)this.dispatch.enqueue(`${r.scannerId}:${r.symbol}:${r.tf}`,{r,barAt,seenAt},deadline);
        this.dispatch.drain();return;
      }
      for (const r of rows) this.run(r, barAt, live, seenAt).catch(e => { this.noteError(r, String(e?.message ?? e)); log.warn(`shadow ${r.scannerId} ${symbol}: ${e?.message ?? e}`); });
    };
    launch(urgent, true);
    if (later.length) setTimeout(() => launch(later, false), DELAY_MS).unref();
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

  /**
   * Decision 166: how a bar close's wave of mirror-tier scans spent its time, so latency is measured, not guessed. Per
   * wave (timeframe and bar): from the close to its announcement (seen), from there to each run's dispatch (prep), in the pool before and around the script
   * (queue), the script itself (exec), and the close to the last result. Logged once the wave is quiet for 5 s.
   */
  private waves = new Map<string, { tf: string; barAt: number; seen: number[]; prep: number[]; queue: number[]; exec: number[]; last: number; timer?: ReturnType<typeof setTimeout> }>();
  readonly lastWaves: Array<{ tf: string; barAt: number; runs: number; doneSec: number; seenP50: number; seenP90: number; prepP50: number; queueP50: number; queueP90: number; execP50: number; execP90: number }> = [];
  private noteWave(tf: string, barAt: number, seenAt: number, tPool: number, tDone: number, execMs: number) {
    const key = `${tf}:${barAt}`;
    const w = this.waves.get(key) ?? { tf, barAt, seen: [], prep: [], queue: [], exec: [], last: 0 };
    w.seen.push(seenAt - barAt); w.prep.push(tPool - seenAt); w.exec.push(execMs); w.queue.push(Math.max(0, tDone - tPool - execMs)); w.last = Math.max(w.last, tDone);
    this.waves.set(key, w);
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      this.waves.delete(key);
      const q = (a: number[], p: number) => { const x = [...a].sort((m, n) => m - n); return x[Math.min(x.length - 1, Math.floor(p * x.length))] ?? 0; };
      const sum = { tf, barAt, runs: w.exec.length, doneSec: Math.round((w.last - barAt) / 100) / 10, seenP50: q(w.seen, 0.5), seenP90: q(w.seen, 0.9), prepP50: q(w.prep, 0.5), queueP50: q(w.queue, 0.5), queueP90: q(w.queue, 0.9), execP50: q(w.exec, 0.5), execP90: q(w.exec, 0.9) };
      this.lastWaves.unshift(sum); if (this.lastWaves.length > 24) this.lastWaves.pop();
      log.info(`shadow wave ${tf} ${new Date(barAt).toISOString().slice(11, 16)}: ${sum.runs} runs done ${sum.doneSec}s after close · close seen p50 ${sum.seenP50} p90 ${sum.seenP90}ms · prep p50 ${sum.prepP50}ms · queue p50 ${sum.queueP50} p90 ${sum.queueP90}ms · exec p50 ${sum.execP50} p90 ${sum.execP90}ms`);
    }, 5_000);
    w.timer.unref?.();
  }

  private noteError(r: PairRow, error: string) {
    this.stats.errors++;
    const prev = this.stats.lastErrors[r.scannerId];
    this.stats.lastErrors[r.scannerId] = { error: error.slice(0, 200), at: Date.now(), count: (prev?.count ?? 0) + 1, symbol: r.symbol, tf: r.tf };
    const keys = Object.keys(this.stats.lastErrors);
    if (keys.length > 60) delete this.stats.lastErrors[keys.sort((a, b) => this.stats.lastErrors[a].at - this.stats.lastErrors[b].at)[0]];
  }

  private async run(rAtStart: PairRow, barAt = Date.now(), live = false, seenAt = Date.now()): Promise<void> {
    let r = rAtStart;
    const s = this.deps.registry.get(r.scannerId);
    if (!s || s.status !== 'ok') return;
    const cfg = this.deps.cfgRef();
    const scannerCfgAtStart = JSON.stringify(cfg.scanners[s.id] ?? null);
    const bars = this.deps.candles.get(r.symbol, r.tf, { closedOnly: true, limit: cfg.historyBars });
    if (bars.length < 50) return;
    const market = await this.deps.marketInfo(r.symbol);
    // the scanner's configured input overrides, exactly as a live run of it would use
    const inputs = cfg.scanners[s.id]?.inputs;
    const budget = this.budgetMs(cfg, barAt);
    if (budget <= 0) { this.stats.expired++; return; }
    const tPool = Date.now();
    // decision 193: output back to the watermark (capped), so a stall's exits are still there to read
    const win = this.marks.window(`${r.scannerId}:${r.symbol}:${r.tf}`, bars.at(-1)!.time, r.tf);
    const res = await this.deps.pool.run(
      { scannerId: s.id, source: s.patched, symbol: r.symbol, tf: r.tf, tickSize: market.tickSize, bars, tailBars: win.tailBars, plotTail: 400, inputs: inputs && Object.keys(inputs).length ? inputs : undefined, timezone: cfg.scanners[s.id]?.timezone },
      { deadlineMs: budget, priority: live ? 'mirror' : 'shadow' });
    this.stats.runs++; this.stats.lastBarAt = bars.at(-1)!.time;
    if (live) this.noteWave(r.tf, barAt, seenAt, tPool, Date.now(), res.ms ?? 0);
    if (!res.ok) { if (/too late to be useful/.test(res.error ?? '')) this.stats.expired++; else this.noteError(r, res.error ?? 'unknown'); return; }
    // decision 193: the run waited in the queue; the pair may have been retired or re-staged, the scanner re-configured
    // or its source replaced meanwhile. As the account's engine does, act only if all of that still holds — and on the
    // pair's current stage, which decides whether the account is offered the event
    const cur = this.deps.store.get(r.id);
    const cfgNow = this.deps.cfgRef();
    if (!cur || !([...ACTIVE_STAGES, 'tracked'] as string[]).includes(cur.stage) || !cfgNow.incubator?.enabled
        || JSON.stringify(cfgNow.scanners[s.id] ?? null) !== scannerCfgAtStart || this.deps.registry.get(s.id)?.patched !== s.patched) {
      this.stats.superseded++;
      return;
    }
    r = cur;
    const key = `${r.scannerId}:${r.symbol}:${r.tf}`;
    const prev = this.labels.get(key);
    const current = new Set(res.labels.map(labelKey));
    const newLabelKeys = prev ? new Set([...current].filter(k => !prev.has(k))) : new Set<string>();
    this.labels.set(key, current);
    const lastBar = bars.at(-1)!;
    const READ = readingOf(cfg.scanners[s.id], s.id, (TF_SECONDS[r.tf] ?? 0) * 1000, s.patched, s.variantOf);   // decision 195
    const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: cfg.scanners[s.id]?.rule ?? null, bars, mode: 'live', newLabelKeys, ...READ.rule });
    // decision 125: read from the bar after the last one this pair acted on; entries on a superseded bar are stale and dropped
    const events = extractEvents(res.alerts, res.shapes, { barMs: (TF_SECONDS[r.tf] ?? 0) * 1000, drawn: res.labels, scannerId: s.id, sinceBarTime: win.since, derived, ...READ.extract })
      .filter(ev => !(ev.kind === 'entry' && ev.barTime < lastBar.time));
    this.marks.advance(key, lastBar.time);
    const exitMode = cfg.scanners[s.id]?.exitMode ?? 'both';
    for (const ev of events) {
      const id = `${key}:${ev.barTime}:${ev.kind}:${ev.side ?? ''}:${ev.label}`;
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      if (this.seen.size > 20_000) this.seen = new Set([...this.seen].slice(-10_000));
      const now = Date.now();
      // decision 116: the account is offered the same event, and judges it by its own gates and caps
      // decision 139: a tracked cell is the operator's to watch, never the account's to copy
      // decision 201: an exit reaches the account whenever the account holds the position, copying on or off — switching
      // copying off used to switch off the script exits of the positions it had already opened
      const exitForHeld = ev.kind === 'exit' && Boolean(this.deps.mirror) && this.deps.accountHolds?.(s.id, r.symbol, r.tf) === true;
      if (exitForHeld && !(cfg.incubator.mirror?.enabled && r.stage !== 'tracked')) {
        this.stats.exitsForHeld++;
        try { this.deps.mirror!(s, r.symbol, r.tf, ev, bars, market, exitMode, lastBar); } catch (e: any) { log.warn(`held exit ${s.id} ${r.symbol}: ${e?.message ?? e}`); }
      } else if (cfg.incubator.mirror?.enabled && this.deps.mirror && r.stage !== 'tracked' && (ev.kind === 'entry' || ev.kind === 'exit')) {
        // decision 177: an entry is copied only once the pair has a record of its own and its market is deep enough; an
        // exit always goes through, since the account may hold the position
        const held = ev.kind === 'entry' && r.stage !== 'live' ? mirrorRefusal(cfg.incubator.mirror, this.deps.store.trades(r.scannerId, r.symbol, r.tf, 2), this.turnoverOf(r.symbol)) : null;
        if (held) { this.stats.mirrorHeld++; log.debug(`${held}: ${s.id} ${r.symbol} ${r.tf} ${ev.side ?? ''}`); }
        else {
          this.stats.mirrored++;
          try { this.deps.mirror(s, r.symbol, r.tf, ev, bars, market, exitMode, lastBar); } catch (e: any) { log.warn(`mirror ${s.id} ${r.symbol}: ${e?.message ?? e}`); }
        }
      }
      if (ev.kind === 'entry' && ev.side) {
        // the shadow book is evidence for the live fleet, so it is gated exactly as the fleet is
        const g = cfg.paper.trendGate;
        if (g?.enabled) {
          const mode = cfg.scanners[s.id]?.trendGate ?? g.mode;
          const trendTf = g.tf && g.tf !== r.tf ? g.tf : r.tf;
          const closes = this.deps.candles.get(r.symbol, trendTf, { closedOnly: true, limit: g.emaLen * 4 }).map(b => b.close);
          if (trendGateReason(ev.side, trendNow(closes, g.emaLen), mode)) continue;
        }
        const atr = lastAtr(bars, 14);
        const refPrice = this.deps.paper.mark(r.symbol) ?? lastBar.close;
        // decision 112: the market and regime gates refuse a shadow entry exactly as they refuse a live one
        const fkey = `${s.id}|${r.symbol}|${r.tf}`;
        const refusal = shadowRefusal({ regime: cfg.risk?.regime, scannerId: s.id, symbol: r.symbol, at: now, price: ev.price && ev.price > 0 ? ev.price : refPrice, atr, bars, market: this.deps.marketVerdict?.(r.symbol) });
        if (refusal) { this.stats.refused++; this.note(fkey, refusal.kind, now); continue; }
        // decision 108: the same entry-time features and probability a live entry gets, so the shadow book can
        // judge the model out of sample; scored without feeding the drift monitor, which watches the account
        let features: Features | undefined; let mlProb: number | null = null;
        if (this.deps.ml && atr) {
          const price = ev.price && ev.price > 0 ? ev.price : refPrice;
          const levels = resolveLevels({ side: ev.side, price, sl: ev.sl, tp: ev.tp, atr }, cfg.paper, market.tickSize);
          if (!('error' in levels)) {
            features = this.deps.ml.features({ bars, i: bars.length - 1, ev, entry: price, sl: levels.sl, tp1: levels.tp[0], atr, levelsSource: levels.source });
            mlProb = this.deps.ml.score(s.id, features, { record: false, tf: r.tf })?.prob ?? null;
          }
        }
        const d = this.deps.paper.onEntry(ev, { scannerId: s.id, scannerName: s.name, symbol: r.symbol, tf: r.tf, market, atr, refPrice, at: now, signalId: null, exitMode, features, mlProb });
        if (d.action === 'opened' || d.action === 'reversed') this.stats.entries++;
        const kind: FunnelKind = d.action === 'opened' || d.action === 'reversed' ? 'opened' : funnelClass(`${d.action}:${d.reason ?? ''}`);
        this.note(fkey, kind, now);
        if (kind === 'pending' && d.pendingId !== undefined) this.pendingFunnel.set(d.pendingId, { key: fkey, at: now });
      } else if (ev.kind === 'exit') {
        this.deps.paper.onScriptExit(s.id, r.symbol, r.tf, ev.exitType ?? 'close', ev.price, now, exitMode, ev.side);
      }
    }
  }
}
