/**
 * The context collector (decision 101): once an hour, one record per fleet market and one for the
 * market as a whole, from public sources (see sources.ts). Rows go to `market_context`; the latest
 * ones feed the dashboard's context bar and panel, the history feeds the variant tests that decide
 * whether any of it becomes a gate. Nothing here trades.
 */
import { logger } from '../log.ts';
import type { Db } from '../db.ts';
import type { DeltaRest } from '../delta/rest.ts';
import { aggregatePositions, biasOf, binanceRatios, coinOf, deltaFlow, hyperliquidBoard, hyperliquidContexts, hyperliquidPositions, selectCohort, sessionAt, type SmartMoney, type HlCoinCtx, type BinanceRatios, type DeltaFlow } from './sources.ts';

const log = logger.scoped('context');
export const CONTEXT_EVERY_MS = 60 * 60_000;
const COHORT_EVERY_MS = 24 * 60 * 60_000;

export interface MarketContext { symbol: string; coin: string; delta: DeltaFlow; hl: HlCoinCtx | null; smart: SmartMoney | null; binance: BinanceRatios | null }
export interface GlobalContext {
  at: number; session: string;
  bias: { BTC: { h4: number; d1: number }; ETH: { h4: number; d1: number } };
  /** Average funding across the fleet's markets (percent per interval): the crowded side. */
  fundingSkewPct: number | null;
  cohort: { wallets: number; refreshedAt: number | null };
  sources: Record<'delta' | 'hyperliquid' | 'binance', 'ok' | 'failed' | 'skipped'>;
}

export class ContextCollector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cohort: string[] = [];
  private cohortAt: number | null = null;
  private running = false;
  private d: { db: Db; rest: DeltaRest; symbols: () => string[] };
  constructor(d: { db: Db; rest: DeltaRest; symbols: () => string[] }) { this.d = d; }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce().catch(e => log.warn(`context run failed: ${e?.message ?? e}`)), CONTEXT_EVERY_MS);
    this.timer.unref?.();
    setTimeout(() => void this.runOnce().catch(e => log.warn(`context run failed: ${e?.message ?? e}`)), 20_000).unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** The latest record per market, plus the global one. */
  latest(): { global: GlobalContext | null; markets: MarketContext[] } {
    const rows = this.d.db.all<{ symbol: string; at: number; json: string }>('SELECT symbol, at, json FROM market_context WHERE at = (SELECT max(at) FROM market_context)');
    const g = rows.find(r => r.symbol === '*');
    return { global: g ? JSON.parse(g.json) : null, markets: rows.filter(r => r.symbol !== '*').map(r => JSON.parse(r.json)) };
  }
  history(symbol: string, hours = 24 * 7): Array<{ at: number } & MarketContext> {
    return this.d.db.all<{ at: number; json: string }>('SELECT at, json FROM market_context WHERE symbol=? AND at > ? ORDER BY at', symbol, Date.now() - hours * 3600_000).map(r => ({ at: r.at, ...JSON.parse(r.json) }));
  }

  async runOnce(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const symbols = this.d.symbols();
      const sources: GlobalContext['sources'] = { delta: 'skipped', hyperliquid: 'skipped', binance: 'skipped' };
      // Delta: the tickers we already poll
      let tickers = new Map<string, any>();
      try { tickers = new Map((await this.d.rest.tickers()).map(t => [t.symbol, t])); sources.delta = 'ok'; } catch (e: any) { sources.delta = 'failed'; log.warn(`delta tickers: ${e?.message ?? e}`); }
      // Hyperliquid: per-coin context, and the cohort's book
      let hl = new Map<string, HlCoinCtx>(); let smart = new Map<string, SmartMoney>();
      try {
        hl = await hyperliquidContexts();
        if (!this.cohortAt || now - this.cohortAt > COHORT_EVERY_MS) {
          const board = selectCohort(await hyperliquidBoard());
          this.cohort = board.map(r => r.address); this.cohortAt = now;
          log.info(`smart-money cohort refreshed: ${this.cohort.length} wallets`);
        }
        const books: Awaited<ReturnType<typeof hyperliquidPositions>>[] = [];
        for (const a of this.cohort) {
          try { books.push(await hyperliquidPositions(a)); } catch { /* one wallet missing is fine */ }
          await new Promise(r => setTimeout(r, 120));   // polite: well under Hyperliquid's public limit
        }
        smart = aggregatePositions(books);
        sources.hyperliquid = 'ok';
      } catch (e: any) { sources.hyperliquid = 'failed'; log.warn(`hyperliquid: ${e?.message ?? e}`); }
      // Binance: ratios per coin
      const bn = new Map<string, BinanceRatios>();
      try {
        for (const s of symbols) { bn.set(s, await binanceRatios(coinOf(s))); await new Promise(r => setTimeout(r, 150)); }
        sources.binance = bn.size ? 'ok' : 'skipped';
      } catch (e: any) { sources.binance = 'failed'; log.warn(`binance: ${e?.message ?? e}`); }
      // bias on the two majors, from closed bars the exchange serves
      const bias = async (symbol: string, tf: string, sec: number) => { try { const c = await this.d.rest.recentCandles(symbol, tf, 80, sec); return biasOf(c.slice(0, -1)); } catch { return 0 as const; } };
      const g: GlobalContext = {
        at: now, session: sessionAt(now),
        bias: { BTC: { h4: await bias('BTCUSD', '4h', 14400), d1: await bias('BTCUSD', '1d', 86400) }, ETH: { h4: await bias('ETHUSD', '4h', 14400), d1: await bias('ETHUSD', '1d', 86400) } },
        fundingSkewPct: null, cohort: { wallets: this.cohort.length, refreshedAt: this.cohortAt }, sources,
      };
      const rows: MarketContext[] = [];
      const fundings: number[] = [];
      for (const s of symbols) {
        const coin = coinOf(s); const dl = deltaFlow(tickers.get(s));
        if (dl.fundingPct !== null) fundings.push(dl.fundingPct);
        rows.push({ symbol: s, coin, delta: dl, hl: hl.get(coin) ?? null, smart: smart.get(coin) ?? null, binance: bn.get(s) ?? null });
      }
      g.fundingSkewPct = fundings.length ? fundings.reduce((a, b) => a + b, 0) / fundings.length : null;
      const tx = this.d.db;
      tx.run('INSERT OR REPLACE INTO market_context(at, symbol, json) VALUES (?,?,?)', now, '*', JSON.stringify(g));
      for (const r of rows) tx.run('INSERT OR REPLACE INTO market_context(at, symbol, json) VALUES (?,?,?)', now, r.symbol, JSON.stringify(r));
      tx.run('DELETE FROM market_context WHERE at < ?', now - 120 * 86400_000);
      log.info(`context: ${rows.length} markets · cohort ${this.cohort.length} · BTC ${g.bias.BTC.h4}/${g.bias.BTC.d1} · funding ${g.fundingSkewPct?.toFixed(4) ?? '–'} · sources ${Object.entries(sources).map(([k, v]) => `${k}:${v}`).join(' ')}`);
    } finally { this.running = false; }
  }
}
