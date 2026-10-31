import type { ExecutionPlanSnapshot } from './executionPlans.ts';
import {applyFundingSettlement} from './logic.ts';
import {recordFillBudget} from './decisionTrace.ts';
import {depthPlan} from './depthPlan.ts';
import { initEntryExecution, recordEntryExecution } from './entryExecution.ts';
import {alignmentRule,alignmentRefusal} from './entryAlignment.ts';
import {createReclaim, advanceReclaim, type ReclaimState} from './reclaim.ts';
import {initReclaimAudit,recordReclaimEvent} from './reclaimAudit.ts';
import type {Bar} from '../data/candleStore.ts';
import { offerStatus, type EntryExecution } from './costs.ts';
import { EventEmitter } from 'node:events';
import type { Db } from '../db.ts';
import { TF_SECONDS, type AppConfig, type ExitMode, type ExitOverride, type PaperConfig } from '../config.ts';
import type { Side, ExitType, ScanEvent } from '../scanners/extractor.ts';
import { logger } from '../log.ts';
import { configFingerprint } from './fingerprint.ts';
import {
  giveBackPct, type Position, type Fill, type PriceBar, type LevelResult, applyLiveBar, openR, reversalAllowed, applyScriptExit, applyTrade, applyMark, applyFunding, checkRiskVsFees, trendExit, computeStats, fillExit, openPosition, resolveLevels, sizeContracts, recordLeverage, unrealized, notionalOf, rMultiple, type TradeStats, exitConfigFor, earlyStallExit, splitLegs, liquidationPrice, pnlOf, modelTrail } from './logic.ts';
import type { StructureLevel } from './luxExits.ts';

const log = logger.scoped('paper');

/** Pricing provenance belongs to one fill, never to an engine-wide pending context. */
interface FillContext { ref?: number; source?: 'quote' | 'depth' | 'slippage' | 'exchange' }

export interface MarketInfo { contractValue: number; tickSize: number; maintenanceMarginPct?: number; maxLeverage?: number }
export type EntryContext = {executionPlan?: ExecutionPlanSnapshot;scannerId: string; scannerName: string; symbol: string; tf: string; market: MarketInfo; atr?: number; refPrice: number; at: number; signalId: number | null; exitMode: ExitMode; features?: Record<string, number>; mlProb?: number | null; scoreOverride?: number; sizeScale?: number};
type ReclaimTrial = NonNullable<PaperConfig['reclaimTrials']>[number];
type PlannedReclaim = {price: number; expiresAt: number; ruleKey: string};

export interface EntryDecision {
  action: 'opened' | 'ignored' | 'rejected' | 'reversed' | 'pending';
  reason?: string;
  position?: Position;
  closed?: Position;
  /** Tape mode: the position id reserved for an entry that fills at the next print after the latency window. */
  pendingId?: number;
}

/** Entry request passed to the portfolio risk layer (phase 3) before sizing. */
export interface RiskEntryRequest { scannerId: string; symbol: string; tf: string; side: Side; price: number; sl: number; atr?: number; at: number;
  /** A reversal: the open position this entry replaces; it does not count against caps or exposure (decision 77). */
  replacing?: number }
/** Portfolio risk layer hook (implemented by risk/manager.ts; optional so the engine and tests work without it). */
export interface RiskGate {
  /** Restore in-memory gate state if a synchronous account decision rolls back. */
  checkpoint?: () => () => void;
  leverageMult?: () => number;
  /** Veto (`reject`) or scale (`leverageMult` ≤ 1 from drawdown scaling) an entry before sizing. */
  gate(req: RiskEntryRequest): { reject?: string; leverageMult: number };
  /** Correlation / exposure cap once the candidate's notional is known; returns a rejection reason or null. */
  exposureCheck(req: { symbol: string; side: Side; tf: string; notional: number; replacing?: number }): string | null;
}

/** A pending entry is abandoned this long after its latency window closes. */
export const PENDING_EXPIRY_MS = 60_000;
/** Decision 190: a candle or print received this long after its event can no longer fill a resting limit (a candle's event is its minute's start). */
export const LIMIT_LATE_MS = 3 * 60_000;
/** Candles mode: a due entry with no price update since the window closed fills at the mark after this long (the order is on the book; a quiet tape is not a reason not to fill). */
export const QUIET_FILL_MS = 1000;

/** Tape-mode entry waiting for its first print after signal time + latency. */
export interface PendingEntry {
  executionPlan?: ExecutionPlanSnapshot;
  id: number; scannerId: string; scannerName: string; symbol: string; tf: string; side: Side; signalPrice: number; levels: LevelResult;
  market: MarketInfo; at: number; dueAt: number; signalId: number | null; features?: Record<string, number>; mlProb: number | null; score?: number; leverageMult: number; sizeScale?: number;
  /** Decision 185: a resting maker limit — its price, when it lapses, and what the levels are resolved from at the fill. */
  limit?: { price: number; expiresAt: number; atr: number; sl?: number; tp?: number[]; bars: number };
  /** Decision 186: a reversal's held position, closed only when this entry fills (a cancelled reversal keeps it). */
  replacingId?: number;
  reclaim?: {state: ReclaimState; event: ScanEvent; context: EntryContext; ruleKey: string};
  reclaimRuleKey?: string;
}

/**
 * Live paper-trading account. Persists positions/orders/equity to SQLite and emits
 * `position` ({type, position}), `trade` (closed position), `order` (fill) and `stats`.
 */
export class PaperEngine extends EventEmitter {
  /** Synchronous durable execution sink, called inside the fill transaction. */
  executionIntent?: (orderId: number, order: ReturnType<typeof orderOf>) => void;
  private decisionActive = false;
  private logInfo(message:string){this.db.afterCommit(()=>log.info(message));}
  override emit(event: string | symbol, ...args: any[]): boolean {
    if (this.db?.inTransaction) {
      this.db.afterCommit(() => { super.emit(event, ...args); });
      return this.listenerCount(event) > 0;
    }
    return super.emit(event, ...args);
  }

  /** The signal outcome, paper mutations and inbox completion share one commit.
   * Keep original position identities on rollback; callers may still hold those objects. */
  commitDecision<T>(fn: () => T): T {
    if (this.db.inTransaction || this.decisionActive) throw new Error('account decision must own its transaction');
    const open=[...this.open].map(([id,ref])=>({id,ref,saved:structuredClone(ref)}));
    const pending=[...this.pending].map(([id,ref])=>({id,ref,saved:structuredClone(ref)}));
    const state={peak:this.peak,maxDd:this.maxDd,lastEquityPoint:this.lastEquityPoint,lastEquityValue:this.lastEquityValue,
      fpSeen:new Set(this.fpSeen),lastPathAt:new Map(this.lastPathAt),peakSeen:new Map(this.peakSeen),priceSource:{...this.priceSource}};
    const restoreRisk=this.risk?.checkpoint?.();
    this.decisionActive=true;
    try { return this.db.transaction(fn); }
    catch(e) {
      this.open.clear();this.pending.clear();
      for(const x of open){for(const k of Object.keys(x.ref))delete (x.ref as any)[k];Object.assign(x.ref,x.saved);this.open.set(x.id,x.ref);}
      for(const x of pending){for(const k of Object.keys(x.ref))delete (x.ref as any)[k];Object.assign(x.ref,x.saved);this.pending.set(x.id,x.ref);}
      const {priceSource,...rest}=state;Object.assign(this,rest);Object.assign(this.priceSource,priceSource);
      this.closedCache=null;restoreRisk?.();throw e;
    } finally { this.decisionActive=false; }
  }
  /**
   * Which book this engine owns: 0 is the live paper account, 2 the incubator's shadow book.
   * Every row it writes carries this in `bt`, and every query it makes filters on it, so the books
   * never see each other's positions. (1 is the in-memory backtest and never reaches the table.)
   */
  readonly book: number;
  /** Live exchange status veto, also rechecked when a pending order fills. */
  fundingEntryBlock?: (symbol: string, side: Side, tf: string, notional: number, risk: number, at: number) => string | null;
  entryBlock?: (symbol: string, at: number) => string | null;
  private readonly kvPrefix: string;
  private db: Db;
  private cfgRef: () => AppConfig;
  private open = new Map<number, Position>();
  private closedCache: Position[] | null = null;
  private marks = new Map<string, number>();
  private markTimes = new Map<string, number>();
  private priceBars = new Map<string, PriceBar>();
  private lastEquityPoint = 0;
  private lastEquityValue = NaN;
  /** Highest equity since the last reset and the deepest drawdown from it, persisted; the one source for every drawdown the UI shows. */
  private peak = 0;
  private maxDd = 0;
  // ---- phase 2: tape / mark / funding state ----
  /** Exchange mark price per symbol (from the `mark_price` channel); liquidation reference in tape mode. */
  private markPrices = new Map<string, { price: number; at: number }>();
  /** Wall-clock time of the last tape print per symbol (decides the 1m-candle fallback). */
  private lastTradeAt = new Map<string, number>();
  private lastTradeTime = new Map<string, number>();
  private pending = new Map<number, PendingEntry>();
  /** Portfolio risk layer; set by the composition root (app.ts). */
  risk: RiskGate | null = null;
  alignmentBars?: (symbol:string,tf:string)=>import('../data/candleStore.ts').Bar[];
  private alignmentBlock(cell:{scannerId:string;symbol:string;tf:string;executionPlan?:ExecutionPlanSnapshot},side:Side,at:number):string|null {
    const rule=alignmentRule(cell.executionPlan?.paper??this.paper,cell.executionPlan?.sourceScannerId??cell.scannerId,cell.symbol,cell.tf);
    return rule?alignmentRefusal(rule,side,this.alignmentBars?.(cell.symbol,rule.contextTf)??[],at):null;
  }
  /**
   * How entry prices were obtained since start. `slippage` means no fresh top-of-book was
   * available and the configured slippage model priced the fill; a high share of those means
   * the quote feed is not delivering and simulated fills are optimistic by about half a spread.
   */
  readonly priceSource = { quote: 0, slippage: 0, rejectedNoQuote: 0 };

  marketDepthPrice?: (symbol:string,side:Side,qty:number)=>{price?:number;reject?:string}|undefined;
  prepareEntryDepth?: (symbol: string) => Promise<void>;
  entryDepthGate?: (req: {symbol:string;qty:number;contractValue:number;maker?:boolean;at:number;price:number;sl:number;market:MarketInfo;scannerId:string;tf:string;score?:number;executionPlan?:ExecutionPlanSnapshot}) => {reject?:string;crossingPct?:number};
  private depthRefusal(symbol:string,qty:number,cv:number,price:number,sl:number,cfg:PaperConfig,at:number,maker:boolean,cell:{scannerId:string;tf:string;market:MarketInfo;score?:number;executionPlan?:ExecutionPlanSnapshot}):string|null {
    const d=this.entryDepthGate?.({symbol,qty,contractValue:cv,maker,at,price,sl,...cell});
    if(d?.reject)return d.reject;
    return d?.crossingPct!==undefined?checkRiskVsFees(price,sl,cfg,symbol,d.crossingPct,{maker}):null;
  }

  /**
   * Current ATR of a position's own timeframe (last closed bars), for the ATR trail. Without it the
   * trail falls back to a fixed R distance, which is not the rule the backtest measured.
   */
  atrFor?: (symbol: string, tf: string) => number | undefined;
  /** A scanner's own exit override, supplied by the app so the engine needs no config knowledge. */
  scannerExit?: (scannerId: string, entryAt?: number) => ExitOverride | undefined;
  /** Decision 190: the hash of a scanner's patched source, for the trade's fingerprint. */
  sourceHashFor?: (scannerId: string) => string | null | undefined;
  private fpSeen = new Set<string>();

  /** The position timeframe's trend, +1 or −1, for the trend exit (set by the composition root). */
  trendFor?: (symbol: string, tf: string) => 1 | -1 | undefined;
  /** Decision 178: the market-structure stop of a market and timeframe as of its last closed bar; null while the structure has not spoken. */
  structureFor?: (symbol: string, tf: string) => StructureLevel | null;
  /** Decision 185: whether a resting limit entry may be used (false while an exchange executor mirrors this book with market orders). */
  limitEntryAllowed?: () => boolean;

  constructor(db: Db, cfgRef: () => AppConfig, opts: { book?: number } = {}) {
    super();
    this.db = db; this.cfgRef = cfgRef;
    this.book = opts.book ?? 0;
    initEntryExecution(db);
    initReclaimAudit(db);
    this.kvPrefix = this.book === 0 ? 'paper' : `book${this.book}`;
    this.db.run('CREATE TABLE IF NOT EXISTS config_fingerprints (fp TEXT PRIMARY KEY, parts TEXT NOT NULL, first_at INTEGER NOT NULL)');
    this.loadPeak();
    for (const row of db.all<any>(`SELECT * FROM positions WHERE status='open' AND bt=${this.book}`)) {
      const p = rowToPosition(row); this.open.set(p.id, p);
      // the peak already recorded is the one to beat: a restart must not re-stamp it as newly observed
      if (p.peakR !== undefined) this.peakSeen.set(p.id, p.peakR);
    }
    // pending tape entries do not survive a restart (their signal is seconds old at most); a resting limit (decision 185)
    // does, until it lapses — it can rest for hours, and a deploy must not cancel it
    for (const row of db.all<any>(`SELECT id, signal_id, fills FROM positions WHERE status='pending' AND bt=${this.book}`)) {
      let kept: PendingEntry | null = null;
      let trial:PendingEntry|undefined;
      try { const j = JSON.parse(row.fills ?? 'null'); if (j?.limitEntry?.limit && j.limitEntry.limit.expiresAt > Date.now()) kept = { ...j.limitEntry, id: row.id }; trial=j?.limitEntry??j?.reclaimSetup; } catch { kept = null; }
      // A short reclaim order cannot assume continuity through missed tape during downtime.
      if (kept && !kept.features?.reclaim_trial) { this.pending.set(kept.id, kept); continue; }
      if(trial?.features?.reclaim_trial)this.auditReclaim(trial,'cancelled',Date.now(),'restart cancelled short trial setup/order');
      db.run('DELETE FROM positions WHERE id=?', row.id);
      if (row.signal_id) db.updateSignalAction(row.signal_id, 'rejected:pending entry dropped on restart', null);
    }
    this.logInfo(`loaded ${this.open.size} open ${this.book === 0 ? 'paper' : 'shadow'} positions`);
  }


