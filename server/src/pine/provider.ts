import { TF_SECONDS, pineTfToDelta } from '../config.ts';

/** Candle shape PineTS expects from a provider (`Kline`). */
export interface Kline {
  openTime: number; closeTime: number; open: number; high: number; low: number; close: number; volume: number;
  quoteAssetVolume: number; numberOfTrades: number; takerBuyBaseAssetVolume: number; takerBuyQuoteAssetVolume: number; ignore: number;
}

export interface ProviderBar { time: number; open: number; high: number; low: number; close: number; volume: number }

export interface DeltaPineProviderOptions {
  symbol: string;
  /** Delta resolution of the primary series, e.g. '15m'. */
  tf: string;
  /** Primary series bars (ascending, closed bars only for live scanning). */
  bars: ProviderBar[];
  tickSize: number;
  description?: string;
  /** Fetch bars for another timeframe (used by `request.security`). Returns ascending bars. */
  fetchOther?: (symbol: string, deltaTf: string, bars: number, endMs: number) => Promise<ProviderBar[]>;
}

export function toKlines(bars: ProviderBar[], tfSeconds: number): Kline[] {
  return bars.map(b => ({
    openTime: b.time, closeTime: b.time + tfSeconds * 1000, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    quoteAssetVolume: 0, numberOfTrades: 0, takerBuyBaseAssetVolume: 0, takerBuyQuoteAssetVolume: 0, ignore: 0,
  }));
}

/**
 * The Delta market a Pine ticker id names. The exchange prefix is dropped and the usual perpetual
 * spellings (`BINANCE:ETHUSDT`, `ETHUSDT.P`) map to Delta's `ETHUSD`: close enough for an indicator
 * input, and far better than the alternative this replaces, which silently served the scanner's
 * own market for every requested symbol. An empty id means the scanner's own market.
 */
export function deltaSymbolFor(tickerId: string | undefined, primary: string): string {
  return parseTicker(tickerId, primary).symbol;
}

/**
 * Split a Pine ticker id into the Delta market and its chart-type modifier. `BTCUSD;HEIKINASHI`
 * (what `ticker.heikinashi()` produces) asks for the same market drawn as Heikin-Ashi candles; the
 * other chart types (Renko, Kagi, point & figure, line break, range) cannot be derived from time
 * bars and are refused rather than silently served as ordinary candles.
 */
export function parseTicker(tickerId: string | undefined, primary: string): { symbol: string; modifier: string | null } {
  const raw = String(tickerId ?? '').trim();
  if (!raw) return { symbol: primary.toUpperCase(), modifier: null };
  const [head, ...rest] = raw.split(';');
  const sym = (head.includes(':') ? head.slice(head.lastIndexOf(':') + 1) : head).toUpperCase().replace(/\.P$/, '');
  return { symbol: sym.replace(/USDT$/, 'USD'), modifier: rest.length ? rest.join(';').toUpperCase() : null };
}

/** Heikin-Ashi candles from ordinary ones: averaged open/close, extremes spanning both. */
export function toHeikinAshi(kl: Kline[]): Kline[] {
  let prevOpen = 0, prevClose = 0;
  return kl.map((k, i) => {
    const close = (k.open + k.high + k.low + k.close) / 4;
    const open = i === 0 ? (k.open + k.close) / 2 : (prevOpen + prevClose) / 2;
    prevOpen = open; prevClose = close;
    return { ...k, open, close, high: Math.max(k.high, open, close), low: Math.min(k.low, open, close) };
  });
}

/**
 * PineTS `IProvider` backed by in-memory Delta candles. Serves the primary timeframe from
 * `bars`; other timeframes requested via `request.security()` go through `fetchOther`
 * (already-cached REST candles in the worker), clipped so no future data leaks past the
 * last primary bar.
 */
export class DeltaPineProvider {
  private opts: DeltaPineProviderOptions;
  private primaryPineTf: string;
  private cache = new Map<string, Kline[]>();

  constructor(opts: DeltaPineProviderOptions) {
    this.opts = opts;
    this.primaryPineTf = String(TF_SECONDS[opts.tf] / 60);
    if (opts.tf === '1d') this.primaryPineTf = 'D';
  }

  configure(): void { /* keyless */ }

