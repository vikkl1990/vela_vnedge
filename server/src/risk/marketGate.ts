/**
 * Markets today: which pairs the fleet may trade right now, decided from the market itself rather
 * than from any scanner (decision 56). A market is allowed unless one of three things is true:
 *
 *   - it is not a crypto market (Delta's tokenized stocks, ETFs and metals; `cryptoOnly`, on by default);
 *   - it is dead today (24 h turnover below `minTurnoverUsd`, a low sanity floor);
 *   - its book is too expensive to cross (decision 56b): walking the level-2 book for
 *     `probeNotionalUsd` in and back out — half the spread each way, the slippage of the walk, and
 *     the taker fee — costs more than `maxBookCostPct` of the notional. Turnover is a poor proxy for
 *     this: a $1M/day market can quote a tighter book than a $13M one;
 *   - its volatility cannot pay that round trip (15m ATR as a share of price below
 *     `minAtrFeeMult` × the market's own round-trip cost, or × the fee when the book is unknown);
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
/** Delta lists tokenized stocks, ETFs, indices and metals as USD perpetuals; their descriptions say so. Venice Token (VVV) is crypto and does not match. */
export const NOT_CRYPTO = /xStock|bStocks?|Gold Token|Silver|\bETF\b/i;
export const isCrypto = (description: string | undefined) => !NOT_CRYPTO.test(description ?? '');

export interface MarketVerdict { symbol: string; allowed: boolean; tracked: boolean; reasons: string[]; atrPct: number | null; turnoverUsd: number | null; spreadPct: number | null; bookCostPct: number | null; trades: number; pf: number | null; netUsd: number }
export interface MarketsToday { at: number; enabled: boolean; markets: MarketVerdict[] }

export interface MarketGateDeps {
  db: Db;
  candles: { get(symbol: string, tf: string, opts?: { limit?: number; closedOnly?: boolean }): Bar[] } | null;
  markets: () => Promise<Array<{ symbol: string; volume24h: number; price: number; description?: string }>>;
  /** Level-2 book as [price, quantity in base units] per level, best first; absent or throwing → no book opinion. */
  book?: (symbol: string) => Promise<{ bids: Array<[number, number]>; asks: Array<[number, number]> }>;
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
  /**
   * The gate's opinion of a market. Null only when the gate is off (no opinion). When it is on, a market
   * it has not judged, or a verdict set older than three refresh periods, is a refusal, not a pass: a
   * check that could not run must not read as a check that passed (decision 76).
   */
  verdict(symbol: string, now = Date.now()): MarketVerdict | null {
    if (!this.cfg?.enabled) return null;
    const refuse = (reason: string): MarketVerdict => ({ symbol, allowed: false, tracked: false, reasons: [reason], atrPct: null, turnoverUsd: null, spreadPct: null, bookCostPct: null, trades: 0, pf: null, netUsd: 0 });
    const maxAgeMs = Math.max(1, this.cfg.refreshMinutes) * 3 * 60_000;
    if (this.state.at > 0 && now - this.state.at > maxAgeMs) return refuse(`market verdicts are ${Math.round((now - this.state.at) / 60_000)} min old (refresh every ${this.cfg.refreshMinutes} min)`);
    const m = this.state.markets.find(m => m.symbol === symbol);
    if (!m) return refuse(this.state.at > 0 ? 'market not judged (outside the universe or below the turnover floor)' : 'markets not judged yet');
    return m;
  }

  /** The symbols worth a verdict: the ones given plus every perpetual above the turnover floor (so a market the bot is not yet on is judged too). */
  async universe(symbols: string[]): Promise<string[]> {
    const c = this.cfg;
    const out = new Set(symbols);
    try { for (const m of await this.deps.markets()) if (m.volume24h >= (c?.minTurnoverUsd ?? 0) && /USD$/.test(m.symbol) && (c?.cryptoOnly === false || isCrypto(m.description))) out.add(m.symbol); } catch { /* the given symbols still get judged */ }
    return [...out];
  }