  private configFor(cell: {scannerId:string;symbol:string;tf:string;entryAt?:number;at?:number;executionPlan?:ExecutionPlanSnapshot}): PaperConfig {
    return cell.executionPlan?.paper ?? exitConfigFor(this.paper,cell.symbol,this.scannerExit?.(cell.scannerId,cell.entryAt ?? cell.at),cell.tf);
  }
  private planEnabled(p: ExecutionPlanSnapshot | undefined): boolean {
    return !p || (this.book===2 && this.cfgRef().executionPlans?.some(x=>x.enabled&&x.id===p.id&&x.revision===p.revision)===true);
  }

  private get paper(): PaperConfig { return this.cfgRef().paper; }
  private get tapeMode(): boolean { return (this.paper.fillSource ?? 'candles') === 'tape'; }

  // ---- account state ----

  /** The database this book writes to (the executor's order ledger lives beside it). */
  get store(): Db { return this.db; }
  get initialEquity(): number { return this.db.kvGet<number>(`${this.kvPrefix}.initialEquity`) ?? this.paper.initialEquity; }

  closedPositions(): Position[] {
    if (!this.closedCache) this.closedCache = this.db.all<any>(`SELECT * FROM positions WHERE status='closed' AND bt=${this.book} ORDER BY exit_at ASC`).map(rowToPosition);
    return this.closedCache;
  }

  realizedPnl(): number { return this.closedPositions().reduce((a, p) => a + p.realizedPnl - p.fees, 0) + [...this.open.values()].reduce((a, p) => a + p.realizedPnl - p.fees, 0); }

  unrealizedPnl(): number {
    let u = 0;
    for (const p of this.open.values()) { const m = this.marks.get(p.symbol); if (m) u += unrealized(p, m); }
    return u;
  }

  /**
   * The live account compounds; a shadow book does not.
   *
   * Book 2 is evidence, not money: every pair must be sized against the same purse for its R to mean
   * the same thing on day one and day thirty. Left to compound, one lucky trade inflates the next
   * hundred — on the VM a single +1.1M win carried the purse to roughly 20M and later trades were
   * sized in hundreds of millions of contracts.
   */
  equity(): number {
    if (this.book !== 0) return this.initialEquity;
    const eq = this.initialEquity + this.realizedPnl() + this.unrealizedPnl();
    this.observeEquity(eq);
    return eq;
  }

  // ---- peak and drawdown (live account only) ----

  private loadPeak() {
    if (this.book !== 0) return;
    const p = this.db.kvGet<number>('paper.peakEquity');
    if (p && p > 0) { this.peak = p; this.maxDd = this.db.kvGet<number>('paper.maxDrawdownPct') ?? 0; return; }
    // first run on an existing account: rebuild both from the equity path recorded since the reset
    let peak = this.initialEquity, dd = 0;
    for (const r of this.db.all<{ equity: number }>('SELECT equity FROM equity WHERE scanner_id IS NULL ORDER BY at')) {
      if (r.equity > peak) peak = r.equity; else if (peak > 0) dd = Math.max(dd, (peak - r.equity) / peak * 100);
    }
    this.peak = peak; this.maxDd = dd;
    this.db.kvSet('paper.peakEquity', peak); this.db.kvSet('paper.maxDrawdownPct', dd);
  }

  private observeEquity(eq: number) {
    if (!Number.isFinite(eq)) return;
    if (eq > this.peak) { this.peak = eq; this.db.kvSet('paper.peakEquity', eq); return; }
    const dd = this.peak > 0 ? (this.peak - eq) / this.peak * 100 : 0;
    if (dd > this.maxDd + 0.01) { this.maxDd = dd; this.db.kvSet('paper.maxDrawdownPct', dd); }
  }

  /** Highest equity since the last reset (a shadow book never moves). */
  peakEquity(): number { return this.book === 0 ? this.peak : this.initialEquity; }
  /** Drawdown right now from that peak, open positions included. */
  drawdownPct(): number { if (this.book !== 0) return 0; const eq = this.equity(); return this.peak > 0 ? Math.max(0, (this.peak - eq) / this.peak * 100) : 0; }
  /** Deepest drawdown since the reset, on the same path. */
  maxDrawdownPct(): number { return Math.max(this.maxDd, this.drawdownPct()); }

  /** The same override resolution used by fills, including script-mode policy. */
  view(p: Position, exchangeMark?: number | null) {
    return positionView(p, this.mark(p.symbol), exchangeMark, this.configFor(p));
  }
  openPositions(): Position[] { return [...this.open.values()]; }
  position(id: number): Position | undefined { return this.open.get(id) ?? (this.db.get<any>('SELECT * FROM positions WHERE id=?', id) ? rowToPosition(this.db.get<any>('SELECT * FROM positions WHERE id=?', id)) : undefined); }

  /** Last traded price (ticker / tape / candle close): reference for unrealized P&L and market fills. */
  setMark(symbol: string, price: number) { if(Number.isFinite(price)&&price>0){this.marks.set(symbol,price);this.markTimes.set(symbol,Date.now());} }
  /** Recovery cannot execute against the pre-crash signal price. Wait for a current quote/ticker. */
  hasFreshPrice(symbol:string,side:'buy'|'sell',at=Date.now()):boolean {
    const age=this.paper.quoteMaxAgeMs>0?this.paper.quoteMaxAgeMs:10_000;
    const quote=this.quotes?.executable(symbol,side,age,at);
    return !!(quote&&Number.isFinite(quote)&&quote>0) || ((this.marks.get(symbol)??0)>0 && at-(this.markTimes.get(symbol)??0)<=age);
  }

  /** Live top-of-book source (set by the realtime wiring); enables spread-crossing fills. */
  quotes: {
    executable(symbol: string, side: 'buy' | 'sell', maxAgeMs: number, now?: number): number | null;
    markState?(symbol: string): { bestBid: number | null; bestAsk: number | null; at: number; quoteAt?: number | null; quoteExchangeAt?: number | null } | undefined;
  } | null = null;

  /**
   * Price a market-style fill. With a fresh quote we cross the real spread (buy at ask,
   * sell at bid); otherwise we fall back to the configured slippage around `reference`.
   */
  /**
   * The book's round-trip cost right now, as a percent of price: the spread a market entry and a
   * market exit cross between them (decision 96). Zero when no fresh quote exists, so the check falls
   * back to fees alone rather than inventing a book.
   */
  spreadPct(symbol: string, cfg: PaperConfig, now = Date.now()): number {
    if (!cfg.useSpread || !this.quotes?.markState) return 0;
    const q = this.quotes.markState(symbol);
    if (!q || q.bestBid == null || q.bestAsk == null || !(q.bestAsk > q.bestBid) || !(q.bestBid > 0)) return 0;
    if ((cfg.quoteMaxAgeMs ?? 0) > 0 && q.quoteAt != null && now - q.quoteAt > (cfg.quoteMaxAgeMs ?? 0)) return 0;
    return (q.bestAsk - q.bestBid) / ((q.bestAsk + q.bestBid) / 2) * 100;
  }

  marketPrice(symbol: string, side: 'buy' | 'sell', reference: number, cfg: PaperConfig, now = Date.now()): { price: number; source: 'quote' | 'slippage' } {
    if (cfg.useSpread && this.quotes) {
      const q = this.quotes.executable(symbol, side, cfg.quoteMaxAgeMs ?? 0, now);
      if (q !== null && Number.isFinite(q) && q > 0) return { price: q, source: 'quote' };
    }
    return { price: reference, source: 'slippage' };
  }

  /**
   * Entry pricing. Exits never go through here: a position must always be closable, even with
   * no book. When `paper.requireQuote` is on, an entry that cannot be priced off a fresh
   * top-of-book is refused rather than filled at an assumed price.
   */
  private entryPrice(symbol: string, side: 'buy' | 'sell', reference: number, cfg: PaperConfig, now: number): { price: number; quoted: boolean } | { reject: string } {
    const quoted = this.marketPrice(symbol, side, reference, cfg, now);
    if (quoted.source === 'slippage' && cfg.useSpread && cfg.requireQuote) {
      this.priceSource.rejectedNoQuote++;
      return { reject: `no executable ${side === 'buy' ? 'ask' : 'bid'} within ${cfg.quoteMaxAgeMs ?? 0}ms` };
    }
    this.priceSource[quoted.source]++;
    return { price: quoted.price, quoted: quoted.source === 'quote' };
  }
  mark(symbol: string): number | undefined { return this.marks.get(symbol); }
  /** Exchange mark price (liquidation reference). */
  markPrice(symbol: string): number | undefined { return this.markPrices.get(symbol)?.price; }
  pendingEntries(): PendingEntry[] { return [...this.pending.values()]; }
  /** True when a tape print for the symbol arrived within `tapeFallbackMs`. */
  tapeActive(symbol: string, now = Date.now()): boolean {
    const last = this.lastTradeAt.get(symbol);
    return last !== undefined && now - last <= (this.paper.tapeFallbackMs ?? 5000);
  }

  // ---- signals → positions ----

  findOpen(scannerId: string, symbol: string, tf: string): Position | undefined {
    for (const p of this.open.values()) if (p.scannerId === scannerId && p.symbol === symbol && p.tf === tf) return p;
    return undefined;
  }
  private findPending(scannerId: string, symbol: string, tf: string): PendingEntry | undefined {
    for (const p of this.pending.values()) if (p.scannerId === scannerId && p.symbol === symbol && p.tf === tf) return p;
    return undefined;
  }

  /** Paper config with drawdown scaling applied (risk % and leverage bounds multiplied by `mult`). */
  private scaledCfg(mult: number, cfg = this.paper): PaperConfig {
    if (!(mult > 0) || mult >= 1) return cfg;
    const maxLeverage = Math.max(1, cfg.maxLeverage * mult);
    // decision 170: margin sizing reads neither riskPerTradePct nor maxLeverage (5× and 20× sit under it), so the drawdown
    // multiplier scales the margin posted per trade; the leverage tiers and the liquidation rule are unchanged
    const marginPerTrade = cfg.marginPerTrade === undefined ? undefined : cfg.marginPerTrade * mult;
    return { ...cfg, riskPerTradePct: cfg.riskPerTradePct * mult, maxLeverage, minLeverage: Math.min(maxLeverage, Math.max(1, cfg.minLeverage * mult)), marginPerTrade };
  }

  /** Seconds between the close of the signal's bar and `at` (negative while the bar is still forming). */
  static signalAgeSec(ev: Pick<ScanEvent, 'barTime'>, tf: string, at: number): number {
    const tfSec = TF_SECONDS[tf] ?? 0;
    if (!ev.barTime || !tfSec) return 0;
    return (at - (ev.barTime + tfSec * 1000)) / 1000;
  }

  private reclaimRule(cell: {scannerId:string;symbol:string;tf:string}): ReclaimTrial | undefined {
    return this.paper.reclaimTrials?.find(r=>r.enabled && r.scannerId===cell.scannerId && r.symbol===cell.symbol && r.tf===cell.tf);
  }
  private auditReclaim(pe:PendingEntry,event:string,at:number,reason?:string) {
    if(pe.features?.reclaim_trial)recordReclaimEvent(this.db,pe,pe.reclaim?.ruleKey??pe.reclaimRuleKey??JSON.stringify(this.reclaimRule(pe))??'unknown',event,at,reason);
  }
  private reclaimAvailable(cell: {scannerId:string;symbol:string;tf:string}, key?: string): boolean {
    const c=this.cfgRef(), rule=this.reclaimRule(cell), sc=c.scanners[cell.scannerId];
    return this.book===0 && c.execution.mode==='paper' && (this.limitEntryAllowed?.()??true) && !!rule
      && (!key || key===JSON.stringify(rule)) && !!sc?.enabled && !!sc.pairs?.some(p=>p.symbol===cell.symbol&&p.tf===cell.tf);
  }
  private reclaimCount(cell: {scannerId:string;symbol:string;tf:string}, at: number) {
    const key=`paper.reclaim.${cell.scannerId}|${cell.symbol}|${cell.tf}`, day=Math.floor(at/86_400_000);
    const saved=this.db.kvGet<{day:number;entries:number}>(key);
    return {key,day,entries:saved?.day===day?saved.entries:0};
  }
  onEntry(ev: ScanEvent, ctx: EntryContext): EntryDecision {
    if (!this.planEnabled(ctx.executionPlan)) return {action:"rejected",reason:"research plan disabled or wrong book"};
    const auditConfig = configFingerprint(this.cfgRef(),ctx.scannerId,ctx.tf,{source:this.sourceHashFor?.(ctx.scannerId)??null,book:this.book,plan:ctx.executionPlan});
    this.db.run('INSERT OR IGNORE INTO config_fingerprints(fp,parts,first_at) VALUES(?,?,?)',auditConfig.fp,JSON.stringify(auditConfig.parts),Date.now());
    const write = (stage: string, reason: string | null, positionId: number | null = null) => this.db.run(
      'INSERT INTO decision_trace(at,book,signal_id,position_id,scanner_id,symbol,tf,stage,reason,snapshot) VALUES(?,?,?,?,?,?,?,?,?,?)',
      Date.now(),this.book,ctx.signalId,positionId,ctx.scannerId,ctx.symbol,ctx.tf,stage,reason,
      JSON.stringify({version:2,executionPlan:ctx.executionPlan ? {id:ctx.executionPlan.id,revision:ctx.executionPlan.revision,signature:ctx.executionPlan.signature} : null,configFp:auditConfig.fp,signalAt:ctx.at,reference:ctx.refPrice,side:ev.side,atr:ctx.atr??null,
        scannerStop:ev.sl??null,scannerTargets:ev.tp??[],quote:this.quotes?.markState?.(ctx.symbol)??null,
        market:ctx.market,sizeScale:ctx.sizeScale??1,feeRatePct:this.paper.feeRatePct,
        makerFeeRatePct:this.paper.makerFeeRatePct,feeTaxPct:this.paper.feeTaxPct,
        minRiskFeeRatio:this.paper.minRiskFeeRatio,offerConfigured:!!this.paper.scalperOffer?.enabled,
        offerEligibility:offerStatus(this.paper),sourceHash:this.sourceHashFor?.(ctx.scannerId)??null}));
    write('received',null);
    try {
      const decision = this.decideEntry(ev,ctx);
      write(decision.action,decision.reason??null,decision.position?.id??decision.pendingId??null);
      return decision;
    } catch (error) {
      write('error','entry processing failed; inspect service log');
      throw error;
    }
  }