  async getMarketData(tickerId: string, timeframe: string, limit?: number): Promise<Kline[]> {
    const tf = String(timeframe ?? this.primaryPineTf);
    const { symbol, modifier } = parseTicker(tickerId, this.opts.symbol);
    if (modifier && modifier !== 'HEIKINASHI') throw new Error(`request.security(${tickerId}): ${modifier} charts are not supported`);
    const shape = (kl: Kline[]) => (modifier === 'HEIKINASHI' ? toHeikinAshi(kl) : kl);
    const own = symbol === this.opts.symbol.toUpperCase();
    const sameTf = !pineTfToDelta(tf) || pineTfToDelta(tf) === this.opts.tf || tf === this.primaryPineTf;
    const deltaTf = sameTf ? this.opts.tf : pineTfToDelta(tf)!;
    const lastMs = this.opts.bars.at(-1)?.time ?? Date.now();
    if (own && sameTf) {
      const kl = shape(toKlines(this.opts.bars, TF_SECONDS[this.opts.tf]));
      return limit ? kl.slice(-limit) : kl;
    }
    const monthsM = deltaTf.match(/^(\d+)M$/);
    const months = monthsM ? Number(monthsM[1]) : 0;
    const secs = TF_SECONDS[deltaTf] ?? (deltaTf === '1w' ? 604800 : months ? 2592000 * months : undefined);
    if (!secs) return [];
    const key = `${symbol}:${deltaTf}:${modifier ?? ''}:${lastMs}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    if (!this.opts.fetchOther) {
      if (!own) throw new Error(`request.security(${tickerId}): no data source for another market`);
      return [];
    }
    const span = this.opts.bars.length * TF_SECONDS[this.opts.tf];
    let raw: ProviderBar[] = [];
    try {
      if (months) {
        // Delta serves no monthly candles: aggregate daily bars into calendar months (UTC).
        const days = await this.opts.fetchOther(symbol, '1d', Math.min(4000, Math.max(400, Math.ceil(span / 86400) + 400)), lastMs + TF_SECONDS[this.opts.tf] * 1000);
        raw = aggregateMonthly(days, months);
      } else {
        const want = Math.min(4000, Math.max(300, Math.ceil(span / secs) + 300));
        raw = await this.opts.fetchOther(symbol, deltaTf, want, lastMs + TF_SECONDS[this.opts.tf] * 1000);
      }
    } catch {
      raw = [];
    }
    // A market Delta does not list (an index, a stock, on-chain data) must fail the run, not quietly
    // compute the script's logic on the wrong series.
    if (!own && raw.length === 0) throw new Error(`request.security(${tickerId}): ${symbol} is not a Delta market; external series are not supported`);
    // Only bars that opened at or before the last primary bar (no look-ahead beyond the current HTF bar).
    const bars = raw.filter(b => b.time <= lastMs);
    const kl = shape(months ? toMonthlyKlines(bars, months) : toKlines(bars, secs));
    this.cache.set(key, kl);
    return limit ? kl.slice(-limit) : kl;
  }

  async getSymbolInfo(tickerId: string) {
    const tick = this.opts.tickSize || 0.5;
    const pricescale = Math.round(1 / tick);
    const sym = tickerId.replace(/^DELTA:/i, '');
    const base = sym.replace(/USDT?$/i, '');
    return {
      current_contract: '', description: this.opts.description ?? `${base} Perpetual`, isin: '',
      main_tickerid: `DELTA:${sym}`, prefix: 'DELTA', root: sym, ticker: sym, tickerid: `DELTA:${sym}`, type: 'crypto',
      basecurrency: base, country: '', currency: 'USD', timezone: 'Etc/UTC', employees: 0, industry: '', sector: '',
      shareholders: 0, shares_outstanding_float: 0, shares_outstanding_total: 0, expiration_date: 0, session: '24x7', volumetype: 'base',
      mincontract: 1, minmove: 1, mintick: tick, pointvalue: 1, pricescale,
      recommendations_buy: 0, recommendations_buy_strong: 0, recommendations_date: 0, recommendations_hold: 0, recommendations_sell: 0,
      recommendations_sell_strong: 0, recommendations_total: 0, target_price_average: 0, target_price_date: 0, target_price_estimates: 0,
      target_price_high: 0, target_price_low: 0, target_price_median: 0,
    };
  }
}

/** Aggregate daily bars into calendar buckets of `months` months (1 = monthly, 3 = quarterly, 12 = yearly), UTC. */
export function aggregateMonthly(days: ProviderBar[], months = 1): ProviderBar[] {
  const out: ProviderBar[] = [];
  let cur: ProviderBar | null = null; let curKey = '';
  for (const d of days) {
    const dt = new Date(d.time);
    const bucket = Math.floor(dt.getUTCMonth() / months) * months;
    const key = `${dt.getUTCFullYear()}-${bucket}`;
    if (!cur || key !== curKey) { cur = { time: Date.UTC(dt.getUTCFullYear(), bucket, 1), open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume }; curKey = key; out.push(cur); continue; }
    cur.high = Math.max(cur.high, d.high); cur.low = Math.min(cur.low, d.low); cur.close = d.close; cur.volume += d.volume;
  }
  return out;
}

function toMonthlyKlines(bars: ProviderBar[], months = 1): Kline[] {
  return bars.map(b => {
    const dt = new Date(b.time);
    const closeTime = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + months, 1);
    return { openTime: b.time, closeTime, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, quoteAssetVolume: 0, numberOfTrades: 0, takerBuyBaseAssetVolume: 0, takerBuyQuoteAssetVolume: 0, ignore: 0 };
  });
}
