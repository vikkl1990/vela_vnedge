/**
 * Portfolio risk layer (phase 3). Sits between a scanner signal and the paper engine's sizing:
 *   - daily / weekly max-loss kill switches (equity vs period-start equity, UTC day / ISO week),
 *   - manual halt, optional close-all on trip,
 *   - max concurrent positions (total, per symbol, per scanner),
 *   - per-scanner daily loss budget, cooldown after N consecutive losses,
 *   - drawdown-scaled sizing (leverage/risk multiplier from the equity peak),
 *   - regime filter (ATR % floor, no weekend entries),
 *   - BTC-beta exposure cap from a rolling return correlation with BTCUSD.
 * Every veto is returned as a reason string; the engine records it as `rejected:risk <reason>`.
 * State is persisted in the kv table so restarts keep the trip / cooldown / peak bookkeeping.
 */
import { EventEmitter } from 'node:events';
import type { AppConfig, RiskConfig } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';
import type { Db } from '../db.ts';
import { logger } from '../log.ts';
import type { PaperEngine, RiskEntryRequest, RiskGate } from '../paper/engine.ts';
import { notionalOf } from '../paper/logic.ts';
import type { Side } from '../scanners/extractor.ts';
import { returnCorrelation } from './correlation.ts';

const log = logger.scoped('risk');
const KV_KEY = 'risk.state';
const DAY_MS = 86_400_000;

interface Period { start: number; startEquity: number; tripped: boolean; trippedAt: number | null; trippedPnlPct: number | null }
interface ScannerLossState { consecutive: number; lastLossAt: number | null; cooldownUntil: number | null }
interface RiskState {
  day: Period;
  week: Period;
  peakEquity: number;
  manualHalt: { at: number; reason: string } | null;
  scanners: Record<string, ScannerLossState>;
  /** paper.resetAt seen when the state was built; a paper reset restarts the bookkeeping. */
  paperResetAt: number | null;
}
export interface Rejection { at: number; scannerId: string; symbol: string; side: Side; reason: string }

export interface RiskDeps {
  db: Db;
  paper: PaperEngine;
  /** Candle access for the correlation cap (null disables it). */
  candles: { get(symbol: string, tf: string, opts?: { limit?: number; closedOnly?: boolean }): Bar[] } | null;
  cfgRef: () => AppConfig;
  now?: () => number;
}

export function utcDayStart(t: number): number { return Math.floor(t / DAY_MS) * DAY_MS; }
/** Monday 00:00 UTC of the week containing `t` (1970-01-01 was a Thursday). */
export function utcWeekStart(t: number): number {
  const day = utcDayStart(t);
  const dow = new Date(day).getUTCDay(); // 0 = Sunday
  const back = (dow + 6) % 7;             // days since Monday
  return day - back * DAY_MS;
}
export function isWeekend(t: number): boolean { const d = new Date(t).getUTCDay(); return d === 0 || d === 6; }

export class RiskManager extends EventEmitter implements RiskGate {
  private db: Db;
  private paper: PaperEngine;
  private candles: RiskDeps['candles'];
  private cfgRef: () => AppConfig;
  private now: () => number;
  private st: RiskState;
  private rejections: Rejection[] = [];

  constructor(deps: RiskDeps) {
    super();
    this.db = deps.db; this.paper = deps.paper; this.candles = deps.candles; this.cfgRef = deps.cfgRef; this.now = deps.now ?? (() => Date.now());
    const stored = this.db.kvGet<RiskState>(KV_KEY);
    this.st = stored ?? this.freshState(this.now());
    this.tick(this.now());
    this.paper.on('trade', (t: { scannerId: string; pnl: number; exitAt: number; exitReason: string | null }) => this.onTradeClosed(t));
    log.info(`risk layer ready: day ${this.st.day.tripped ? 'TRIPPED' : 'ok'}, week ${this.st.week.tripped ? 'TRIPPED' : 'ok'}${this.st.manualHalt ? ', MANUAL HALT' : ''}`);
  }

  private get cfg(): RiskConfig { return this.cfgRef().risk; }

  private freshState(now: number): RiskState {
    const eq = this.paper.equity();
    return {
      day: { start: utcDayStart(now), startEquity: eq, tripped: false, trippedAt: null, trippedPnlPct: null },
      week: { start: utcWeekStart(now), startEquity: eq, tripped: false, trippedAt: null, trippedPnlPct: null },
      peakEquity: eq, manualHalt: null, scanners: {}, paperResetAt: this.db.kvGet<number>('paper.resetAt') ?? null,
    };
  }

  private save() { this.db.kvSet(KV_KEY, this.st); }