  private decideEntry(ev: ScanEvent, ctx: EntryContext): EntryDecision {
    if (this.book===0 && this.paper.reclaimTrials?.some(r=>!r.enabled&&r.scannerId===ctx.scannerId&&r.symbol===ctx.symbol&&r.tf===ctx.tf)) return {action:'rejected',reason:'reclaim trial disabled'};
    const rule=this.book===0?this.reclaimRule(ctx):undefined;
    if (!rule) return this.executeEntry(ev,ctx);
    const refuse=(reason:string):ReturnType<PaperEngine['onEntry']>=>{recordReclaimEvent(this.db,ctx,JSON.stringify(rule),'refused',ctx.at,reason);return {action:'rejected',reason};};
    if (!this.reclaimAvailable(ctx)) return refuse('reclaim trial requires an allocated paper-only cell');
    if (this.findOpen(ctx.scannerId,ctx.symbol,ctx.tf)) return {action:'ignored',reason:'reclaim trial already holds a position'};
    const previous=this.findPending(ctx.scannerId,ctx.symbol,ctx.tf);
    if (previous) this.cancelPending(previous.id,'reclaim setup replaced by fresh signal');
    if (this.open.size+this.pending.size>=this.paper.maxOpenPositions) return refuse('max open positions');
    const age=PaperEngine.signalAgeSec(ev,ctx.tf,ctx.at);
    if (this.paper.maxSignalAgeSec>0 && age>this.paper.maxSignalAgeSec) return refuse('stale reclaim signal');
    if (!(ctx.atr && ctx.atr>0)) return refuse('reclaim setup needs ATR');
    if (this.reclaimCount(ctx,ctx.at).entries>=rule.maxDailyEntries) return refuse('reclaim trial daily order limit');
    const cfg=this.configFor(ctx);
    const levels=resolveLevels({side:ev.side!,price:ctx.refPrice,sl:ev.sl,tp:ev.tp,atr:ctx.atr},cfg,ctx.market.tickSize);
    if ('error' in levels) return refuse(levels.error);
    if (cfg.skipScriptStops && levels.source!=='atr-fallback') return refuse("the scanner's own stop: reclaim trial uses ATR stops");
    const block=this.entryBlock?.(ctx.symbol,ctx.at)??this.alignmentBlock(ctx,ev.side!,ctx.at)
      ??this.risk?.gate({...ctx,side:ev.side!,price:ctx.refPrice,sl:levels.sl}).reject;
    if (block) return refuse(block);
    const state=createReclaim({side:ev.side!,at:ctx.at,reference:ctx.refPrice,atr:ctx.atr,stop:levels.sl,tick:ctx.market.tickSize},rule);
    const id=this.nextId(), ruleKey=JSON.stringify(rule);
    const pe:PendingEntry={id,...ctx,side:ev.side!,signalPrice:ctx.refPrice,levels,dueAt:ctx.at,mlProb:ctx.mlProb??null,leverageMult:1,
      features:{...ctx.features,reclaim_trial:1},sizeScale:Math.min(ctx.sizeScale??1,rule.sizeScale),reclaim:{state,event:ev,context:ctx,ruleKey}};
    this.pending.set(id,pe);
    this.auditReclaim(pe,'setup',ctx.at);
    this.db.run("UPDATE positions SET scanner_id=?,scanner_name=?,symbol=?,tf=?,side=?,entry_price=?,entry_at=?,signal_id=?,fills=? WHERE id=?",ctx.scannerId,ctx.scannerName,ctx.symbol,ctx.tf,ev.side,ctx.refPrice,ctx.at,ctx.signalId,JSON.stringify({reclaimSetup:pe}),id);
    return {action:'pending',reason:'reclaim trial: waiting for completed 1m pullback and reclaim',pendingId:id};
  }
  /** Only closed live minutes may advance a setup; tape/partial candles only fill its later order. */
  onClosedMinute(symbol: string, bar: Bar, at=Date.now(), historical=false): void {
    if (historical || at<bar.time+60_000 || at>bar.time+90_000) return;
    for (const pe of [...this.pending.values()]) {
      if (pe.symbol!==symbol || !pe.reclaim) continue;
      if (!this.reclaimAvailable(pe,pe.reclaim.ruleKey)) {this.cancelPending(pe.id,'reclaim trial disabled or changed');continue;}
      const r=pe.reclaim, before=r.state.phase, step=advanceReclaim(r.state,bar,at,this.paper.limitFill==='through');
      if(before==='pullback'&&r.state.phase==='reclaim')this.auditReclaim(pe,'pullback',at);
      if (step.kind==='cancelled') {this.cancelPending(pe.id,`reclaim ${step.reason}`);continue;}
      if (step.kind!=='placed') continue;
      this.auditReclaim(pe,'confirmed',at);
      const rule=this.reclaimRule(pe)!, count=this.reclaimCount(pe,at);
      if (count.entries>=rule.maxDailyEntries) {this.cancelPending(pe.id,'reclaim trial daily order limit');continue;}
      // The unfilled setup is replaced synchronously by an ordinary audited limit.
      this.pending.delete(pe.id);this.db.run('DELETE FROM positions WHERE id=?',pe.id);
      const d=this.executeEntry(r.event,{...r.context,at,features:pe.features,sizeScale:pe.sizeScale},
        {price:r.state.limit!,expiresAt:at+rule.orderMinutes*60_000,ruleKey:r.ruleKey});
      if (d.action==='pending') this.db.kvSet(count.key,{day:count.day,entries:count.entries+1});
      this.auditReclaim({...pe,id:d.pendingId??pe.id},d.action==='pending'?'ordered':'refused',at,d.reason);
      if (pe.signalId) this.db.updateSignalAction(pe.signalId,`${d.action}:${d.reason??''}`,null);
    }
  }
  private executeEntry(ev: ScanEvent, ctx: EntryContext, planned?: PlannedReclaim): EntryDecision {
    // the market's and the scanner's own rules, so a stop width they ask for is used at entry and
    // then carried on the position for the rest of the trade (decision 43)
    const cfg = this.configFor(ctx);
    const alignment=this.alignmentBlock(ctx,ev.side!,ctx.at);
    if(alignment)return {action:'rejected',reason:alignment};
    if (ctx.sizeScale !== undefined && !(Number.isFinite(ctx.sizeScale) && ctx.sizeScale > 0 && ctx.sizeScale <= 1)) return {action:'rejected',reason:'invalid entry size scale'};
    const exchangeBlock = this.entryBlock?.(ctx.symbol, ctx.at);
    if (exchangeBlock) return { action: 'rejected', reason: exchangeBlock };
    // A signal acted on long after its bar closed could not have been taken at these prices
    // (restarts and deep queues used to replay bar-old signals straight into the book).
    const maxAge = cfg.maxSignalAgeSec ?? 0;
    if (maxAge > 0 && !planned) {
      const age = PaperEngine.signalAgeSec(ev, ctx.tf, ctx.at);
      if (age > maxAge) return { action: 'rejected', reason: `stale signal: bar closed ${age.toFixed(0)}s ago (max ${maxAge}s)` };
    }
    const existing = this.findOpen(ctx.scannerId, ctx.symbol, ctx.tf);
    if (planned && existing) return {action:'ignored',reason:'reclaim trial already holds a position'};
    // Reversal policy (decision 77): the replacement must pass every admission check — price, levels, fees,
    // risk gate, size, exposure — with the existing position counted as gone; only then is the existing
    // position closed. A replacement that cannot be admitted leaves the position as it was.
    let replacing: Position | undefined;
    if (existing) {
      if (existing.side === ev.side) return { action: 'ignored', reason: 'already in position' };
      if (!cfg.allowReversal) return { action: 'ignored', reason: 'opposite signal while in position (reversal disabled)' };
      const markNow = this.marks.get(existing.symbol) ?? ctx.refPrice;
      if (!reversalAllowed(existing, markNow, cfg)) {
        return { action: 'ignored', reason: `reversal held: position at ${openR(existing, markNow).toFixed(2)}R, below the ${cfg.reversalMinR}R needed to bank it` };
      }
      replacing = existing;
    }
    const refused = (reason: string): EntryDecision => ({ action: 'rejected', reason: replacing ? `reversal refused, position kept: ${reason}` : reason });
    let closed: Position | undefined;
    if (this.findPending(ctx.scannerId, ctx.symbol, ctx.tf)) return { action: 'ignored', reason: 'entry already pending' };
    if (this.open.size + this.pending.size - (replacing ? 1 : 0) >= cfg.maxOpenPositions) return refused(`max open positions (${cfg.maxOpenPositions})`);
    // A market entry pays the spread: buy at the ask, sell at the bid when a fresh quote exists.
    // The script's own price is only a reference and is often minutes old by the time we act.
    const le = planned?{enabled:true,tfs:[ctx.tf],books:['account'] as Array<'account'|'shadow'>,atr:0,bars:(planned.expiresAt-ctx.at)/((TF_SECONDS[ctx.tf]??1)*1000),atrByTf:undefined}:cfg.limitEntry, tfMs = (TF_SECONDS[ctx.tf] ?? 0) * 1000;
    const willRestLimit = !!(le?.enabled && !replacing && le.tfs.includes(ctx.tf) && le.books.includes(this.book === 0 ? 'account' : 'shadow') && (ctx.atr ?? 0) > 0 && tfMs > 0 && (this.limitEntryAllowed?.() ?? true));
    const reference = ev.price && ev.price > 0 ? ev.price : ctx.refPrice;
    const quoted = this.entryPrice(ctx.symbol, ev.side === 'long' ? 'buy' : 'sell', reference, cfg, ctx.at);
    if ('reject' in quoted) return refused(`unpriceable: ${quoted.reject}`);
    // Admit a resting order at its intended price, not at a market price it will never pay.
    const limitOffset = le?.atrByTf?.[ctx.tf] ?? le?.atr ?? 0;
    let limitPrice: number | undefined;
    if (willRestLimit) {
      const tick = ctx.market.tickSize;
      if (!(tick > 0)) return refused('maker entry requires a positive tick size');
      const raw = planned?.price ?? (ev.side === 'long' ? reference - limitOffset * ctx.atr! : reference + limitOffset * ctx.atr!);
      // A stale signal reference can cross the current quote. Keep the order passive.
      const passive = quoted.quoted ? (ev.side === 'long' ? Math.min(raw, quoted.price - tick) : Math.max(raw, quoted.price + tick)) : raw;
      limitPrice = Number(((ev.side === 'long' ? Math.floor(passive / tick + 1e-9) : Math.ceil(passive / tick - 1e-9)) * tick).toPrecision(14));
      if (!(limitPrice > 0 && Number.isFinite(limitPrice))) return refused('invalid maker entry price');
    }
    let price = limitPrice ?? quoted.price;
    const entryContext: FillContext = { ref: reference, source: quoted.quoted ? 'quote' : 'slippage' };
    const levels = resolveLevels({ side: ev.side!, price, sl: ev.sl, tp: ev.tp, atr: ctx.atr }, cfg, ctx.market.tickSize);
    if ('error' in levels) return refused(levels.error);
    // decision 146: a stop the scanner placed itself (source script or mixed) loses in both books and both halves of
    // decision 145's sample; the account takes only entries on the engine's own ATR stop. The shadow book keeps them.
    if ((this.book === 0 || ctx.executionPlan?.requireAtrStop) && cfg.skipScriptStops && levels.source !== 'atr-fallback') return refused("the scanner's own stop: the account takes only the ATR stop (decision 146)");
    const feeErr = checkRiskVsFees(price, levels.sl, cfg, ctx.symbol, this.spreadPct(ctx.symbol, cfg, ctx.at), { maker: willRestLimit });
    if (feeErr) return refused(feeErr);
    // portfolio risk layer: kill switches, position caps, cooldowns, regime filter, drawdown scaling
    let leverageMult = 1;
    if (this.risk) {
      const g = this.risk.gate({ scannerId: ctx.scannerId, symbol: ctx.symbol, tf: ctx.tf, side: ev.side!, price, sl: levels.sl, atr: ctx.atr, at: ctx.at, replacing: replacing?.id });
      if (g.reject) return refused(`risk ${g.reject}`);
      leverageMult = g.leverageMult;
    }
    let size = this.size(price, levels.sl, ctx.market, ev.score ?? ctx.scoreOverride, leverageMult, replacing?.id, { scannerId: ctx.scannerId, symbol: ctx.symbol, tf: ctx.tf, at: ctx.at, executionPlan:ctx.executionPlan }, { maker: willRestLimit, quoted: !willRestLimit && quoted.quoted }, ctx.sizeScale);
    if (size.qty < 1) return refused(size.reason ?? 'size');
    if(!willRestLimit&&this.cfgRef().execution.mode==='paper'&&(this.limitEntryAllowed?.()??true)&&(this.book===0||!!ctx.executionPlan)&&this.marketDepthPrice?.(ctx.symbol,ev.side!,size.qty)!==undefined){
      const plan=depthPlan(size,price,ev.side!,n=>this.marketDepthPrice!(ctx.symbol,ev.side!,n)!,p=>this.size(p,levels.sl,ctx.market,ev.score??ctx.scoreOverride,leverageMult,replacing?.id,{scannerId:ctx.scannerId,symbol:ctx.symbol,tf:ctx.tf,at:ctx.at,executionPlan:ctx.executionPlan},{quoted:true},ctx.sizeScale));
      if('reject'in plan)return refused(plan.reject);
      price=plan.price;size=plan.size;quoted.quoted=true;entryContext.source='depth';
      if(levels.tp.some(tp=>ev.side==='long'?price>=tp:price<=tp))return refused('depth price moved past target');
      const valid=resolveLevels({side:ev.side!,price,sl:levels.sl,tp:levels.tp},cfg,ctx.market.tickSize);
      if('error'in valid)return refused(`depth price moved past levels (${valid.error})`);
      const g=this.risk?.gate({scannerId:ctx.scannerId,symbol:ctx.symbol,tf:ctx.tf,side:ev.side!,price,sl:levels.sl,atr:ctx.atr,at:ctx.at,replacing:replacing?.id});
      if(g?.reject)return refused(`risk ${g.reject}`);
    }
    const depthBlock=this.depthRefusal(ctx.symbol,size.qty,ctx.market.contractValue,price,levels.sl,cfg,ctx.at,willRestLimit,{...ctx,score:ev.score??ctx.scoreOverride});
    if(depthBlock)return refused(depthBlock);
    const fundingBlock = this.fundingEntryBlock?.(ctx.symbol, ev.side!, ctx.tf, size.qty * ctx.market.contractValue * price, size.riskAmount, ctx.at);
    if (fundingBlock) return refused(fundingBlock);
    if (this.risk) {
      const x = this.risk.exposureCheck({ symbol: ctx.symbol, side: ev.side!, tf: ctx.tf, notional: size.qty * ctx.market.contractValue * price, replacing: replacing?.id });
      if (x) return refused(`risk ${x}`);
    }
    const deferReversal = Boolean(replacing) && (this.tapeMode || (cfg.latencyMs ?? 0) > 0);
    if (replacing && !deferReversal) {
      const ref = ev.price && ev.price > 0 ? ev.price : ctx.refPrice;
      const exitQuote = this.marketPrice(replacing.symbol, replacing.side === 'long' ? 'sell' : 'buy', ref, cfg, ctx.at);
      if (!this.applyFills(replacing, [fillExit(replacing, exitQuote.price, replacing.qtyOpen, 'reversal', ctx.at, cfg, exitQuote.source === 'quote' ? 'quoted' : true)], { ref, source: exitQuote.source })) return refused('the position to be replaced could not be closed (write failed)');
      closed = replacing;
    }
    // decision 185: on the timeframes named, the entry rests as a maker limit back from the signal price
    if (willRestLimit && le) {
      const off = limitOffset;
      const id = this.nextId();
      const pe: PendingEntry = { id, executionPlan:ctx.executionPlan, scannerId: ctx.scannerId, scannerName: ctx.scannerName, symbol: ctx.symbol, tf: ctx.tf, side: ev.side!, signalPrice: reference, levels, market: ctx.market, at: ctx.at, dueAt: ctx.at, signalId: ctx.signalId, features: ctx.features, mlProb: ctx.mlProb ?? null, score: ev.score ?? ctx.scoreOverride, leverageMult, sizeScale: ctx.sizeScale,
        reclaimRuleKey:planned?.ruleKey,limit: { price: limitPrice!, expiresAt: planned?.expiresAt ?? ctx.at + le.bars * tfMs, atr: ctx.atr!, sl: ev.sl, tp: ev.tp, bars: le.bars } };
      this.pending.set(id, pe);
      this.emit('pending', { type: 'placed', entry: pe });   // decision 190: the tape audit registers the order at once
      this.db.run("UPDATE positions SET scanner_id=?, scanner_name=?, symbol=?, tf=?, side=?, entry_price=?, entry_at=?, signal_id=?, fills=? WHERE id=?", pe.scannerId, pe.scannerName, pe.symbol, pe.tf, pe.side, limitPrice, pe.at, pe.signalId, JSON.stringify({ limitEntry: pe }), id);
      this.logInfo(`${this.book ? 'INCUBATOR ' : ''}LIMIT ${pe.side.toUpperCase()} ${pe.symbol} ${pe.tf} @ ${limitPrice} (${off} ATR back from ${reference}), rests ${le.bars} bars [${ctx.scannerId}]`);
      return { action: 'pending', reason: planned ? `reclaim trial: maker limit at ${limitPrice}, expires in ${Math.round((planned.expiresAt-ctx.at)/60_000)} minutes` : `resting limit at ${limitPrice}, ${off} ATR back, for ${le.bars} ${ctx.tf} bars`, pendingId: id, closed };
    }
    if (this.tapeMode || (cfg.latencyMs ?? 0) > 0) {
      // latency model (decision 75: every mode): the order reaches the book latencyMs after the signal and fills at the
      // first price after that — a tape print, or in candles mode the next 1m candle update, or the mark once the feed is quiet
      const id = this.nextId();
      const pe: PendingEntry = { id, executionPlan:ctx.executionPlan, scannerId: ctx.scannerId, scannerName: ctx.scannerName, symbol: ctx.symbol, tf: ctx.tf, side: ev.side!, signalPrice: price, levels, market: ctx.market, at: ctx.at, dueAt: ctx.at + (cfg.latencyMs ?? 0), signalId: ctx.signalId, features: ctx.features, mlProb: ctx.mlProb ?? null, score: ev.score ?? ctx.scoreOverride, leverageMult, sizeScale: ctx.sizeScale,
        ...(deferReversal ? { replacingId: replacing!.id } : {}) };
      this.pending.set(id, pe);
      this.db.run("UPDATE positions SET scanner_id=?, scanner_name=?, symbol=?, tf=?, side=?, entry_price=?, entry_at=?, signal_id=?, fills=? WHERE id=?", pe.scannerId, pe.scannerName, pe.symbol, pe.tf, pe.side, price, pe.at, pe.signalId, JSON.stringify({ pending: { dueAt: pe.dueAt, levels } }), id);
      this.logInfo(`PENDING ${pe.side.toUpperCase()} ${pe.symbol} @~${price.toFixed(2)} fills at first price after +${cfg.latencyMs ?? 0}ms [${ctx.scannerId}]`);
      return { action: 'pending', reason: this.tapeMode ? 'awaiting tape fill' : 'awaiting fill after the latency window', pendingId: id, closed };
    }
    const pos = this.openAt(this.nextId(), { executionPlan:ctx.executionPlan, scannerId: ctx.scannerId, scannerName: ctx.scannerName, symbol: ctx.symbol, tf: ctx.tf, side: ev.side!, qty: size.qty, contractValue: ctx.market.contractValue, maintenanceMarginPct: ctx.market.maintenanceMarginPct, entryPrice: price, at: ctx.at, sl: levels.sl, tp: levels.tp, riskAmount: size.riskAmount, levelsSource: levels.source, signalId: ctx.signalId, leverage: size.leverage, marginLeverage: size.marginLeverage, features: ctx.features, mlProb: ctx.mlProb ?? null, quoted: quoted.quoted, scannerTag: ctx.scannerId }, cfg, entryContext);
    return { action: closed ? 'reversed' : 'opened', position: pos, closed };
  }

