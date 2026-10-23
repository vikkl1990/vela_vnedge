/**
 * Decision 178: three exit models from the Vela library (© LuxAlgo, CC BY-NC-SA 4.0 — non-commercial use, which
 * this study is), ported from their Pine so the account's exits can be measured against them on the same trades.
 * Each produces, per signal bar, what `TrailModel` needs; the backtest applies it after the bar's fills, exactly
 * where the account's own trail is applied. The account's ATR stop sets where every stop starts; the model only
 * says how it moves.
 *
 *   - Sigmoid Transition Trailing Stop: an ATR(200) stop that converges toward price along an S-curve once the
 *     gap opens past 3 ATR (per-position state, computed inside `modelTrail`; here only its ATR series).
 *   - Statistical Trailing Stop: the stop sits `delta` below hlc3, with delta = exp(mean + k·sd) of log TR(10)
 *     over 100 bars — the k-th level of the log-normal distribution of grouped volatility (Level 2 by default).
 *   - Market Structure Trailing Stop: on a bullish CHoCH the stop resets to the local low of the broken leg,
 *     then rises by every new high in the running max close (increment 100%); mirrored for shorts.
 */
import type { Bar } from '../data/candleStore.ts';
import type { TrailModel } from './logic.ts';

/** Wilder ATR over `length` bars, NaN until it is formed. */
export function atrOf(bars: Bar[], length: number): number[] {
  const out = new Array<number>(bars.length).fill(NaN);
  let sum = 0, atr = NaN;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1];
    const tr = prev ? Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close)) : b.high - b.low;
    if (i < length) { sum += tr; if (i === length - 1) atr = sum / length; }
    else atr = (atr * (length - 1) + tr) / length;
    out[i] = atr;
  }
  return out;
}

/** The Statistical Trailing Stop's distance per bar (null until the distribution is formed). */
export function statDeltaSeries(bars: Bar[], level = 2, dataLength = 10, distributionLength = 100): Array<number | null> {
  const out: Array<number | null> = new Array(bars.length).fill(null);
  const logs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < dataLength + 1) { logs.push(NaN); continue; }
    let hi = -Infinity, lo = Infinity;
    for (let k = i - dataLength + 1; k <= i; k++) { hi = Math.max(hi, bars[k].high); lo = Math.min(lo, bars[k].low); }
    const ref = bars[i - dataLength - 1].close;
    const tr = Math.max(hi - lo, Math.abs(hi - ref), Math.abs(lo - ref));
    logs.push(tr > 0 ? Math.log(tr) : NaN);
    if (i < dataLength + distributionLength) continue;
    const w = logs.slice(i - distributionLength + 1, i + 1).filter(Number.isFinite);
    if (w.length < distributionLength / 2) continue;
    const mean = w.reduce((a, b) => a + b, 0) / w.length;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / w.length);
    out[i] = Math.exp(mean + level * sd);
  }
  return out;
}

export interface StructureLevel { long: number | null; short: number | null }

/**
 * The Market Structure Trailing Stop, one bar at a time (the live engine feeds it the closed bars of a market and
 * timeframe; the backtest feeds it a series). Pivots confirm `length` bars after the fact, as `ta.pivothigh(length,
 * length)` reports them; in 'CHoCH' mode only a change of character (a break against the standing structure) resets
 * the stop — the first break of a structure that was never the other way sets none, exactly as the Pine does.
 */
export class MarketStructureTrail {
  private window: Bar[] = [];
  private phY = NaN; private phX = -1; private plY = NaN; private plX = -1; private phCross = false; private plCross = false;
  private top = NaN; private btm = NaN; private max = NaN; private min = NaN; private ts = NaN; private os = 0;
  private n = -1;
  private history: Bar[] = [];
  /** The last bar pushed, so a bar seen twice (a seed then the live close) is not counted twice. */
  lastTime = -Infinity;
  readonly length: number;
  readonly incrPct: number;
  constructor(length = 14, incrPct = 100) { this.length = length; this.incrPct = incrPct; }

  get level(): StructureLevel {
    const level = Number.isFinite(this.ts) ? this.ts : null;
    return { long: this.os === 1 ? level : null, short: this.os === -1 ? level : null };
  }