  // ---- period bookkeeping ----

  /** Roll UTC day / week windows, track the equity peak, trip kill switches. Safe to call often. */
  tick(now = this.now()): void {
    const resetAt = this.db.kvGet<number>('paper.resetAt') ?? null;
    if (resetAt !== this.st.paperResetAt) { this.st = this.freshState(now); this.save(); log.info('paper account was reset: risk bookkeeping restarted'); return; }
    const eq = this.paper.equity();
    let changed = false;
    const dayStart = utcDayStart(now), weekStart = utcWeekStart(now);
    if (dayStart !== this.st.day.start) { if (this.st.day.tripped) log.info('daily kill switch reset (new UTC day)'); this.st.day = { start: dayStart, startEquity: eq, tripped: false, trippedAt: null, trippedPnlPct: null }; changed = true; }
    if (weekStart !== this.st.week.start) { if (this.st.week.tripped) log.info('weekly kill switch reset (new week)'); this.st.week = { start: weekStart, startEquity: eq, tripped: false, trippedAt: null, trippedPnlPct: null }; changed = true; }
    if (eq > this.st.peakEquity) { this.st.peakEquity = eq; changed = true; }
    const c = this.cfg;
    if (c?.enabled) {
      const dayPnl = this.periodPnlPct(this.st.day, eq), weekPnl = this.periodPnlPct(this.st.week, eq);
      if (!this.st.day.tripped && c.maxDailyLossPct > 0 && dayPnl <= -c.maxDailyLossPct) { this.trip(this.st.day, 'daily', dayPnl, now); changed = true; }
      if (!this.st.week.tripped && c.maxWeeklyLossPct > 0 && weekPnl <= -c.maxWeeklyLossPct) { this.trip(this.st.week, 'weekly', weekPnl, now); changed = true; }
    }
    if (changed) this.save();
  }

  private periodPnlPct(p: Period, equity: number): number { return p.startEquity > 0 ? (equity - p.startEquity) / p.startEquity * 100 : 0; }

  private trip(p: Period, which: 'daily' | 'weekly', pnlPct: number, now: number) {
    p.tripped = true; p.trippedAt = now; p.trippedPnlPct = pnlPct;
    log.error(`KILL SWITCH: ${which} loss ${pnlPct.toFixed(2)}% reached the limit — no new entries until the ${which === 'daily' ? 'UTC day' : 'week'} rolls`);
    this.emit('kill', { which, pnlPct, at: now });
    if (this.cfg.closeAllOnKill) { const n = this.paper.closeAll('risk-kill'); log.warn(`closed ${n} position(s) on ${which} kill switch`); }
  }

  private onTradeClosed(t: { scannerId: string; pnl: number; exitAt: number }) {
    const c = this.cfg;
    const s = this.st.scanners[t.scannerId] ?? (this.st.scanners[t.scannerId] = { consecutive: 0, lastLossAt: null, cooldownUntil: null });
    if (t.pnl < 0) {
      s.consecutive++; s.lastLossAt = t.exitAt;
      if (c?.cooldownAfterLosses > 0 && s.consecutive >= c.cooldownAfterLosses) {
        s.cooldownUntil = t.exitAt + c.cooldownMinutes * 60_000;
        log.warn(`${t.scannerId}: ${s.consecutive} consecutive losses → cooldown until ${new Date(s.cooldownUntil).toISOString()}`);
      }
    } else if (t.pnl > 0) { s.consecutive = 0; }
    this.save();
    this.tick(Math.max(this.now(), t.exitAt));
  }

  // ---- entry gate ----