  /**
   * Decision 144: the leverage the cell's shadow record asks for under margin sizing. The record is the scanner's last
   * closed shadow trades on the same market and timeframe, net of fees, closed before `at`.
   */
  cellLeverage(cell: { scannerId: string; symbol: string; tf: string; at: number }, cfg: PaperConfig): { leverage: number; avgR: number | null; n: number } {
    const m = cfg.marginLeverage ?? { base: 5, strong: 20, weak: 5, strongAboveR: 0.05, weakBelowR: -0.05, minTrades: 5, lookback: 30 };
    const rows = this.db.all<{ r: number }>(
      "SELECT (realized_pnl - fees) / risk_amount r FROM positions WHERE bt=2 AND status='closed' AND scanner_id=? AND symbol=? AND tf=? AND exit_at<=? AND risk_amount>0 AND NOT EXISTS (SELECT 1 FROM evidence_flags f WHERE f.position_id=positions.id AND f.entry_at=positions.entry_at AND f.status='quarantined') ORDER BY exit_at DESC LIMIT ?",
      cell.scannerId, cell.symbol, cell.tf, cell.at, m.lookback);
    return recordLeverage(rows.map(x => x.r), m);
  }

  /** Deployable single-entry size for shadow liquidity checks, independent of occupied account slots. */
  previewDepthQuantity(req:{symbol:string;tf:string;scannerId:string;price:number;sl:number;market:MarketInfo;score?:number;at:number;maker?:boolean}):number {
    const cfg=this.scaledCfg(this.risk?.leverageMult?.()??1);
    const equity=this.equity();
    const wantedLeverage=cfg.sizingMode==='margin'?this.cellLeverage(req,cfg).leverage:undefined;
    return sizeContracts(req.price,req.sl,{equity,availableMargin:equity,contractValue:req.market.contractValue,tickSize:req.market.tickSize,maintenanceMarginPct:req.market.maintenanceMarginPct,maxLeverage:req.market.maxLeverage,cfg,wantedLeverage,entryExecution:{maker:req.maker}},0,req.score).qty;
  }

  private size(price: number, sl: number, market: MarketInfo, score: number | undefined, leverageMult: number, replacing?: number, cell?: { scannerId: string; symbol: string; tf: string; at: number; executionPlan?:ExecutionPlanSnapshot }, entryExecution?: EntryExecution, sizeScale = 1) {
    const cfg = this.scaledCfg(leverageMult,cell?.executionPlan?.paper ?? this.paper);
    if(cell?.executionPlan) return sizeContracts(price,sl,{equity:cell.executionPlan.referenceEquity,availableMargin:cell.executionPlan.referenceEquity,contractValue:market.contractValue,tickSize:market.tickSize,maintenanceMarginPct:market.maintenanceMarginPct,maxLeverage:market.maxLeverage,cfg,wantedLeverage:cfg.marginLeverage?.base,entryExecution},0,score);
    const wantedLeverage = cfg.sizingMode === 'margin' && cell ? this.cellLeverage(cell, cfg).leverage : undefined;
    const others = [...this.open.values()].filter(p => p.id !== replacing);
    const openNotional = others.reduce((a, p) => a + notionalOf(p), 0);
    const reservedMargin = others.reduce((a, p) => a + notionalOf(p) / (p.marginLeverage || p.leverage || cfg.maxLeverage), 0);
    const wallet = this.book === 0 ? this.initialEquity + this.realizedPnl() : this.initialEquity;
    const base = sizeContracts(price, sl, { equity: this.equity(), availableMargin: wallet - reservedMargin, contractValue: market.contractValue, tickSize: market.tickSize, maintenanceMarginPct: market.maintenanceMarginPct, maxLeverage: market.maxLeverage, cfg, wantedLeverage, entryExecution }, openNotional, score);
    if(sizeScale >= 1 || base.qty < 1)return base;
    // Scale quantity after the normal risk/lot calculation; leverage tiers and stop clearance stay intact.
    const qty=Math.floor(base.qty*sizeScale), fraction=qty/base.qty;
    return {...base,qty,riskAmount:base.riskAmount*fraction,leverage:base.leverage*fraction,...(qty<1?{reason:'copy pilot quantity below one contract'}:{})};
  }

  private openAt(id: number, p: Omit<Parameters<typeof openPosition>[0], 'id' | 'cfg' | 'bt' | 'lastPriceBar'> & { scannerTag: string; executionPlan?: ExecutionPlanSnapshot }, cfg: PaperConfig, context: FillContext): Position {
    // `quoted` entries already crossed the real spread; openPosition adds depth impact only
    const pos = openPosition({ ...p, id, cfg, bt: false, lastPriceBar: this.priceBars.get(p.symbol) });
    pos.executionPlan = p.executionPlan;
    try {
      const f = configFingerprint(this.cfgRef(), pos.scannerId, pos.tf, { source: this.sourceHashFor?.(pos.scannerId) ?? null, book: this.book, plan:p.executionPlan });
      pos.configFp = f.fp;
      // decision 190: the full settings behind a fingerprint, kept once, so a hash can always be explained
      if (!this.fpSeen.has(f.fp)) { this.fpSeen.add(f.fp); this.db.run('INSERT OR IGNORE INTO config_fingerprints(fp, parts, first_at) VALUES (?,?,?)', f.fp, JSON.stringify(f.parts), Date.now()); }
    } catch { /* a trade without a fingerprint is still a trade */ }
    // the position, its entry fill and the signal's outcome commit together; events go out only after the commit
    // (decision 77: a crash between the writes used to leave a position without its order, or a signal pointing nowhere)
    this.db.transaction(() => {
      this.persistFill(pos, pos.fills[0], context);
      this.persist(pos);
      recordFillBudget(this.db,pos,this.book,cfg);
      recordEntryExecution(this.db, pos, this.book, cfg, context.source, this.quotes?.markState?.(pos.symbol));
      if(pos.features?.reclaim_trial)recordReclaimEvent(this.db,pos,JSON.stringify(this.reclaimRule(pos)),'filled',pos.entryAt);
      if (pos.signalId) this.db.updateSignalAction(pos.signalId, 'opened', pos.id);
    });
    this.open.set(id, pos);
    this.emit('order', orderOf(pos, pos.fills[0]));   // the fill precedes the open position (executor: entry before bracket)
    this.emit('position', { type: 'opened', position: pos });
    this.recordEquity(true);
    this.logInfo(`${this.book ? 'INCUBATOR ' : ''}OPEN ${pos.side.toUpperCase()} ${pos.symbol} x${pos.qty} @ ${pos.entryPrice.toFixed(2)} ${pos.leverage.toFixed(1)}x sl ${pos.sl} tp ${pos.tp.join('/')} liq ${pos.liqPrice?.toFixed(1) ?? '-'} [${p.scannerTag}]`);
    return pos;
  }

  /** Decision 185: whether prices between `low` and `high` filled a resting limit (through it, or touching it, per `limitFill`). */
  private limitTouched(pe: PendingEntry, low: number, high: number): boolean {
    const L = pe.limit!.price, through = (this.paper.limitFill ?? 'through') === 'through';
    return pe.side === 'long' ? (through ? low < L : low <= L) : (through ? high > L : high >= L);
  }

