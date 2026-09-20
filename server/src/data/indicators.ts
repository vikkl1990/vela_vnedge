import type { Bar } from './candleStore.ts';

/** Wilder ATR over the whole series; returns the ATR at each bar (NaN until warm). */
export function atrSeries(bars: Bar[], length = 14): number[] {
  const out = new Array<number>(bars.length).fill(NaN);
  if (bars.length < 2) return out;
  let sum = 0; let atr = NaN;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    const tr = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    if (i <= length) { sum += tr; if (i === length) { atr = sum / length; out[i] = atr; } continue; }
    atr = (atr * (length - 1) + tr) / length;
    out[i] = atr;
  }
  return out;
}

export function lastAtr(bars: Bar[], length = 14): number | undefined {
  const s = atrSeries(bars, length);
  for (let i = s.length - 1; i >= 0; i--) if (Number.isFinite(s[i])) return s[i];
  return undefined;
}
