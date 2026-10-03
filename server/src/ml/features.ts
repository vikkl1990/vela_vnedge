/**
 * Entry-time feature extraction for trade learning. Everything is computed from the closed
 * bars available at the entry bar (no look-ahead) plus the signal itself.
 */
import type { Bar } from '../data/candleStore.ts';
import type { ScanEvent } from '../scanners/extractor.ts';

export const FEATURE_NAMES = [
  'side_long', 'score', 'has_score', 'hour', 'dow', 'atr_pct', 'sl_atr', 'tp1_rr', 'ret5', 'ret20',
  'trend50', 'trend200', 'vol_ratio', 'range_pos', 'lvl_script', 'src_alert', 'src_shape', 'src_derived', 'src_cond',
  'burst3', 'bar_range_atr', 'er20', 'chop14',
  'adx14', 'day_range_used',
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];
export type Features = Record<FeatureName, number>;

/** Human descriptions for insights. */
export const FEATURE_LABELS: Record<FeatureName, string> = {
  side_long: 'direction (long=1)', score: 'script score', has_score: 'score published', hour: 'hour (UTC)', dow: 'weekday (0=Sun)',
  atr_pct: 'ATR % of price', sl_atr: 'stop distance (ATR)', tp1_rr: 'TP1 reward:risk', ret5: '5-bar return %', ret20: '20-bar return %',
  trend50: 'price vs EMA50 (ATR)', trend200: 'price vs EMA200 (ATR)', vol_ratio: 'volume / 20-bar avg', range_pos: 'position in 20-bar range',
  lvl_script: 'levels from script', src_alert: 'signal via alert()', src_shape: 'signal via plotshape', src_derived: 'signal via rule', src_cond: 'signal via alertcondition',
  burst3: 'move over the 3 bars before entry, with the trade (ATR)', bar_range_atr: 'signal bar range (ATR)', er20: 'Kaufman efficiency ratio, 20 bars (1 = straight line)', chop14: 'choppiness index, 14 bars (0–100)',
  adx14: 'ADX(14) trend strength (0–100)', day_range_used: "today's range so far over the average of the last UTC days' ranges",
};

function ema(bars: Bar[], i: number, len: number): number | undefined {
  if (i + 1 < len) return undefined;
  const k = 2 / (len + 1);
  let e = bars[i - len + 1].close;
  for (let j = i - len + 2; j <= i; j++) e = bars[j].close * k + e * (1 - k);
  return e;
}

/** Wilder's ADX over `len` bars at bar i, seeded the way TradingView does; undefined until there is a double warm-up. */
export function adx(bars: Bar[], i: number, len = 14): number | undefined {
  const start = Math.max(1, i - len * 8);
  if (i - start < len * 2) return undefined;
  const a = 1 / len;
  let trS = 0, pS = 0, mS = 0, k = 0, dxS = 0, dxN = 0, out: number | undefined;
  for (let j = start; j <= i; j++) {
    const b = bars[j], p = bars[j - 1];
    const tr = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    const up = b.high - p.high, dn = p.low - b.low;
    const pdm = up > dn && up > 0 ? up : 0, mdm = dn > up && dn > 0 ? dn : 0;
    k++;
    if (k <= len) { trS += tr; pS += pdm; mS += mdm; if (k < len) continue; }
    else { trS += tr - trS * a; pS += pdm - pS * a; mS += mdm - mS * a; }
    const pdi = trS > 0 ? 100 * pS / trS : 0, mdi = trS > 0 ? 100 * mS / trS : 0;
    const dx = pdi + mdi > 0 ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
    if (out === undefined) { dxS += dx; dxN++; if (dxN === len) out = dxS / len; }
    else out += (dx - out) * a;
  }
  return out;
}

/**
 * How much of a normal day's range today has already used at bar i: the UTC day's high–low so far
 * over the mean range of the last complete UTC days (up to 20, at least 5). Built from the closed
 * bars themselves, so it never sees the day's later extremes (the ADR script's lookahead leak).
 */
export function dayRangeUsed(bars: Bar[], i: number, days = 20): number | undefined {
  if (!bars[i]) return undefined;
  const dayOf = (t: number) => Math.floor(t / 86_400_000);
  const today = dayOf(bars[i].time);
  const ranges: number[] = [];
  let cur = today, hi = -Infinity, lo = Infinity, todayRange = 0;
  for (let j = i; j >= 0; j--) {
    const d = dayOf(bars[j].time);
    if (d !== cur) {
      if (cur === today) todayRange = hi - lo; else ranges.push(hi - lo);
      if (ranges.length >= days) break;
      cur = d; hi = -Infinity; lo = Infinity;
    }
    hi = Math.max(hi, bars[j].high); lo = Math.min(lo, bars[j].low);
  }
  if (cur === today) return undefined; // the history does not even reach yesterday
  if (ranges.length < 5) return undefined;
  const adr = ranges.reduce((s, r) => s + r, 0) / ranges.length;
  return adr > 0 ? todayRange / adr : undefined;
}