  /** Decision 185: fill a resting limit at its own price as a maker; levels from the fill, every gate asked again. */
  private fillLimit(pe: PendingEntry, at: number, eventAt = at): Position | null {
    this.pending.delete(pe.id);
    // the scanner's and the market's own stop and exit rules, as at entry (decision 190: the global ones were used)
    const cfg = this.configFor(pe), L = pe.limit!;
    const cancel = (reason: string) => {
      this.auditReclaim(pe,'cancelled',at,reason);
      this.db.run('DELETE FROM positions WHERE id=?', pe.id);
      if (pe.signalId) this.db.updateSignalAction(pe.signalId, `rejected:${reason}`, null);
      this.logInfo(`LIMIT ${pe.symbol} cancelled: ${reason} [${pe.scannerId}]`);
      this.emit('pending', { type: 'cancelled', id: pe.id, reason });
      return null;
    };
    if (pe.features?.copy_pilot && (!this.cfgRef().incubator.mirror?.enabled || !this.cfgRef().incubator.mirror?.pilot || this.cfgRef().execution.mode !== 'paper')) return cancel('copy pilot disabled');
    if (pe.features?.reclaim_trial && !this.reclaimAvailable(pe,pe.reclaimRuleKey)) return cancel('reclaim trial disabled or changed');
    if(!this.planEnabled(pe.executionPlan))return cancel("research plan disabled");
    const alignment=this.alignmentBlock(pe,pe.side,at);
    if(alignment)return cancel(alignment);
    const exchangeBlock = this.entryBlock?.(pe.symbol, at);
    if (exchangeBlock) return cancel(exchangeBlock);
    // decision 190: expiry is part of the fill, judged on the exchange's event time; a message that arrives more than
    // LIMIT_LATE_MS after its event is too late to act on, whatever the scheduler did in between
    if (eventAt >= L.expiresAt) return cancel(`no fill: the limit lapsed at ${new Date(L.expiresAt).toISOString()} before price came back to ${L.price}`);
    if (at - eventAt > LIMIT_LATE_MS) return cancel(`no fill: the price update arrived ${Math.round((at - eventAt) / 1000)}s after its event`);
    const levels = resolveLevels({ side: pe.side, price: L.price, sl: L.sl, tp: L.tp, atr: L.atr }, cfg, pe.market.tickSize);
    if ('error' in levels) return cancel(`limit filled past its levels (${levels.error})`);
    // a maker entry crosses no spread; the exit still pays it, as checkRiskVsFees counts
    const feeErr = checkRiskVsFees(L.price, levels.sl, cfg, pe.symbol, this.spreadPct(pe.symbol, cfg, at), { maker: true });
    if (feeErr) return cancel(feeErr);
    if (this.open.size >= cfg.maxOpenPositions) return cancel(`max open positions (${cfg.maxOpenPositions})`);
    let leverageMult = pe.leverageMult;
    if (this.risk) {
      const g = this.risk.gate({ scannerId: pe.scannerId, symbol: pe.symbol, tf: pe.tf, side: pe.side, price: L.price, sl: levels.sl, at });
      if (g.reject) return cancel(`risk ${g.reject}`);
      leverageMult = g.leverageMult;
    }
    const size = this.size(L.price, levels.sl, pe.market, pe.score, leverageMult, undefined, { scannerId: pe.scannerId, symbol: pe.symbol, tf: pe.tf, at, executionPlan:pe.executionPlan }, { maker: true }, pe.sizeScale);
    if (size.qty < 1) return cancel(size.reason ?? 'size');
    const depthBlock=this.depthRefusal(pe.symbol,size.qty,pe.market.contractValue,L.price,levels.sl,cfg,at,true,pe);
    if(depthBlock)return cancel(depthBlock);
    const fundingBlock = this.fundingEntryBlock?.(pe.symbol, pe.side, pe.tf, size.qty * pe.market.contractValue * L.price, size.riskAmount, at);
    if (fundingBlock) return cancel(fundingBlock);
    if (this.risk) {
      const x = this.risk.exposureCheck({ symbol: pe.symbol, side: pe.side, tf: pe.tf, notional: size.qty * pe.market.contractValue * L.price });
      if (x) return cancel(`risk ${x}`);
    }
    return this.openAt(pe.id, { executionPlan:pe.executionPlan, scannerId: pe.scannerId, maker: true, scannerName: pe.scannerName, symbol: pe.symbol, tf: pe.tf, side: pe.side, qty: size.qty, contractValue: pe.market.contractValue, maintenanceMarginPct: pe.market.maintenanceMarginPct, entryPrice: L.price, at, sl: levels.sl, tp: levels.tp, riskAmount: size.riskAmount, levelsSource: levels.source, signalId: pe.signalId, leverage: size.leverage, marginLeverage: size.marginLeverage, features: pe.features, mlProb: pe.mlProb, scannerTag: `${pe.scannerId} limit +${Math.round((at - pe.at) / 60_000)}m` }, cfg, { ref: L.price, source: 'quote' });
  }

  /** Fill a pending entry at `price` (first print after the latency window, or the 1m close when the tape is silent). */
  private fillPending(pe: PendingEntry, priceIn: number, at: number, source: 'tape' | 'candle', receivedAt = Date.now()): Position | null {
    let price = priceIn;
    this.pending.delete(pe.id);
    const cfg = this.configFor(pe);
    const cancel = (reason: string) => {
      this.db.run('DELETE FROM positions WHERE id=?', pe.id);
      if (pe.signalId) this.db.updateSignalAction(pe.signalId, `rejected:${reason}`, null);
      this.logInfo(`PENDING ${pe.symbol} cancelled: ${reason} [${pe.scannerId}]`);
      this.emit('pending', { type: 'cancelled', id: pe.id, reason });
      return null;
    };
    if(!this.planEnabled(pe.executionPlan))return cancel("research plan disabled");
    const alignment=this.alignmentBlock(pe,pe.side,receivedAt);
    if(alignment)return cancel(alignment);
    if (pe.features?.copy_pilot && (!this.cfgRef().incubator.mirror?.enabled || !this.cfgRef().incubator.mirror?.pilot || this.cfgRef().execution.mode !== 'paper')) return cancel('copy pilot disabled');
    const exchangeBlock = this.entryBlock?.(pe.symbol, receivedAt);
    if (exchangeBlock) return cancel(exchangeBlock);
    // expiry belongs in the fill path, not only in housekeeping: a print can arrive past the
    // deadline before the next housekeeping tick and would otherwise still be filled
    if (receivedAt > pe.dueAt + PENDING_EXPIRY_MS) return cancel(`no fill within ${PENDING_EXPIRY_MS / 1000}s of the latency window`);
    // A tape print wakes the order; it is not an executable market quote. Every deferred market
    // entry rechecks the current book and requireQuote policy, just like an immediate entry.
    let quoted = false;
    const context: FillContext = { ref: priceIn, source: 'slippage' };
    {
      const q = this.entryPrice(pe.symbol, pe.side === 'long' ? 'buy' : 'sell', price, cfg, receivedAt);
      if ('reject' in q) return cancel(`unpriceable: ${q.reject}`);
      context.source = q.quoted ? 'quote' : 'slippage';
      price = q.price; quoted = q.quoted;
    }
    // the signal's levels are absolute; the fill price must still sit on the right side of them
    const levels = resolveLevels({ side: pe.side, price, sl: pe.levels.sl, tp: pe.levels.tp }, cfg, pe.market.tickSize);
    if ('error' in levels) return cancel(`price moved past levels before fill (${levels.error})`);
    const feeErr = checkRiskVsFees(price, levels.sl, cfg, pe.symbol, this.spreadPct(pe.symbol, cfg, receivedAt));
    if (feeErr) return cancel(feeErr);
    // decision 186: a reversal's held position is still open; it is closed only if this entry fills
    const held = pe.replacingId !== undefined ? this.open.get(pe.replacingId) : undefined;
    if (this.open.size - (held ? 1 : 0) >= cfg.maxOpenPositions) return cancel(`max open positions (${cfg.maxOpenPositions})`);
    // the portfolio risk layer was consulted when the entry was queued; the book can have
    // halted, hit a cap or changed the drawdown scaling since, so ask it again at fill time
    let leverageMult = pe.leverageMult;
    if (this.risk) {
      const g = this.risk.gate({ scannerId: pe.scannerId, symbol: pe.symbol, tf: pe.tf, side: pe.side, price, sl: levels.sl, at: receivedAt, replacing: held?.id });
      if (g.reject) return cancel(`risk ${g.reject}`);
      leverageMult = g.leverageMult;
    }
    let size = this.size(price, levels.sl, pe.market, pe.score, leverageMult, held?.id, { scannerId: pe.scannerId, symbol: pe.symbol, tf: pe.tf, at: receivedAt, executionPlan:pe.executionPlan }, { quoted }, pe.sizeScale);
    if (size.qty < 1) return cancel(size.reason ?? 'size');
    if(this.cfgRef().execution.mode==='paper'&&(this.limitEntryAllowed?.()??true)&&(this.book===0||!!pe.executionPlan)&&this.marketDepthPrice?.(pe.symbol,pe.side,size.qty)!==undefined){
      const plan=depthPlan(size,price,pe.side,n=>this.marketDepthPrice!(pe.symbol,pe.side,n)!,p=>this.size(p,levels.sl,pe.market,pe.score,leverageMult,held?.id,{scannerId:pe.scannerId,symbol:pe.symbol,tf:pe.tf,at:receivedAt,executionPlan:pe.executionPlan},{quoted:true},pe.sizeScale));
      if('reject'in plan)return cancel(plan.reject);
      price=plan.price;size=plan.size;quoted=true;context.source='depth';
      if(levels.tp.some(tp=>pe.side==='long'?price>=tp:price<=tp))return cancel('depth price moved past target');
      const valid=resolveLevels({side:pe.side,price,sl:levels.sl,tp:levels.tp},cfg,pe.market.tickSize);
      if('error'in valid)return cancel(`depth price moved past levels (${valid.error})`);
      const g=this.risk?.gate({scannerId:pe.scannerId,symbol:pe.symbol,tf:pe.tf,side:pe.side,price,sl:levels.sl,at:receivedAt,replacing:held?.id});
      if(g?.reject)return cancel(`risk ${g.reject}`);
    }
    const depthBlock=this.depthRefusal(pe.symbol,size.qty,pe.market.contractValue,price,levels.sl,cfg,receivedAt,false,pe);
    if(depthBlock)return cancel(depthBlock);
    const fundingBlock = this.fundingEntryBlock?.(pe.symbol, pe.side, pe.tf, size.qty * pe.market.contractValue * price, size.riskAmount, receivedAt);
    if (fundingBlock) return cancel(fundingBlock);
    if (this.risk) {
      const x = this.risk.exposureCheck({ symbol: pe.symbol, side: pe.side, tf: pe.tf, notional: size.qty * pe.market.contractValue * price, replacing: held?.id });
      if (x) return cancel(`risk ${x}`);
    }
    if (held && held.status === 'open') {
      const exitQuote = this.marketPrice(held.symbol, held.side === 'long' ? 'sell' : 'buy', priceIn, cfg, receivedAt);
      if (!this.applyFills(held, [fillExit(held, exitQuote.price, held.qtyOpen, 'reversal', receivedAt, cfg, exitQuote.source === 'quote' ? 'quoted' : true)], { ref: priceIn, source: exitQuote.source })) return cancel('reversal: the held position could not be closed');
    }
    const pos = this.openAt(pe.id, { executionPlan:pe.executionPlan, scannerId: pe.scannerId, quoted, scannerName: pe.scannerName, symbol: pe.symbol, tf: pe.tf, side: pe.side, qty: size.qty, contractValue: pe.market.contractValue, maintenanceMarginPct: pe.market.maintenanceMarginPct, entryPrice: price, at: receivedAt, sl: levels.sl, tp: levels.tp, riskAmount: size.riskAmount, levelsSource: pe.levels.source, signalId: pe.signalId, leverage: size.leverage, marginLeverage: size.marginLeverage, features: pe.features, mlProb: pe.mlProb, scannerTag: `${pe.scannerId} ${source} +${at - pe.at}ms` }, cfg, context);
    return pos;
  }

  /** Cancel a pending entry (manual or expiry). */
  cancelPending(id: number, reason = 'cancelled'): boolean {
    const pe = this.pending.get(id);
    if (!pe) return false;
    this.auditReclaim(pe,'cancelled',Date.now(),reason);
    this.pending.delete(id);
    this.db.run('DELETE FROM positions WHERE id=?', id);
    if (pe.signalId) this.db.updateSignalAction(pe.signalId, `rejected:${reason}`, null);
    this.emit('pending', { type: 'cancelled', id, reason });
    return true;
  }

  /** Expire pending entries that neither the tape nor a candle could fill within a minute past their due time. */
  housekeeping(now = Date.now()): void {
    for (const pe of [...this.pending.values()]) {
      if (pe.features?.reclaim_trial && !this.reclaimAvailable(pe,pe.reclaim?.ruleKey??pe.reclaimRuleKey)) {this.cancelPending(pe.id,'reclaim trial disabled or changed');continue;}
      if (pe.reclaim) {
        if (now>=pe.reclaim.state.at+pe.reclaim.state.options.setupMinutes*60_000+30_000) this.cancelPending(pe.id,'reclaim setup expired');
        continue;
      }
      const exchangeBlock = this.entryBlock?.(pe.symbol, now);
      if (exchangeBlock) { this.cancelPending(pe.id, exchangeBlock); continue; }
      if (pe.limit) { if (now > pe.limit.expiresAt) this.cancelPending(pe.id, `no fill: price did not come back to ${pe.limit.price} within ${pe.limit.bars} ${pe.tf} bars`); continue; }
      if (now > pe.dueAt + PENDING_EXPIRY_MS) { this.cancelPending(pe.id, `no fill within ${PENDING_EXPIRY_MS / 1000}s of the latency window`); continue; }
      // candles mode: the window has closed and no candle update has come for the symbol — fill at the mark
      if (!this.tapeMode && now >= pe.dueAt + QUIET_FILL_MS) { const m = this.marks.get(pe.symbol); if (m && m > 0) this.fillPending(pe, m, now, 'candle', now); }
    }
  }

  // ---- phase 2: tape, mark price, funding ----