  /** Recompute every verdict for the given symbols; `tracked` names the ones the bot actually scans (the fleet's and the incubator's), the rest are the liquid universe around them. */
  async refresh(symbols: string[], now = this.now(), tracked: Iterable<string> = symbols): Promise<MarketsToday> {
    const own = new Set(tracked);
    const c = this.cfg;
    const paper = this.deps.cfgRef().paper;
    if (!c?.enabled) { this.state = { at: now, enabled: false, markets: [] }; this.deps.db.kvSet(KV_KEY, this.state); return this.state; }
    let tickers = new Map<string, { volume24h: number; price: number; description?: string }>();
    try { tickers = new Map((await this.deps.markets()).map(m => [m.symbol, { volume24h: m.volume24h, price: m.price, description: m.description }])); }
    catch (e: any) { log.warn(`tickers unavailable: ${e?.message ?? e}; turnover not judged`); }
    const feeRoundTripPct = paper.feeRatePct * (1 + (paper.feeTaxPct ?? 0) / 100) * 2;
    const since = now - c.lookbackDays * 86_400_000;
    const list = [...new Set(symbols)].sort();
    const books = await this.readBooks(list.filter(s => !(c.exempt ?? []).includes(s)));
    const markets: MarketVerdict[] = [];
    for (const symbol of list) {
      if ((c.exempt ?? []).includes(symbol)) { markets.push({ symbol, allowed: true, tracked: own.has(symbol), reasons: ['exempt'], atrPct: null, turnoverUsd: null, spreadPct: null, bookCostPct: null, trades: 0, pf: null, netUsd: 0 }); continue; }
      const reasons: string[] = [];
      const t = tickers.get(symbol);
      const turnoverUsd = t ? t.volume24h : null;
      if (c.cryptoOnly !== false && t && !isCrypto(t.description)) reasons.push('not crypto: a tokenized stock, ETF or metal (crypto only, decision 60a)');
      if (turnoverUsd !== null && c.minTurnoverUsd > 0 && turnoverUsd < c.minTurnoverUsd) reasons.push(`dead: $${(turnoverUsd / 1e6).toFixed(2)}M 24h turnover < $${(c.minTurnoverUsd / 1e6).toFixed(2)}M`);
      const book = books.get(symbol) ?? null;
      const spreadPct = book?.spreadPct ?? null;
      const bookCostPct = book ? book.crossPct + feeRoundTripPct : null;
      const maxCost = c.maxBookCostPct ?? 0;
      if (book && !book.deep) reasons.push(`thin book: fewer than $${((c.probeNotionalUsd ?? 0) / 1000).toFixed(1)}k resting within ${book.levels} levels`);
      else if (bookCostPct !== null && maxCost > 0 && bookCostPct > maxCost) reasons.push(`costly book: ${bookCostPct.toFixed(3)}% round trip for $${((c.probeNotionalUsd ?? 0) / 1000).toFixed(1)}k (spread ${spreadPct!.toFixed(3)}%) > ${maxCost.toFixed(2)}%`);
      const roundTripPct = bookCostPct ?? feeRoundTripPct;
      let atrPct: number | null = null;
      const bars = this.deps.candles?.get(symbol, c.tf ?? '15m', { limit: 120, closedOnly: true }) ?? [];
      if (bars.length >= 30) {
        const a = atrSeries(bars, 14); const last = a[a.length - 1]; const px = bars[bars.length - 1].close;
        if (Number.isFinite(last) && px > 0) atrPct = last / px * 100;
      }
      // a check that could not run is a refusal, not a pass (decision 82): a failed ticker feed, an unread book or
      // a missing candle series must not turn an unknown market into permission to enter
      if (turnoverUsd === null && c.minTurnoverUsd > 0) reasons.push('unavailable: turnover not judged (ticker feed did not answer)');
      if (book === null && maxCost > 0) reasons.push('unavailable: order book not read');
      if (atrPct === null && c.minAtrFeeMult > 0 && own.has(symbol)) reasons.push(`unavailable: no ${c.tf ?? '15m'} candles for the volatility test`);
      if (atrPct !== null && c.minAtrFeeMult > 0 && atrPct < roundTripPct * c.minAtrFeeMult) reasons.push(`too quiet: ${c.tf ?? '15m'} ATR ${atrPct.toFixed(2)}% < ${(roundTripPct * c.minAtrFeeMult).toFixed(2)}% (${c.minAtrFeeMult}× the round trip${bookCostPct !== null ? ' on this book' : ' fee'})`);
      // the live book and its archive only: shadow trades belong to unproven scripts and say nothing about the market
      const rows = this.deps.db.all<{ pnl: number }>('SELECT realized_pnl - fees AS pnl FROM positions WHERE status=\'closed\' AND bt IN (0, -1) AND symbol=? AND exit_at>=?', symbol, since);
      const gp = rows.filter(r => r.pnl > 0).reduce((a, r) => a + r.pnl, 0), gl = -rows.filter(r => r.pnl <= 0).reduce((a, r) => a + r.pnl, 0);
      const pf = rows.length ? (gl > 0 ? gp / gl : gp > 0 ? 99 : 0) : null;
      if (rows.length >= c.minTrades && pf !== null && pf < c.minPf) reasons.push(`not paying: PF ${pf.toFixed(2)} over ${rows.length} trades in ${c.lookbackDays}d`);
      markets.push({ symbol, allowed: reasons.length === 0, tracked: own.has(symbol), reasons, atrPct, turnoverUsd, spreadPct, bookCostPct, trades: rows.length, pf, netUsd: gp - gl });
    }
    this.state = { at: now, enabled: true, markets };
    this.deps.db.kvSet(KV_KEY, this.state);
    const blocked = markets.filter(m => !m.allowed);
    log.info(`markets today: ${markets.length - blocked.length} allowed, ${blocked.length} blocked${blocked.length ? ` (${blocked.map(m => m.symbol).join(', ')})` : ''}`);
    return this.state;
  }