export interface FeatureInputs {
  bars: Bar[];           // ascending closed bars
  i: number;             // index of the entry bar
  ev: Pick<ScanEvent, 'side' | 'score' | 'source'>;
  entry: number; sl: number; tp1?: number; atr: number; levelsSource: string;
}

export function computeFeatures(inp: FeatureInputs): Features {
  const { bars, i } = inp;
  const b = bars[i];
  const c = b?.close ?? inp.entry;
  const atr = inp.atr > 0 ? inp.atr : Math.max(1e-9, c * 0.005);
  const d = new Date(b?.time ?? Date.now());
  const risk = Math.abs(inp.entry - inp.sl);
  const closeAt = (n: number) => bars[Math.max(0, i - n)]?.close ?? c;
  const e50 = ema(bars, i, 50); const e200 = ema(bars, i, 200);
  let hi = -Infinity, lo = Infinity, volSum = 0, volN = 0;
  for (let j = Math.max(0, i - 19); j <= i; j++) { hi = Math.max(hi, bars[j].high); lo = Math.min(lo, bars[j].low); volSum += bars[j].volume; volN++; }
  const volAvg = volN ? volSum / volN : 0;
  // regime and chase (decision 65): the stop study found first-bar stops follow a burst into the entry,
  // and the composites check wanted a trend/range reading — both recorded at entry so the journal can split by them
  const dir = inp.ev.side === 'short' ? -1 : 1;
  const burst3 = i >= 3 ? ((c - bars[i - 3].close) * dir) / atr : 0;
  const barRangeAtr = b ? (b.high - b.low) / atr : 0;
  let er20 = 0;
  if (i >= 20) { let vol = 0; for (let j = i - 19; j <= i; j++) vol += Math.abs(bars[j].close - bars[j - 1].close); const chg = Math.abs(c - bars[i - 20].close); er20 = vol > 0 ? chg / vol : 0; }
  let chop14 = 50;
  if (i >= 14) {
    let trSum = 0, hh = -Infinity, ll = Infinity;
    for (let j = i - 13; j <= i; j++) { const pc = bars[j - 1].close; trSum += Math.max(bars[j].high - bars[j].low, Math.abs(bars[j].high - pc), Math.abs(bars[j].low - pc)); hh = Math.max(hh, bars[j].high); ll = Math.min(ll, bars[j].low); }
    if (hh > ll && trSum > 0) chop14 = 100 * Math.log10(trSum / (hh - ll)) / Math.log10(14);
  }
  return {
    side_long: inp.ev.side === 'long' ? 1 : 0,
    score: inp.ev.score !== undefined && Number.isFinite(inp.ev.score) ? Math.max(0, Math.min(100, inp.ev.score)) : 0,
    has_score: inp.ev.score !== undefined && Number.isFinite(inp.ev.score) ? 1 : 0,
    hour: d.getUTCHours(),
    dow: d.getUTCDay(),
    atr_pct: (atr / c) * 100,
    sl_atr: risk / atr,
    tp1_rr: inp.tp1 !== undefined && risk > 0 ? Math.abs(inp.tp1 - inp.entry) / risk : 0,
    ret5: (c / closeAt(5) - 1) * 100,
    ret20: (c / closeAt(20) - 1) * 100,
    trend50: e50 !== undefined ? (c - e50) / atr : 0,
    trend200: e200 !== undefined ? (c - e200) / atr : 0,
    vol_ratio: volAvg > 0 ? (b?.volume ?? 0) / volAvg : 1,
    range_pos: hi > lo ? (c - lo) / (hi - lo) : 0.5,
    lvl_script: inp.levelsSource === 'script' ? 1 : inp.levelsSource === 'mixed' ? 0.5 : 0,
    src_alert: inp.ev.source === 'alert' ? 1 : 0,
    src_shape: inp.ev.source === 'shape' ? 1 : 0,
    src_derived: inp.ev.source === 'derived' ? 1 : 0,
    src_cond: inp.ev.source === 'alertcondition' ? 1 : 0,
    burst3, bar_range_atr: barRangeAtr, er20, chop14,
    adx14: adx(bars, i) ?? 0, day_range_used: dayRangeUsed(bars, i) ?? 0,
  };
}

export function featureVector(f: Features): number[] {
  return FEATURE_NAMES.map(n => { const v = f[n]; return Number.isFinite(v) ? v : 0; });
}
