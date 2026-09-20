/**
 * Entry-time feature extraction for trade learning. Everything is computed from the closed
 * bars available at the entry bar (no look-ahead) plus the signal itself.
 */
import type { Bar } from '../data/candleStore.ts';
import type { ScanEvent } from '../scanners/extractor.ts';

export const FEATURE_NAMES = [
  'side_long', 'score', 'has_score', 'hour', 'dow', 'atr_pct', 'sl_atr', 'tp1_rr', 'ret5', 'ret20',
  'trend50', 'trend200', 'vol_ratio', 'range_pos', 'lvl_script', 'src_alert', 'src_shape', 'src_derived', 'src_cond',
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];
export type Features = Record<FeatureName, number>;

/** Human descriptions for insights. */
export const FEATURE_LABELS: Record<FeatureName, string> = {
  side_long: 'direction (long=1)', score: 'script score', has_score: 'score published', hour: 'hour (UTC)', dow: 'weekday (0=Sun)',
  atr_pct: 'ATR % of price', sl_atr: 'stop distance (ATR)', tp1_rr: 'TP1 reward:risk', ret5: '5-bar return %', ret20: '20-bar return %',
  trend50: 'price vs EMA50 (ATR)', trend200: 'price vs EMA200 (ATR)', vol_ratio: 'volume / 20-bar avg', range_pos: 'position in 20-bar range',
  lvl_script: 'levels from script', src_alert: 'signal via alert()', src_shape: 'signal via plotshape', src_derived: 'signal via rule', src_cond: 'signal via alertcondition',
};

function ema(bars: Bar[], i: number, len: number): number | undefined {
  if (i + 1 < len) return undefined;
  const k = 2 / (len + 1);
  let e = bars[i - len + 1].close;
  for (let j = i - len + 2; j <= i; j++) e = bars[j].close * k + e * (1 - k);
  return e;
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
  };
}

export function featureVector(f: Features): number[] {
  return FEATURE_NAMES.map(n => { const v = f[n]; return Number.isFinite(v) ? v : 0; });
}