  /** One print from the tape. Fills due pending entries, then checks liquidation (on mark), stop and resting targets. */
  onTrade(symbol: string, price: number, qty: number, time: number, observedAt = Date.now()): void {
    if (!(price > 0) || !Number.isFinite(time) || time < (this.lastTradeTime.get(symbol) ?? -Infinity)) return;
    this.lastTradeTime.set(symbol, time);
    this.lastTradeAt.set(symbol, observedAt);
    this.marks.set(symbol, price);
    if (!this.tapeMode) return;
    const filled = new Set<number>();
    for (const pe of [...this.pending.values()]) {
      if (pe.reclaim || pe.symbol !== symbol || time < pe.dueAt) continue;
      if (pe.limit) {
        if (time >= pe.at && this.limitTouched(pe, price, price)) {
          const pos = this.fillLimit(pe, observedAt, time);
          if (pos) {
            filled.add(pos.id);
            // A gap can cross both the resting entry and its stop. Do not give the
            // new position a free recovery until the next print. Only adverse stops
            // are evaluated here; this print cannot earn a same-fill target/trail.
            if (pos.sl !== null && (pos.side === 'long' ? price <= pos.sl : price >= pos.sl)) {
              const cfg = this.configFor(pos);
              const exits = applyTrade(pos, {time: observedAt, price, qty}, cfg, this.markPrices.get(symbol)?.price);
              if (exits.length && this.applyFills(pos, exits)) for (const f of exits) this.recordPath(pos, f.price, observedAt, f.reason, 'entry print crossed stop (tape)');
            }
          }
        }
        continue;
      }
      const pos = this.fillPending(pe, price, time, 'tape', observedAt);
      if (pos) filled.add(pos.id);
    }
    const mark = this.markPrices.get(symbol)?.price;
    for (const pos of [...this.open.values()]) {
      if (pos.symbol !== symbol || filled.has(pos.id) || time < pos.entryAt) continue;
      const slBefore = pos.sl, offBefore = pos.trailOff;
      const atr = (this.configFor(pos).trailAtrMult ?? 0) > 0 ? this.atrFor?.(pos.symbol, pos.tf) : undefined;
      const fills = applyTrade(pos, { time, price, qty }, this.configFor(pos), mark, atr);
      const maxHold=pos.executionPlan?.maxHoldMinutes;
      if(pos.status==="open" && maxHold && time-pos.entryAt>=maxHold*60_000)fills.push(fillExit(pos,price,pos.qtyOpen,"plan_time",time,this.configFor(pos),true));
      const committed = fills.length ? this.applyFills(pos, fills) : true;
      if (!fills.length && (pos.sl !== slBefore || pos.trailOff !== offBefore)) { this.persist(pos); this.emit('position', { type: 'updated', position: pos }); }
      if (committed) for (const f of fills) this.recordPath(pos, f.price, time, f.reason, `${f.qty} at ${f.price} (tape)`);
      if (pos.status === 'open') this.recordPath(pos, price, time, pos.sl !== slBefore ? 'stop moved' : undefined);
    }
    this.recordEquity(false);
  }

  /** Exchange mark price update: liquidation reference (tape mode), otherwise informational. */
  onMarkPrice(symbol: string, price: number, at = Date.now()): void {
    if (!(price > 0)) return;
    const prev = this.markPrices.get(symbol);
    if (prev && at < prev.at) return;
    this.markPrices.set(symbol, { price, at });
    if (!this.tapeMode) return;
    for (const pos of [...this.open.values()]) {
      if (pos.symbol !== symbol) continue;
      const fills = applyMark(pos, price, at, this.configFor(pos));
      if (fills.length) this.applyFills(pos, fills);
    }
  }

  /** Charge funding (percent rate × notional at mark, sign by side) to every open position of the symbol. Returns the number charged. */
  chargeFunding(symbol: string, ratePct: number, at = Date.now()): number {
    if (!(this.paper.fundingCharges ?? true)) return 0;
    const mark = this.markPrices.get(symbol)?.price ?? this.marks.get(symbol);
    let n = 0;
    for (const pos of [...this.open.values()]) {
      if (pos.symbol !== symbol) continue;
      const fill = applyFunding(pos, ratePct, mark ?? pos.entryPrice, at);
      if (!fill) continue;
      this.applyFills(pos, [fill]);
      n++;
    }
    if (n) { this.logInfo(`FUNDING ${symbol} ${ratePct}% charged to ${n} position(s)`); this.recordEquity(true); }
    return n;
  }

  /** Late funding is an accounting correction, never another trade-close/executor event. */
  reconcileFunding(symbol:string,rate:number,mark:number,at:number): number {
    if (!(this.paper.fundingCharges ?? true)) return 0;
    let n=0;
    const rows=this.db.all<any>(`SELECT * FROM positions WHERE bt=? AND symbol=? AND status IN ('open','closed') AND entry_at<=? AND (exit_at IS NULL OR exit_at>?)`,this.book,symbol,at,at);
    for(const row of rows){
      const pos=rowToPosition(row),fill=applyFundingSettlement(pos,rate,mark,at);
      if(!fill)continue;
      this.db.transaction(()=>{this.persistFill(pos,fill);this.persist(pos);});
      if(this.open.has(pos.id))Object.assign(this.open.get(pos.id)!,pos);
      this.closedCache=null;n++;
    }
    if(n){this.recordEquity(true);this.emit('stats',this.stats());this.emit('accounting',{at:Date.now(),reason:'funding',symbol,settledAt:at});}
    return n;
  }

  onScriptExit(scannerId: string, symbol: string, tf: string, exitType: ExitType, price: number | undefined, at: number, exitMode: ExitMode, side?: Side, targets?:{positionId:number|null;pendingIds:number[]}): Position | undefined {
    // Level-only scanners ignore script exits for both pending setups and held positions.
    if (exitMode === 'levels') return undefined;
    for (const pe of [...this.pending.values()]) if ((!targets||targets.pendingIds.includes(pe.id)) && pe.features?.reclaim_trial && pe.scannerId===scannerId && pe.symbol===symbol && pe.tf===tf && (!side||pe.side===side)) this.cancelPending(pe.id,'script cancelled reclaim');
    const pos = this.findOpen(scannerId, symbol, tf);
    if (!pos) return undefined;
    if(targets&&pos.id!==targets.positionId)return undefined;
    if (side && pos.side !== side) return undefined;
    // A script notification is a market instruction received now, including TP labels.
    // Resting targets are filled independently by the tape/candle path; a label cannot backdate one.
    const fallback = this.marks.get(symbol) ?? pos.lastPriceBar?.close ?? pos.entryPrice;
    const cfg = this.configFor(pos);
    const quote = this.marketPrice(symbol, pos.side === 'long' ? 'sell' : 'buy', fallback, cfg, at);
    const fills = applyScriptExit(pos, exitType, undefined, at, cfg, exitMode, fallback, { marketPrice: quote.price, quoted: quote.source === 'quote' });
    if (fills.length) this.applyFills(pos, fills, { ref: fallback, source: quote.source });
    return pos;
  }

  /**
   * Feed a 1m candle for a symbol. In `candles` mode (legacy) it drives every fill; in `tape` mode it
   * only takes over while the tape has been silent for more than `tapeFallbackMs`, otherwise it just
   * refreshes each position's candle baseline so a later fallback sees only new movement.
   */
  onBar(symbol: string, bar: PriceBar, observedAt = Date.now(), opts: { historical?: boolean } = {}): void {
    if (bar.time < (this.priceBars.get(symbol)?.time ?? -Infinity)) return;
    // a candle with a zero or missing price is a feed fault, never a print: it must not fill, stop or sample a trade
    if (!(bar.high > 0 && bar.low > 0 && bar.close > 0)) return;
    this.priceBars.set(symbol, { ...bar });
    // A bar a resync pulled from REST describes a period that has already ended. Its prices are
    // real, so open positions may still exit on them, but they are stamped at the bar's own close
    // instead of now, they never fill a new entry, and they never become the live mark.
    const barClosedAt = bar.time + 60_000;
    const historical = opts.historical === true || observedAt > barClosedAt + 60_000;
    const eventAt = historical ? Math.min(observedAt, barClosedAt) : observedAt;
    if (this.tapeMode && this.tapeActive(symbol, observedAt)) {
      for (const pos of this.open.values()) if (pos.symbol === symbol && pos.status === 'open' && observedAt >= pos.entryAt) pos.lastPriceBar = { ...bar };
      return;
    }
    if (!historical) this.marks.set(symbol, bar.close);
    if (!historical) {
      // tape mode: the candle is the fallback while the tape is silent; candles mode: the candle update is the price
      for (const pe of [...this.pending.values()]) {
        if (pe.reclaim || pe.symbol !== symbol) continue;
        // decision 185: a resting limit fills on a minute that traded through its price. Decision 189: only a minute that
        // began after the order was placed — the placing minute's low may have printed before the order existed, and the
        // tape audit showed limits filled that no trade after placement ever reached (thin coins, where this fallback runs)
        if (pe.limit) { if (bar.time >= pe.at && bar.time < pe.limit.expiresAt && this.limitTouched(pe, bar.low, bar.high)) this.fillLimit(pe, observedAt, bar.time); continue; }
        if (observedAt >= pe.dueAt) this.fillPending(pe, bar.close, observedAt, 'candle', observedAt);
      }
    }
    this.housekeeping(observedAt);
    for (const pos of [...this.open.values()]) {
      if (pos.symbol !== symbol) continue;
      const previous = pos.lastPriceBar;
      const pcfg = this.configFor(pos);
      const slBefore = pos.sl;
      const fills = applyLiveBar(pos, bar, pcfg, eventAt, (pcfg.trailAtrMult ?? 0) > 0 ? this.atrFor?.(pos.symbol, pos.tf) : undefined);
      const maxHold=pos.executionPlan?.maxHoldMinutes;
      if(!historical && pos.status==="open" && maxHold && eventAt-pos.entryAt>=maxHold*60_000)fills.push(fillExit(pos,bar.close,pos.qtyOpen,"plan_time",eventAt,pcfg,true));
      if (fills.length) this.applyFills(pos, fills);
      // decision 178: the structure stop of the last closed bar of the position's timeframe, over the trail, from the next minute on
      const st = pcfg.structureTrail;
      if (pos.status === 'open' && st?.enabled && this.structureFor && st.books.includes(this.book === 0 ? 'account' : 'shadow')) {
        const level = this.structureFor(pos.symbol, pos.tf);
        if (level) modelTrail(pos, bar, { level });
      }
      for (const f of fills) this.recordPath(pos, f.price, eventAt, f.reason, `${f.qty} at ${f.price}`);
      if (pos.sl !== slBefore && pos.status === 'open') this.recordPath(pos, bar.close, eventAt, 'stop moved', `${slBefore} → ${pos.sl}`);
      if (pos.status === 'open') this.recordPath(pos, bar.close, eventAt);
      if (pos.status === 'open' && !historical) {
        const sf = earlyStallExit(pos, bar.close, eventAt, pcfg);
        if (sf) this.applyFills(pos, [sf]);
      }
      if (pos.status === 'open' && pcfg.trendExit?.enabled && !historical) {
        const f = trendExit(pos, this.trendFor?.(pos.symbol, pos.tf), bar.close, eventAt, pcfg);
        if (f) this.applyFills(pos, [f]);
      }
      else if (pos.lastPriceBar !== previous) this.persist(pos);
    }
    this.recordEquity(false);
  }

  // ---- exchange-authoritative fills (execution, decision 46) ----
  // The paper book decides intent; when an executor mirrors it, what the exchange actually filled is
  // what the book records. These restate fills the simulator already booked, or book fills the
  // exchange made on its own (a resting stop that triggered on mark price).

  /** Restate the entry from the exchange fill. A fill of zero contracts voids the position: the exchange never held it. */
  adoptEntryFill(id: number, f: { price: number | null; qty: number; fee: number | null; at?: number }): Position | undefined {
    const pos = this.open.get(id);
    if (!pos) return undefined;
    if (!(f.qty > 0)) { this.voidPosition(id, 'exchange-unfilled'); return undefined; }
    const entry = pos.fills[0];
    if (pos.qtyOpen !== pos.qty) { log.error(`adoptEntryFill #${id}: position already partly exited; entry not restated`); return pos; }
    const before=structuredClone(pos);
    const price = f.price ?? entry.price;
    const cfg = this.configFor(pos);
    const fee = f.fee ?? (f.qty === pos.qty ? entry.fee : entry.fee * f.qty / pos.qty);
    pos.entryPrice = price; pos.qty = f.qty; pos.qtyOpen = f.qty;
    pos.legs = splitLegs(f.qty, cfg.tpSplit, pos.tp.length);
    pos.fees += fee - entry.fee;
    Object.assign(entry, { price, qty: f.qty, fee, ...(f.at ? { at: f.at } : {}) });
    if (pos.sl !== null) pos.riskAmount = Math.abs(price - pos.sl) * f.qty * pos.contractValue;
    pos.liqPrice = liquidationPrice(pos.side, price, pos.marginLeverage ?? pos.leverage ?? 0, cfg, pos.maintenanceMarginPct);
    try {this.db.transaction(()=>{
      this.db.run("UPDATE orders SET price=?, qty=?, fee=?, price_source='exchange' WHERE id=(SELECT id FROM orders WHERE position_id=? AND reason='entry' AND bt=? ORDER BY id ASC LIMIT 1)", price, f.qty, fee, pos.id,this.book);
      this.persist(pos);
    });}catch(e){Object.assign(pos,before);throw e;}
    this.emit('position', { type: 'updated', position: pos });
    this.recordEquity(true);
    this.logInfo(`ENTRY RESTATED #${pos.id} ${pos.symbol}: ${f.qty} @ ${price} fee ${fee.toFixed(4)} (exchange)`);
    return pos;
  }

  /** Remove a position the exchange never opened: nothing was risked, so nothing is recorded as a trade. */
  voidPosition(id: number, reason: string): boolean {
    const pos = this.open.get(id);
    if (!pos) return false;
    this.open.delete(id);
    this.db.transaction(() => {
      this.db.run('DELETE FROM position_path WHERE position_id=?', id);
      this.db.run('DELETE FROM orders WHERE position_id=?', id);
      this.db.run('DELETE FROM positions WHERE id=?', id);
      if (pos.signalId) this.db.updateSignalAction(pos.signalId, `rejected:${reason}`, null);
    });
    this.lastPathAt.delete(id); this.peakSeen.delete(id);
    this.emit('position', { type: 'voided', position: pos, reason });
    this.recordEquity(true);
    log.warn(`VOID #${id} ${pos.symbol} ${pos.side} x${pos.qty}: ${reason}`);
    return true;
  }

  /** Book an exit the exchange made that the simulator has not seen (its resting stop or target filled). */
  adoptExitFill(id: number, f: { price: number; qty: number; fee: number | null; reason: string; at: number }): Position | undefined {
    const pos = this.open.get(id);
    if (!pos || !(f.qty > 0)) return undefined;
    const cfg = this.configFor(pos);
    const leg = Number(f.reason.match(/^tp(\d)$/)?.[1] ?? 0);
    if (leg > 0 && pos.tpHit[leg - 1] !== undefined) pos.tpHit[leg - 1] = true;
    const fill = fillExit(pos, f.price, f.qty, f.reason, f.at, cfg, false);
    if (f.fee !== null) { pos.fees += f.fee - fill.fee; fill.fee = f.fee; }
    this.applyFills(pos, [fill], { source: 'exchange' });
    this.recordPath(pos, f.price, f.at, f.reason, `${f.qty} at ${f.price} (exchange)`);
    this.logInfo(`EXIT ADOPTED #${pos.id} ${pos.symbol} ${f.reason} ${f.qty} @ ${f.price} (exchange)`);
    return pos;
  }

