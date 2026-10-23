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

/** The Market Structure Trailing Stop's level per bar for a long and for a short (null while the structure has not spoken). */
export function marketStructureStops(bars: Bar[], length = 14, incrPct = 100): Array<{ long: number | null; short: number | null }> {
  const out: Array<{ long: number | null; short: number | null }> = [];
  let phY = NaN, phX = -1, plY = NaN, plX = -1, phCross = false, plCross = false;
  let top = NaN, btm = NaN, max = NaN, min = NaN, ts = NaN, os = 0;
  let prevMax = NaN, prevMin = NaN;
  for (let n = 0; n < bars.length; n++) {
    // pivots confirmed `length` bars after the fact, as ta.pivothigh(length, length) reports them
    if (n >= 2 * length) {
      const c = n - length;
      let isHigh = true, isLow = true;
      for (let k = n - 2 * length; k <= n; k++) {
        if (k === c) continue;
        if (bars[k].high >= bars[c].high) isHigh = false;
        if (bars[k].low <= bars[c].low) isLow = false;
      }
      if (isHigh) { phY = bars[c].high; phX = c; phCross = false; }
      if (isLow) { plY = bars[c].low; plX = c; plCross = false; }
    }
    const close = bars[n].close;
    let ms = 0;
    if (Number.isFinite(phY) && close > phY && !phCross) {
      ms = os === -1 ? 1 : 0; phCross = true; os = 1;
      btm = bars[n].low; for (let i = phX; i <= n; i++) btm = Math.min(btm, bars[i].low);
    }
    if (Number.isFinite(plY) && close < plY && !plCross) {
      ms = os === 1 ? -1 : 0; plCross = true; os = -1;
      top = bars[n].high; for (let i = plX; i <= n; i++) top = Math.max(top, bars[i].high);
    }
    prevMax = max; prevMin = min;
    if (ms === 1) max = close;
    else if (ms === -1) min = close;
    else { max = Number.isFinite(max) ? Math.max(close, max) : close; min = Number.isFinite(min) ? Math.min(close, min) : close; }
    if (ms === 1) ts = btm;
    else if (ms === -1) ts = top;
    else if (os === 1 && Number.isFinite(ts) && Number.isFinite(prevMax)) ts = ts + (max - prevMax) * incrPct / 100;
    else if (os === -1 && Number.isFinite(ts) && Number.isFinite(prevMin)) ts = ts + (min - prevMin) * incrPct / 100;
    const level = Number.isFinite(ts) ? ts : null;
    out.push({ long: os === 1 ? level : null, short: os === -1 ? level : null });
  }
  return out;
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
