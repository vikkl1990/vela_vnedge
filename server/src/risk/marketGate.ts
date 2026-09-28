/**
 * Markets today: which pairs the fleet may trade right now, decided from the market itself rather
 * than from any scanner (decision 56). A market is allowed unless one of three things is true:
 *
 *   - it is illiquid today (24 h turnover below `minTurnoverUsd`);
 *   - its volatility cannot pay the round trip (15m ATR as a share of price below
 *     `minAtrFeeMult` × the round-trip fee — the same arithmetic as the fee filter, applied to the
 *     market before any signal is spent on it);
 *   - the book's own recent record on it is losing (`minTrades` or more closed trades in the last
 *     `lookbackDays` in the live book and its archive with a profit factor under `minPf`).
 *
 * The verdicts refresh every `refreshMinutes` and are kept in `kv` for the dashboard. A market the
 * bot has no candles for gets no volatility opinion rather than a block.
 */
import type { AppConfig } from '../config.ts';
import type { Db } from '../db.ts';
import type { Bar } from '../data/candleStore.ts';
import { atrSeries } from '../data/indicators.ts';
import { logger } from '../log.ts';

const log = logger.scoped('markets');
const KV_KEY = 'risk.marketsToday';

export interface MarketVerdict { symbol: string; allowed: boolean; tracked: boolean; reasons: string[]; atrPct: number | null; turnoverUsd: number | null; trades: number; pf: number | null; netUsd: number }
export interface MarketsToday { at: number; enabled: boolean; markets: MarketVerdict[] }

export interface MarketGateDeps {
  db: Db;
  candles: { get(symbol: string, tf: string, opts?: { limit?: number; closedOnly?: boolean }): Bar[] } | null;
  markets: () => Promise<Array<{ symbol: string; volume24h: number; price: number }>>;
  cfgRef: () => AppConfig;
  now?: () => number;
}

export class MarketGate {
  private deps: MarketGateDeps;
  private now: () => number;
  private state: MarketsToday;
  constructor(deps: MarketGateDeps) {
    this.deps = deps; this.now = deps.now ?? (() => Date.now());
    this.state = deps.db.kvGet<MarketsToday>(KV_KEY) ?? { at: 0, enabled: false, markets: [] };
  }

  get today(): MarketsToday { return this.state; }
  private get cfg() { return this.deps.cfgRef().risk.marketGate; }

  /** The verdict for one market, or null when the gate is off or has no opinion yet. */
  verdict(symbol: string): MarketVerdict | null {
    if (!this.cfg?.enabled) return null;
    return this.state.markets.find(m => m.symbol === symbol) ?? null;
  }

  /** The symbols worth a verdict: the ones given plus every perpetual above the turnover floor (so a market the bot is not yet on is judged too). */
  async universe(symbols: string[]): Promise<string[]> {
    const c = this.cfg;
    const out = new Set(symbols);
    try { for (const m of await this.deps.markets()) if (m.volume24h >= (c?.minTurnoverUsd ?? 0) && /USD$/.test(m.symbol)) out.add(m.symbol); } catch { /* the given symbols still get judged */ }
    return [...out];
  }

  /** Recompute every verdict for the given symbols; `tracked` names the ones the bot actually scans (the fleet's and the incubator's), the rest are the liquid universe around them. */
  async refresh(symbols: string[], now = this.now(), tracked: Iterable<string> = symbols): Promise<MarketsToday> {
    const own = new Set(tracked);
    const c = this.cfg;
    const paper = this.deps.cfgRef().paper;
    if (!c?.enabled) { this.state = { at: now, enabled: false, markets: [] }; this.deps.db.kvSet(KV_KEY, this.state); return this.state; }
    let tickers = new Map<string, { volume24h: number; price: number }>();
    try { tickers = new Map((await this.deps.markets()).map(m => [m.symbol, { volume24h: m.volume24h, price: m.price }])); }
    catch (e: any) { log.warn(`tickers unavailable: ${e?.message ?? e}; turnover not judged`); }
    const feeRoundTripPct = paper.feeRatePct * (1 + (paper.feeTaxPct ?? 0) / 100) * 2;
    const since = now - c.lookbackDays * 86_400_000;
    const markets: MarketVerdict[] = [];
    for (const symbol of [...new Set(symbols)].sort()) {
      if ((c.exempt ?? []).includes(symbol)) { markets.push({ symbol, allowed: true, tracked: own.has(symbol), reasons: ['exempt'], atrPct: null, turnoverUsd: null, trades: 0, pf: null, netUsd: 0 }); continue; }
      const reasons: string[] = [];
      const t = tickers.get(symbol);
      const turnoverUsd = t ? t.volume24h : null;
      if (turnoverUsd !== null && c.minTurnoverUsd > 0 && turnoverUsd < c.minTurnoverUsd) reasons.push(`illiquid: $${(turnoverUsd / 1e6).toFixed(2)}M 24h turnover < $${(c.minTurnoverUsd / 1e6).toFixed(2)}M`);
      let atrPct: number | null = null;
      const bars = this.deps.candles?.get(symbol, c.tf ?? '15m', { limit: 120, closedOnly: true }) ?? [];
      if (bars.length >= 30) {
        const a = atrSeries(bars, 14); const last = a[a.length - 1]; const px = bars[bars.length - 1].close;
        if (Number.isFinite(last) && px > 0) atrPct = last / px * 100;
      }
      if (atrPct !== null && c.minAtrFeeMult > 0 && atrPct < feeRoundTripPct * c.minAtrFeeMult) reasons.push(`too quiet: ${c.tf ?? '15m'} ATR ${atrPct.toFixed(2)}% < ${(feeRoundTripPct * c.minAtrFeeMult).toFixed(2)}% (${c.minAtrFeeMult}× the round-trip fee)`);
      // the live book and its archive only: shadow trades belong to unproven scripts and say nothing about the market
      const rows = this.deps.db.all<{ pnl: number }>('SELECT realized_pnl - fees AS pnl FROM positions WHERE status=\'closed\' AND bt IN (0, -1) AND symbol=? AND exit_at>=?', symbol, since);
      const gp = rows.filter(r => r.pnl > 0).reduce((a, r) => a + r.pnl, 0), gl = -rows.filter(r => r.pnl <= 0).reduce((a, r) => a + r.pnl, 0);
      const pf = rows.length ? (gl > 0 ? gp / gl : gp > 0 ? 99 : 0) : null;
      if (rows.length >= c.minTrades && pf !== null && pf < c.minPf) reasons.push(`not paying: PF ${pf.toFixed(2)} over ${rows.length} trades in ${c.lookbackDays}d`);
      markets.push({ symbol, allowed: reasons.length === 0, tracked: own.has(symbol), reasons, atrPct, turnoverUsd, trades: rows.length, pf, netUsd: gp - gl });
    }
    this.state = { at: now, enabled: true, markets };
    this.deps.db.kvSet(KV_KEY, this.state);
    const blocked = markets.filter(m => !m.allowed);
    log.info(`markets today: ${markets.length - blocked.length} allowed, ${blocked.length} blocked${blocked.length ? ` (${blocked.map(m => m.symbol).join(', ')})` : ''}`);
    return this.state;
  }
}