  /** Read every book a few at a time; a market whose book cannot be read simply gets no book opinion. */
  private async readBooks(symbols: string[]): Promise<Map<string, BookCost>> {
    const out = new Map<string, BookCost>();
    const c = this.cfg; const notional = c?.probeNotionalUsd ?? 0;
    if (!this.deps.book || notional <= 0) return out;
    const queue = [...symbols]; let failed = 0;
    const worker = async () => {
      for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
        try { const b = await this.deps.book!(s); const cost = walkBook(b, notional); if (cost) out.set(s, cost); }
        catch { failed++; }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (failed) log.warn(`${failed} order book(s) unreadable; those markets get no book opinion`);
    return out;
  }
}

interface BookCost { spreadPct: number; crossPct: number; deep: boolean; levels: number }

/**
 * What crossing the book costs for `notional` USD: buy up the asks, sell down the bids, and compare
 * the two average fills — that is the spread plus the slippage of both walks, as a share of the mid.
 * `deep` is false when either side runs out before the notional is filled.
 */
export function walkBook(book: { bids: Array<[number, number]>; asks: Array<[number, number]> }, notional: number): BookCost | null {
  const bids = book.bids.filter(l => l[0] > 0 && l[1] > 0).sort((a, b) => b[0] - a[0]);
  const asks = book.asks.filter(l => l[0] > 0 && l[1] > 0).sort((a, b) => a[0] - b[0]);
  if (!bids.length || !asks.length) return null;
  const mid = (bids[0][0] + asks[0][0]) / 2;
  if (!(mid > 0)) return null;
  const qty = notional / mid;
  const walk = (side: Array<[number, number]>) => {
    let got = 0, cost = 0;
    for (const [p, q] of side) { const take = Math.min(q, qty - got); cost += take * p; got += take; if (got >= qty) break; }
    return { avg: got > 0 ? cost / got : NaN, full: got >= qty * 0.999 };
  };
  const buy = walk(asks), sell = walk(bids);
  const crossPct = Number.isFinite(buy.avg) && Number.isFinite(sell.avg) ? (buy.avg - sell.avg) / mid * 100 : NaN;
  if (!Number.isFinite(crossPct)) return null;
  return { spreadPct: (asks[0][0] - bids[0][0]) / mid * 100, crossPct, deep: buy.full && sell.full, levels: Math.max(bids.length, asks.length) };
}