  /** Restate the price and fee of a fill the simulator already booked (its last fill with this reason) from the exchange's. */
  restateFill(id: number, reason: string, f: { price: number | null; fee: number | null }): Position | undefined {
    const order=this.db.get<{id:number}>('SELECT id FROM orders WHERE position_id=? AND reason=? AND bt=? ORDER BY id DESC LIMIT 1',id,reason,this.book);
    return order ? this.restateOrderFill(order.id,f) : this.position(id);
  }

  /** Exact journal identity prevents a retry from restating a different exit with the same reason. */
  restateOrderFill(orderId:number, f:{price:number|null;fee:number|null}, commit?:()=>unknown):Position|undefined {
    const order=this.db.get<any>('SELECT * FROM orders WHERE id=? AND bt=?',orderId,this.book);
    if(!order)return undefined;
    const pos = this.open.get(order.position_id) ?? this.position(order.position_id);
    if (!pos) return undefined;
    const ids=this.db.all<{id:number}>('SELECT id FROM orders WHERE position_id=? AND bt=? ORDER BY id',pos.id,this.book);
    const fill=pos.fills.find(x=>x.orderId===orderId) ?? pos.fills[ids.findIndex(x=>x.id===orderId)];
    if(!fill || fill.reason!==order.reason || fill.qty!==order.qty || fill.reason==='funding')throw new Error('journal fill identity mismatch');
    const reason=fill.reason;
    const price = f.price ?? fill.price, fee = f.fee ?? fill.fee;
    if(!(price>0) || !Number.isFinite(price) || !Number.isFinite(fee))throw new Error('invalid exchange cash accounting');
    const before=structuredClone(pos);
    try { this.db.transaction(()=>{
      if(reason==='entry') {
        pos.entryPrice=price;
        if(pos.slOriginal!==null)pos.riskAmount=Math.abs(price-pos.slOriginal)*pos.qty*pos.contractValue;
        pos.liqPrice=liquidationPrice(pos.side,price,pos.marginLeverage??pos.leverage??0,this.configFor(pos),pos.maintenanceMarginPct);
        // Late entry prices affect every already booked exit; funding remains a separate cashflow.
        for(const x of pos.fills.filter(x=>x.reason!=='entry' && x.reason!=='funding')) {
          const pnl=pnlOf(pos,x.price,x.qty);pos.realizedPnl+=pnl-x.pnl;x.pnl=pnl;
        }
      }
      const pnl = reason === 'entry' ? 0 : pnlOf(pos, price, fill.qty);
      pos.realizedPnl += pnl - fill.pnl; pos.fees += fee - fill.fee;
      Object.assign(fill, { orderId,price,fee,pnl });
      if (pos.status === 'closed' && pos.fills.at(-1) === fill) pos.exitPrice = price;
      this.db.run("UPDATE orders SET price=?, fee=?, price_source='exchange' WHERE id=? AND bt=?", price, fee, orderId,this.book);
      this.persist(pos);commit?.();
    }); } catch(e) {Object.assign(pos,before);this.closedCache=null;throw e;}
    if (pos.status === 'closed') { this.closedCache = null; this.emit('stats', this.stats()); }
    else this.emit('position', { type: 'updated', position: pos });
    this.recordEquity(true);
    this.logInfo(`FILL RESTATED #${pos.id} ${pos.symbol} ${reason}: ${fill.qty} @ ${price} fee ${fee.toFixed(4)} (exchange)`);
    return pos;
  }

  closeForFunding(id: number, at: number): boolean {
    const pos=this.open.get(id); if (!pos) return false;
    const cfg=this.configFor(pos);
    const px=this.quotes?.executable(pos.symbol,pos.side==='long'?'sell':'buy',cfg.quoteMaxAgeMs,at);
    if (!(px && px>0)) return false;
    return this.applyFills(pos,[fillExit(pos,px,pos.qtyOpen,'funding-avoid',at,cfg,'quoted')],{ref:px,source:'quote'});
  }

  closeManual(id: number, reason = 'manual', at = Date.now()): Position | undefined {
    const pos = this.open.get(id);
    if (!pos) return undefined;
    const px = this.marks.get(pos.symbol) ?? pos.entryPrice;
    this.applyFills(pos, [fillExit(pos, px, pos.qtyOpen, reason, at, this.configFor(pos), true)]);
    return pos;
  }

  /** Close every open position that belongs to one scanner (used when a scanner is removed/disabled). */
  closeScanner(scannerId: string, reason = 'removed'): number {
    let n = 0;
    for (const p of [...this.open.values()]) if (p.scannerId === scannerId && this.closeManual(p.id, reason)) n++;
    return n;
  }

  closeAll(reason = 'manual', at = Date.now()): number {
    let n = 0;
    for (const id of [...this.pending.keys()]) this.cancelPending(id, reason);
    for (const id of [...this.open.keys()]) if (this.closeManual(id, reason, at)) n++;
    return n;
  }

  /**
   * Start the book again at its initial equity. The record is archived, not deleted: positions and
   * orders move to book `-(book + 1)` where every live query ignores them and the forensics keep
   * them (a reset used to erase the trades that prompted it).
   */
  reset(): void {
    const archive = -(this.book + 1);
    this.db.transaction(() => {
      this.db.run(`UPDATE positions SET bt=? WHERE bt=${this.book}`, archive);
      this.db.run(`UPDATE orders SET bt=? WHERE bt=${this.book}`, archive);
      if (this.book === 0) {
        this.db.run('DELETE FROM equity');
        this.db.run("UPDATE signals SET action='reset', position_id=NULL WHERE position_id IS NOT NULL");
      }
    });
    this.open.clear(); this.pending.clear(); this.closedCache = null;
    this.db.kvSet(`${this.kvPrefix}.initialEquity`, this.paper.initialEquity);
    this.db.kvSet(`${this.kvPrefix}.resetAt`, Date.now());
    this.peak = this.paper.initialEquity; this.maxDd = 0;
    this.db.kvSet('paper.peakEquity', this.peak); this.db.kvSet('paper.maxDrawdownPct', 0);
    this.recordEquity(true);
    this.emit('stats', this.stats());
    log.warn('paper account reset');
  }

  // ---- stats ----

  stats(): any {
    const closed = this.closedPositions();
    const initial = this.initialEquity;
    const g = computeStats(closed, initial);
    const byScanner: Record<string, TradeStats & { open: number; unrealized: number }> = {};
    const bySymbol: Record<string, { trades: number; pnl: number }> = {};
    const ids = new Set<string>([...closed.map(p => p.scannerId), ...[...this.open.values()].map(p => p.scannerId)]);
    for (const id of ids) {
      const s = computeStats(closed.filter(p => p.scannerId === id), initial) as any;
      s.open = [...this.open.values()].filter(p => p.scannerId === id).length;
      s.unrealized = [...this.open.values()].filter(p => p.scannerId === id).reduce((a, p) => a + unrealized(p, this.marks.get(p.symbol) ?? p.entryPrice), 0);
      byScanner[id] = s;
    }
    for (const p of closed) { const b = bySymbol[p.symbol] ?? (bySymbol[p.symbol] = { trades: 0, pnl: 0 }); b.trades++; b.pnl += p.realizedPnl - p.fees; }
    // closed = the journal (what the Trades page sums); open = every open position's banked legs, fees and mark.
    // equity = initial + closedPnl + openPnl, so no figure on the Overview can disagree with another.
    const open = [...this.open.values()];
    const closedPnl = closed.reduce((a, p) => a + p.realizedPnl - p.fees, 0);
    const openPnl = open.reduce((a, p) => a + p.realizedPnl - p.fees + unrealized(p, this.marks.get(p.symbol) ?? p.entryPrice), 0);
    return {
      equity: this.equity(), initialEquity: initial, closedPnl, closedFees: g.fees, openPnl, openFees: open.reduce((a, p) => a + p.fees, 0),
      peakEquity: this.peakEquity(), drawdownPct: this.drawdownPct(), maxDrawdownPct: this.maxDrawdownPct(),
      openPositions: this.open.size, pendingEntries: this.pending.size, trades: g.trades, wins: g.wins, losses: g.losses, winRatePct: g.winRatePct, profitFactor: fin(g.profitFactor),
      avgR: g.avgR, expectancy: g.expectancy, byScanner: mapFin(byScanner), bySymbol,
    };
  }

  /** Closed positions grouped by scanner, so a full scanner list does not rescan the array per scanner. */
  closedByScanner(): Map<string, Position[]> {
    const m = new Map<string, Position[]>();
    for (const p of this.closedPositions()) { const l = m.get(p.scannerId); if (l) l.push(p); else m.set(p.scannerId, [p]); }
    return m;
  }

  /** Open-position counts per scanner, same reason. */
  openCountByScanner(): Map<string, number> {
    const m = new Map<string, number>();
    for (const p of this.open.values()) m.set(p.scannerId, (m.get(p.scannerId) ?? 0) + 1);
    return m;
  }

  scannerStats(id: string, pre?: { closed: Map<string, Position[]>; open: Map<string, number> }) {
    if (pre) {
      const s: any = computeStats(pre.closed.get(id) ?? [], this.initialEquity);
      s.profitFactor = fin(s.profitFactor);
      s.open = pre.open.get(id) ?? 0;
      s.pnlPct = this.initialEquity ? s.pnl / this.initialEquity * 100 : 0;
      return s;
    }
    const closed = this.closedPositions().filter(p => p.scannerId === id);
    const s: any = computeStats(closed, this.initialEquity);
    s.profitFactor = fin(s.profitFactor);
    s.open = [...this.open.values()].filter(p => p.scannerId === id).length;
    s.pnlPct = this.initialEquity ? s.pnl / this.initialEquity * 100 : 0;
    return s;
  }

  equityCurve(scannerId: string | null, limit = 2000) {
    if (!scannerId) return this.db.all<any>('SELECT at, equity, realized, unrealized FROM equity WHERE scanner_id IS NULL ORDER BY at DESC LIMIT ?', limit).reverse();
    // per-scanner curve derived from closed trades
    const closed = this.closedPositions().filter(p => p.scannerId === scannerId);
    let eq = 0; const out = [{ at: closed[0]?.entryAt ?? Date.now(), equity: 0, realized: 0, unrealized: 0 }];
    for (const p of closed) { eq += p.realizedPnl - p.fees; out.push({ at: p.exitAt!, equity: eq, realized: eq, unrealized: 0 }); }
    return out.slice(-limit);
  }

  // ---- persistence ----

  private nextId(): number {
    const r = this.db.run("INSERT INTO positions(status, scanner_id, scanner_name, symbol, tf, side, qty, qty_open, contract_value, entry_price, entry_at, bt) VALUES ('pending','','','','','long',0,0,0,0,0,?)", this.book);
    return Number(r.lastInsertRowid);
  }

  /**
   * The path a trade takes, from entry to exit.
   *
   * `worstR` is the worst result *observed while sampling*, so a trade that runs up immediately and
   * never returns has a positive worst — it is the drawdown seen, not an assumption about the ticks
   * between samples.
   *
   * A closed trade in the database says where it ended but nothing about how it got there: the row
   * cannot answer "was it in profit before the stop", which is the first question anyone asks of a
   * loss. One row per sample or level event fixes that, and the peak and worst excursion are kept on
   * the position itself so the common question needs no replay at all.
   */
  private lastPathAt = new Map<number, number>();
  private peakSeen = new Map<number, number>();
  private readonly pathEveryMs = 60_000;

  private recordPath(p: Position, price: number, at: number, event?: string, note?: string): void {
    if (!(p.riskAmount > 0) || !(Number.isFinite(price) && price > 0)) return;
    const r = openR(p, price);
    let moved = false;
    // the trail raises peakR itself from intra-bar highs, so the timestamp is taken from whenever the
    // magnitude last increased — the bar on which the peak was observed, not a separate estimate
    p.peakR = Math.max(p.peakR ?? -Infinity, r);
    if ((p.peakR ?? -Infinity) > (this.peakSeen.get(p.id) ?? -Infinity)) { this.peakSeen.set(p.id, p.peakR!); p.peakAt = at; moved = true; }
    if (r < (p.worstR ?? Infinity)) { p.worstR = r; p.worstAt = at; moved = true; }
    // written straight away: a fill persists the position before this runs, and a closed trade is
    // never persisted again, so waiting for the next persist would lose the peak of the last bar
    if (moved) this.db.run('UPDATE positions SET peak_r=?, peak_at=?, worst_r=?, worst_at=? WHERE id=?', p.peakR ?? null, p.peakAt ?? null, p.worstR ?? null, p.worstAt ?? null, p.id);
    const last = this.lastPathAt.get(p.id) ?? 0;
    if (!event && at - last < this.pathEveryMs) return;
    this.lastPathAt.set(p.id, at);
    this.db.run('INSERT INTO position_path(position_id, at, price, r, sl, event, note) VALUES (?,?,?,?,?,?,?)',
      p.id, at, price, r, p.sl ?? null, event ?? null, note ?? null);
    if (p.status !== 'open') { this.lastPathAt.delete(p.id); this.peakSeen.delete(p.id); }
  }

  private persist(p: Position) {
    this.db.run(
      `UPDATE positions SET status=?, scanner_id=?, scanner_name=?, symbol=?, tf=?, side=?, qty=?, qty_open=?, contract_value=?, entry_price=?, entry_at=?, sl=?, sl_original=?, tp=?, tp_hit=?, break_even=?,
       realized_pnl=?, fees=?, risk_amount=?, levels_source=?, exit_at=?, exit_price=?, exit_reason=?, signal_id=?, fills=?, bt=? WHERE id=?`,
      p.status, p.scannerId, p.scannerName, p.symbol, p.tf, p.side, p.qty, p.qtyOpen, p.contractValue, p.entryPrice, p.entryAt, p.sl, p.slOriginal, JSON.stringify(p.tp), JSON.stringify(p.tpHit), p.breakEven ? 1 : 0,
      p.realizedPnl, p.fees, p.riskAmount, p.levelsSource, p.exitAt, p.exitPrice, p.exitReason, p.signalId, JSON.stringify({ executionPlan:p.executionPlan, fills: p.fills, legs: p.legs, leverage: p.leverage, marginLeverage: p.marginLeverage, maintenanceMarginPct: p.maintenanceMarginPct, liqPrice: p.liqPrice, features: p.features, mlProb: p.mlProb, lastPriceBar: p.lastPriceBar, peakR: p.peakR, trailOff: p.trailOff, trailArmedAt: p.trailArmedAt, trailPeakR: p.trailPeakR, trailPeakAt: p.trailPeakAt }), this.book, p.id,
    );
    this.db.run('UPDATE positions SET peak_r=?, peak_at=?, worst_r=?, worst_at=?, config_fp=COALESCE(?, config_fp) WHERE id=?', p.peakR ?? null, p.peakAt ?? null, p.worstR ?? null, p.worstAt ?? null, p.configFp ?? null, p.id);
  }