  gate(req: RiskEntryRequest): { reject?: string; leverageMult: number } {
    const now = Math.max(this.now(), req.at);
    this.tick(now);
    const c = this.cfg;
    const reject = (reason: string) => { this.record(req, reason); return { reject: reason, leverageMult: 1 }; };
    if (this.st.manualHalt) return reject(`manual halt (${this.st.manualHalt.reason})`);
    if (!c?.enabled) return { leverageMult: 1 };
    if (this.st.day.tripped) return reject(`daily loss limit ${c.maxDailyLossPct}% hit (${this.st.day.trippedPnlPct?.toFixed(2)}%)`);
    if (this.st.week.tripped) return reject(`weekly loss limit ${c.maxWeeklyLossPct}% hit (${this.st.week.trippedPnlPct?.toFixed(2)}%)`);
    const open = this.paper.openPositions(), pending = this.paper.pendingEntries();
    const total = open.length + pending.length;
    if (total >= c.maxPositionsTotal) return reject(`max positions ${c.maxPositionsTotal} reached`);
    const bySymbol = open.filter(p => p.symbol === req.symbol).length + pending.filter(p => p.symbol === req.symbol).length;
    if (bySymbol >= c.maxPositionsPerSymbol) return reject(`max ${c.maxPositionsPerSymbol} positions on ${req.symbol}`);
    const byScanner = open.filter(p => p.scannerId === req.scannerId).length + pending.filter(p => p.scannerId === req.scannerId).length;
    if (byScanner >= c.perScannerMaxPositions) return reject(`scanner at its ${c.perScannerMaxPositions}-position budget`);
    if (c.perScannerDailyLossPct > 0) {
      const lossPct = this.scannerDayPnl(req.scannerId) / (this.st.day.startEquity || 1) * 100;
      if (lossPct <= -c.perScannerDailyLossPct) return reject(`scanner daily loss ${lossPct.toFixed(2)}% ≤ -${c.perScannerDailyLossPct}%`);
    }
    const s = this.st.scanners[req.scannerId];
    if (s?.cooldownUntil && now < s.cooldownUntil) return reject(`cooldown after ${s.consecutive} losses until ${new Date(s.cooldownUntil).toISOString().slice(11, 16)}Z`);
    const r = c.regime;
    if (r?.enabled && !(r.exempt ?? []).includes(req.scannerId)) {
      if (r.noWeekend && isWeekend(req.at)) return reject('regime: weekend');
      if (r.minAtrPct > 0 && req.atr !== undefined && req.atr > 0 && req.price > 0) {
        const atrPct = req.atr / req.price * 100;
        if (atrPct < r.minAtrPct) return reject(`regime: ATR ${atrPct.toFixed(2)}% < ${r.minAtrPct}%`);
      }
    }
    return { leverageMult: this.leverageMult() };
  }

  /** Multiplier from `ddScale` for the current drawdown (largest ddPct ≤ drawdown wins; 1 when none). */
  leverageMult(): number {
    const c = this.cfg;
    if (!c?.enabled || !Array.isArray(c.ddScale) || !c.ddScale.length) return 1;
    const dd = this.drawdownPct();
    let mult = 1, best = -1;
    for (const d of c.ddScale) if (dd >= d.ddPct && d.ddPct > best) { best = d.ddPct; mult = d.leverageMult; }
    return mult;
  }

  drawdownPct(): number {
    const eq = this.paper.equity();
    return this.st.peakEquity > 0 ? Math.max(0, (this.st.peakEquity - eq) / this.st.peakEquity * 100) : 0;
  }

  exposureCheck(req: { symbol: string; side: Side; tf: string; notional: number }): string | null {
    const c = this.cfg;
    if (!c?.enabled || !(c.maxBetaExposurePct > 0)) return null;
    const x = this.exposure(req.tf, { symbol: req.symbol, side: req.side, notional: req.notional });
    const cap = c.maxBetaExposurePct;
    if (Math.abs(x.netBetaPct) > cap) {
      const reason = `beta exposure ${x.netBetaPct.toFixed(0)}% of equity would exceed ±${cap}% (corr ${req.symbol}/BTCUSD ${x.candidateCorr?.toFixed(2) ?? 'n/a'})`;
      this.record({ scannerId: '', symbol: req.symbol, side: req.side, at: this.now() }, reason);
      return reason;
    }
    return null;
  }

  /** BTC-beta exposure: Σ side × notional × corr(symbol, BTCUSD) over open positions (+ an optional candidate), as % of equity. */
  exposure(tf: string, candidate?: { symbol: string; side: Side; notional: number }) {
    const eq = this.paper.equity() || 1;
    const corrCache = new Map<string, number | null>();
    const corrOf = (symbol: string): number | null => {
      if (symbol === 'BTCUSD') return 1;
      if (corrCache.has(symbol)) return corrCache.get(symbol)!;
      let corr: number | null = null;
      if (this.candles) {
        const n = this.cfg.corrBars || 20;
        const a = this.candles.get(symbol, tf, { closedOnly: true, limit: n + 1 });
        const b = this.candles.get('BTCUSD', tf, { closedOnly: true, limit: n + 1 });
        corr = a.length && b.length ? returnCorrelation(a, b, n) : null;
      }
      corrCache.set(symbol, corr);
      return corr;
    };
    const rows: Array<{ symbol: string; side: Side; notional: number; corr: number | null; beta: number }> = [];
    let net = 0, netBeta = 0;
    const add = (symbol: string, side: Side, notional: number) => {
      const corr = corrOf(symbol);
      const sign = side === 'long' ? 1 : -1;
      const beta = sign * notional * (corr ?? 1); // unknown correlation is treated as 1 (conservative)
      rows.push({ symbol, side, notional, corr, beta });
      net += sign * notional; netBeta += beta;
    };
    for (const p of this.paper.openPositions()) add(p.symbol, p.side, notionalOf(p));
    if (candidate) add(candidate.symbol, candidate.side, candidate.notional);
    return { netNotional: net, netBetaNotional: netBeta, netPct: net / eq * 100, netBetaPct: netBeta / eq * 100, rows, candidateCorr: candidate ? corrOf(candidate.symbol) : null };
  }