  push(bar: Bar): StructureLevel {
    if (bar.time <= this.lastTime) return this.level;
    this.lastTime = bar.time;
    const L = this.length;
    this.n++;
    this.history.push(bar);
    // the local extreme of a broken leg is searched from the pivot's bar; keep what that can need
    if (this.history.length > 4 * L + 2 && this.history.length > this.n - Math.min(this.phX, this.plX) + 2) {
      const keep = Math.max(2 * L + 1, this.n - Math.min(this.phX < 0 ? this.n : this.phX, this.plX < 0 ? this.n : this.plX) + 1);
      if (this.history.length > keep + 64) this.history.splice(0, this.history.length - keep);
    }
    const at = (i: number) => this.history[this.history.length - 1 - (this.n - i)];
    if (this.n >= 2 * L) {
      const c = this.n - L;
      let isHigh = true, isLow = true;
      const cb = at(c);
      for (let k = this.n - 2 * L; k <= this.n; k++) {
        if (k === c) continue;
        const kb = at(k);
        if (kb.high >= cb.high) isHigh = false;
        if (kb.low <= cb.low) isLow = false;
      }
      if (isHigh) { this.phY = cb.high; this.phX = c; this.phCross = false; }
      if (isLow) { this.plY = cb.low; this.plX = c; this.plCross = false; }
    }
    const close = bar.close;
    let ms = 0;
    if (Number.isFinite(this.phY) && close > this.phY && !this.phCross) {
      ms = this.os === -1 ? 1 : 0; this.phCross = true; this.os = 1;
      this.btm = bar.low; for (let i = Math.max(this.phX, this.n - this.history.length + 1); i <= this.n; i++) this.btm = Math.min(this.btm, at(i).low);
    }
    if (Number.isFinite(this.plY) && close < this.plY && !this.plCross) {
      ms = this.os === 1 ? -1 : 0; this.plCross = true; this.os = -1;
      this.top = bar.high; for (let i = Math.max(this.plX, this.n - this.history.length + 1); i <= this.n; i++) this.top = Math.max(this.top, at(i).high);
    }
    const prevMax = this.max, prevMin = this.min;
    if (ms === 1) this.max = close;
    else if (ms === -1) this.min = close;
    else { this.max = Number.isFinite(this.max) ? Math.max(close, this.max) : close; this.min = Number.isFinite(this.min) ? Math.min(close, this.min) : close; }
    if (ms === 1) this.ts = this.btm;
    else if (ms === -1) this.ts = this.top;
    else if (this.os === 1 && Number.isFinite(this.ts) && Number.isFinite(prevMax)) this.ts += (this.max - prevMax) * this.incrPct / 100;
    else if (this.os === -1 && Number.isFinite(this.ts) && Number.isFinite(prevMin)) this.ts += (this.min - prevMin) * this.incrPct / 100;
    return this.level;
  }
}

/** The Market Structure Trailing Stop's level per bar for a long and for a short (null while the structure has not spoken). */
export function marketStructureStops(bars: Bar[], length = 14, incrPct = 100): StructureLevel[] {
  const t = new MarketStructureTrail(length, incrPct);
  return bars.map(b => ({ ...t.push(b) }));
}

/** The three models as `trailModel` factories for the backtest, built once per bar series. */
export function luxTrailModels(bars: Bar[]) {
  const atr200 = atrOf(bars, 200);
  const stat1 = statDeltaSeries(bars, 1), stat2 = statDeltaSeries(bars, 2);
  const ms = marketStructureStops(bars);
  const hlc3 = (i: number) => (bars[i].high + bars[i].low + bars[i].close) / 3;
  const statModel = (delta: Array<number | null>) => (i: number): TrailModel | null => {
    const d = delta[i]; if (d == null) return null;
    return { level: { long: hlc3(i) - d, short: hlc3(i) + d } };
  };
  return {
    sigmoid: (i: number): TrailModel | null => Number.isFinite(atr200[i]) ? { sigmoid: { atr: atr200[i], atrMult: 3, sigLength: 20, sigAmp: 3, minDist: 0.5 } } : null,
    stat1: statModel(stat1),
    stat2: statModel(stat2),
    ms: (i: number): TrailModel | null => ms[i].long === null && ms[i].short === null ? null : { level: ms[i] },
  };
}