  private persistFill(p: Position, f: Fill, ctx: FillContext = {}) {
    const side = fillSide(p, f);
    // Funding is a cash adjustment, not a market execution with a quote/spread.
    const q = f.reason === 'funding' ? undefined : this.quotes?.markState?.(p.symbol);
    const saved = this.db.run(
      'INSERT INTO orders(at, position_id, scanner_id, symbol, side, qty, price, fee, reason, bt, ref_price, bid, ask, quote_at, price_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      f.at, p.id, p.scannerId, p.symbol, side, f.qty, f.price, f.fee, f.reason, this.book,
      ctx.ref ?? null, q?.bestBid ?? null, q?.bestAsk ?? null, q?.quoteAt ?? null, ctx.source ?? null,
    );
    f.orderId=Number(saved.lastInsertRowid);
    this.executionIntent?.(Number(saved.lastInsertRowid), orderOf(p, f));
  }

  private applyFills(pos: Position, fills: Fill[], context: FillContext = {}): boolean {
    // every fill and the position's new state commit together; the order events follow the commit
    try {
      this.db.transaction(() => { for (const f of fills) this.persistFill(pos, f, context); this.persist(pos); });
    } catch (e: any) {
      // The write rolled back, so the database still holds the position as it was. The object the callers
      // mutated must agree with it (decision 85): restore every field from the row, keep the object identity,
      // and let the next price re-trigger the exit. Nothing is emitted for a fill that did not commit.
      const row = this.db.get<any>(`SELECT * FROM positions WHERE id=? AND bt=${this.book}`, pos.id);
      if (row) {
        const fresh = rowToPosition(row);
        for (const k of Object.keys(pos)) delete (pos as any)[k];
        Object.assign(pos, fresh);
        if (pos.status === 'open') this.open.set(pos.id, pos); else this.open.delete(pos.id);
      }
      log.error(`fills for #${pos.id} ${pos.symbol} were not persisted and were undone in memory: ${e?.message ?? e}`);
      if(this.decisionActive)throw e;
      return false;
    }
    for (const f of fills) this.emit('order', orderOf(pos, f));
    if (pos.status === 'closed') {
      this.open.delete(pos.id);
      this.closedCache = null;
      this.emit('position', { type: 'closed', position: pos });
      this.emit('trade', tradeOf(pos));
      this.logInfo(`${this.book ? 'INCUBATOR ' : ''}CLOSE ${pos.side.toUpperCase()} ${pos.symbol} x${pos.qty} ${pos.exitReason} pnl ${(pos.realizedPnl - pos.fees).toFixed(2)} [${pos.scannerId}]`);
      this.recordEquity(true);
      this.emit('stats', this.stats());
    } else {
      this.emit('position', { type: 'updated', position: pos });
    }
    return true;
  }

  private recordEquity(force: boolean) {
    // the equity table and the drawdown alert belong to the live account only
    if (this.book !== 0) return;
    const now = Date.now();
    const eq = this.equity();
    if (!force && (now - this.lastEquityPoint < 60_000 || Math.abs(eq - this.lastEquityValue) < 1e-9)) return;
    this.lastEquityPoint = now; this.lastEquityValue = eq;
    this.db.run('INSERT INTO equity(at, scanner_id, equity, realized, unrealized) VALUES (?,?,?,?,?)', now, null, eq, this.realizedPnl(), this.unrealizedPnl());
  }

  orders(limit = 200) {
    const rows = this.db.all<any>(`SELECT o.id, o.at, o.position_id positionId, o.scanner_id scannerId, o.symbol, o.side, o.qty, o.price, o.fee, o.reason, o.price_source priceSource, a.state accountingState,a.confirmed_qty confirmedQty,a.expected_qty expectedQty, p.fills positionFills FROM orders o LEFT JOIN positions p ON p.id=o.position_id LEFT JOIN execution_accounting a ON a.source_order_id=o.id WHERE o.bt=${this.book} ORDER BY o.at DESC, o.id DESC LIMIT ?`, limit);
    return rows.map(({positionFills,...o}) => ({...o, pnl: o.reason === 'funding' ? (safe(positionFills, {fills:[]}).fills as Fill[]).find(f=>f.reason==='funding' && f.at===o.at)?.pnl ?? null : null}));
  }

  trades(opts: TradeFilter & { limit?: number } = {}) {
    return this.journalTrades(this.filterClosed(opts).slice(0, opts.limit ?? 200));
  }

  private journalTrades(positions:Position[]) {
    const pending=new Set(this.db.all<{id:number}>("SELECT DISTINCT position_id id FROM execution_accounting WHERE state!='complete'").map(r=>r.id));
    return positions.map(p=>({...tradeOf(p),accountingPending:pending.has(p.id)}));
  }

  /** Decision 190: one page of the journal, every filter applied before paging, with the count and totals of all matches. */
  tradesPage(opts: TradeFilter & { limit?: number; offset?: number } = {}) {
    const all = this.filterClosed(opts);
    const limit = Math.max(1, Math.min(2000, opts.limit ?? 300)), offset = Math.max(0, opts.offset ?? 0);
    const trades = this.journalTrades(all.slice(offset, offset + limit));
    const pending=new Set(this.db.all<{id:number}>("SELECT DISTINCT position_id id FROM execution_accounting WHERE state!='complete'").map(r=>r.id));
    let pnl = 0, fees = 0;
    for (const p of all) { const t = tradeOf(p); pnl += t.pnl; fees += t.fees ?? 0; }
    return { total: all.length, offset, limit, pnl, fees, accountingPending:all.filter(p=>pending.has(p.id)).length, from: all.length ? all[all.length - 1].exitAt : null, to: all.length ? all[0].exitAt : null, trades };
  }

  /** Closed positions matching the filter, newest first. */
  private filterClosed(o: TradeFilter): Position[] {
    let list = this.closedPositions();
    if (o.scanner) list = list.filter(p => p.scannerId === o.scanner);
    if (o.symbol) list = list.filter(p => p.symbol === o.symbol);
    if (o.reason) list = list.filter(p => p.exitReason === o.reason);
    if (o.tf) list = list.filter(p => p.tf === o.tf);
    if (o.side) list = list.filter(p => p.side === o.side);
    if (o.from) list = list.filter(p => (p.exitAt ?? 0) >= o.from!);
    if (o.to) list = list.filter(p => (p.exitAt ?? 0) < o.to!);
    return list.slice().reverse();
  }
}

function fin(v: number | null): number | null { return v === null || !Number.isFinite(v) ? (v === Infinity ? 999 : null) : v; }
function mapFin<T extends Record<string, any>>(o: T): T { for (const k of Object.keys(o)) o[k].profitFactor = fin(o[k].profitFactor); return o; }

export interface TradeFilter { scanner?: string; symbol?: string; reason?: string; tf?: string; side?: string; from?: number; to?: number }

export function rowToPosition(r: any): Position {
  const extra = safe(r.fills, { fills: [], legs: [] });
  return {
    executionPlan:extra.executionPlan, id: r.id, status: r.status, scannerId: r.scanner_id, scannerName: r.scanner_name, symbol: r.symbol, tf: r.tf, side: r.side, qty: r.qty, qtyOpen: r.qty_open,
    contractValue: r.contract_value, entryPrice: r.entry_price, entryAt: r.entry_at, sl: r.sl, slOriginal: r.sl_original, tp: safe(r.tp, []), tpHit: safe(r.tp_hit, []),
    legs: extra.legs ?? [], leverage: extra.leverage ?? 0, marginLeverage: extra.marginLeverage ?? extra.leverage ?? 0, maintenanceMarginPct: extra.maintenanceMarginPct ?? undefined, liqPrice: extra.liqPrice ?? null, features: extra.features, mlProb: extra.mlProb ?? null, lastPriceBar: extra.lastPriceBar, peakR: r.peak_r ?? extra.peakR ?? undefined, peakAt: r.peak_at ?? undefined, worstR: r.worst_r ?? undefined, worstAt: r.worst_at ?? undefined, trailOff: extra.trailOff, trailArmedAt: extra.trailArmedAt, trailPeakR: extra.trailPeakR, trailPeakAt: extra.trailPeakAt, breakEven: Boolean(r.break_even), realizedPnl: r.realized_pnl, fees: r.fees, riskAmount: r.risk_amount, levelsSource: r.levels_source ?? 'script',
    exitAt: r.exit_at, exitPrice: r.exit_price, exitReason: r.exit_reason, signalId: r.signal_id, fills: extra.fills ?? [], bt: Boolean(r.bt),
    configFp: r.config_fp ?? undefined,
  };
}
function safe(s: string, d: any) { try { return JSON.parse(s); } catch { return d; } }

/**
 * `mark` is the last traded price the engine values the position at; `exchangeMark` is Delta's own
 * mark price, the reference an exchange liquidates against. They are different numbers and the UI
 * must not present one as the other.
 */
export function positionView(p: Position, mark?: number, exchangeMark?: number | null, cfg?: PaperConfig, now = Date.now()) {
  const m = mark ?? p.entryPrice;
  return {
    id: p.id, scannerId: p.scannerId, scannerName: p.scannerName, symbol: p.symbol, tf: p.tf, side: p.side, qty: p.qty, qtyOpen: p.qtyOpen, contractValue: p.contractValue,
    entryPrice: p.entryPrice, entryAt: p.entryAt, sl: p.sl, slOriginal: p.slOriginal, tp: p.tp, tpHit: p.tpHit, breakEven: p.breakEven, markPrice: m,
    // contracts allocated to each target: a zero leg can never fill, so the UI must not imply it will
    legs: p.legs, peakR: p.peakR ?? null,
    unrealizedPnl: unrealized(p, m), realizedPnl: p.realizedPnl, fees: p.fees, riskAmount: p.riskAmount, rMultiple: p.riskAmount ? (p.realizedPnl - p.fees + unrealized(p, m)) / p.riskAmount : null,
    levelsSource: p.levelsSource, leverage: p.leverage, marginLeverage: p.marginLeverage, maintenanceMarginPct: p.maintenanceMarginPct ?? null, liqPrice: p.liqPrice, signalId: p.signalId, status: p.status,
    notional: p.qtyOpen * p.contractValue * m, notionalEntry: p.qty * p.contractValue * p.entryPrice, mlProb: p.mlProb ?? null,
    margin: (p.marginLeverage ?? p.leverage) > 0 ? notionalOf(p) / (p.marginLeverage ?? p.leverage) : null,
    exchangeMark: exchangeMark ?? null,
    protection: cfg ? {
      floorAtR: cfg.floorAtR ?? 0, floorKeepR: cfg.floorKeepR ?? 0,
      trailAfterR: cfg.trailAfterR ?? 0, trailAtrMult: cfg.trailAtrMult ?? 0,
      trailDistanceR: cfg.trailDistanceR || 1,
      keepPct: 100 - giveBackPct((p.trailArmedAt !== undefined ? p.trailPeakR : p.peakR) ?? 0, cfg, Math.max(0, now - ((p.trailArmedAt !== undefined ? p.trailPeakAt : p.peakAt) ?? now)) / 60_000),
      trailGiveBackPct: cfg.trailGiveBackPct ?? 0, trailSteps: cfg.trailSteps ?? [],
      trailStall: cfg.trailStall ?? null, peakR: (p.trailArmedAt !== undefined ? p.trailPeakR : p.peakR) ?? 0,
    } : null,
    funding: p.fills.filter(f => f.reason === 'funding').reduce((n,f)=>n+f.pnl,0),
    grossTradingPnl: p.realizedPnl - p.fills.filter(f => f.reason === 'funding').reduce((n,f)=>n+f.pnl,0),
  };
}

export function tradeOf(p: Position) {
  const net = p.realizedPnl - p.fees;
  return {
    funding: p.fills.filter(f => f.reason === 'funding').reduce((n,f)=>n+f.pnl,0), grossTradingPnl: p.realizedPnl - p.fills.filter(f => f.reason === 'funding').reduce((n,f)=>n+f.pnl,0),
    id: p.id, positionId: p.id, scannerId: p.scannerId, scannerName: p.scannerName, symbol: p.symbol, tf: p.tf, side: p.side, qty: p.qty, entryPrice: p.entryPrice,
    exitPrice: p.exitPrice, entryAt: p.entryAt, exitAt: p.exitAt, pnl: net, pnlPct: p.entryPrice ? net / (p.entryPrice * p.qty * p.contractValue) * 100 : 0, fees: p.fees,
    rMultiple: rMultiple(p), exitReason: p.exitReason, levelsSource: p.levelsSource, leverage: p.leverage, mlProb: p.mlProb ?? null, features: p.features, sl: p.slOriginal, tp: p.tp, tpHit: p.tpHit, fills: p.fills, signalId: p.signalId,
    peakR: p.peakR ?? null, worstR: p.worstR ?? null, peakAt: p.peakAt ?? null, riskAmount: p.riskAmount, configFp: p.configFp ?? null,
  };
}

/** Order side of a fill: entries trade with the position, exits against it; a funding charge is `pay` or `receive`. */
export function fillSide(p: Position, f: Fill): 'buy' | 'sell' | 'pay' | 'receive' {
  if (f.reason === 'funding') return f.pnl < 0 ? 'pay' : 'receive';
  return f.reason === 'entry' ? (p.side === 'long' ? 'buy' : 'sell') : (p.side === 'long' ? 'sell' : 'buy');
}

export function orderOf(p: Position, f: Fill) {
  return { at: f.at, positionId: p.id, scannerId: p.scannerId, symbol: p.symbol, side: fillSide(p, f), qty: f.qty, price: f.price, fee: f.fee, reason: f.reason, pnl: f.pnl };
}