  private scannerDayPnl(scannerId: string): number {
    const start = this.st.day.start;
    let pnl = 0;
    for (const p of this.paper.closedPositions()) if (p.scannerId === scannerId && (p.exitAt ?? 0) >= start) pnl += p.realizedPnl - p.fees;
    for (const p of this.paper.openPositions()) if (p.scannerId === scannerId) pnl += p.realizedPnl - p.fees;
    return pnl;
  }

  private record(req: { scannerId: string; symbol: string; side: Side; at: number }, reason: string) {
    this.rejections.push({ at: req.at, scannerId: req.scannerId, symbol: req.symbol, side: req.side, reason });
    if (this.rejections.length > 100) this.rejections.splice(0, this.rejections.length - 100);
    log.info(`REJECT ${req.side} ${req.symbol} [${req.scannerId}]: ${reason}`);
    this.emit('rejection', this.rejections.at(-1));
  }

  // ---- controls ----

  /** Manual halt: no new entries until `reset()`. Optionally flattens the paper account. */
  kill(reason = 'manual', closeAll = false): void {
    this.st.manualHalt = { at: this.now(), reason };
    this.save();
    log.error(`MANUAL HALT: ${reason}`);
    this.emit('kill', { which: 'manual', reason, at: this.st.manualHalt.at });
    if (closeAll) { const n = this.paper.closeAll('risk-kill'); log.warn(`closed ${n} position(s) on manual halt`); }
  }

  /** Clear the manual halt, tripped kill switches and cooldowns; restart the period windows from the current equity. */
  reset(): void {
    this.st = this.freshState(this.now());
    this.save();
    this.rejections = [];
    log.warn('risk state reset');
  }

  state() {
    const now = this.now();
    this.tick(now);
    const eq = this.paper.equity();
    const c = this.cfg;
    const period = (p: Period, limitPct: number) => ({ start: p.start, startEquity: p.startEquity, pnl: eq - p.startEquity, pnlPct: this.periodPnlPct(p, eq), limitPct, tripped: p.tripped, trippedAt: p.trippedAt });
    const open = this.paper.openPositions(), pending = this.paper.pendingEntries();
    const count = (key: 'symbol' | 'scannerId') => { const o: Record<string, number> = {}; for (const p of open) o[p[key]] = (o[p[key]] ?? 0) + 1; for (const p of pending) o[p[key]] = (o[p[key]] ?? 0) + 1; return o; };
    const tf = this.cfgRef().timeframes?.[0] ?? '15m';
    const halted = Boolean(this.st.manualHalt) || this.st.day.tripped || this.st.week.tripped;
    return {
      at: now, enabled: Boolean(c?.enabled), halted,
      haltReason: this.st.manualHalt ? `manual: ${this.st.manualHalt.reason}` : this.st.day.tripped ? 'daily loss limit' : this.st.week.tripped ? 'weekly loss limit' : null,
      manualHalt: this.st.manualHalt, equity: eq, peakEquity: this.st.peakEquity, drawdownPct: this.drawdownPct(), leverageMult: this.leverageMult(),
      day: period(this.st.day, c?.maxDailyLossPct ?? 0), week: period(this.st.week, c?.maxWeeklyLossPct ?? 0),
      positions: { open: open.length, pending: pending.length, max: c?.maxPositionsTotal ?? null, bySymbol: count('symbol'), byScanner: count('scannerId'), maxPerSymbol: c?.maxPositionsPerSymbol ?? null, maxPerScanner: c?.perScannerMaxPositions ?? null },
      scanners: Object.fromEntries(Object.entries(this.st.scanners).map(([id, s]) => [id, { ...s, dayPnl: this.scannerDayPnl(id), inCooldown: Boolean(s.cooldownUntil && now < s.cooldownUntil) }])),
      exposure: { tf, ...this.exposure(tf), limitPct: c?.maxBetaExposurePct ?? 0 },
      regime: c?.regime ?? null, config: c, rejections: this.rejections.slice(-50).reverse(),
    };
  }
}
