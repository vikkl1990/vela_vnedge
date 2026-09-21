/** Rolling close-to-close return correlation between two bar series aligned on bar time (phase 3 BTC-beta cap). */
import type { Bar } from '../data/candleStore.ts';

/** Pearson correlation of log returns over the last `n` common bars; null when fewer than 5 overlap or a series is flat. */
export function returnCorrelation(a: Bar[], b: Bar[], n: number): number | null {
  const byTime = new Map<number, number>();
  for (const bar of b) if (bar.close > 0) byTime.set(bar.time, bar.close);
  const pairs: Array<[number, number]> = [];
  for (const bar of a) { const other = byTime.get(bar.time); if (other !== undefined && bar.close > 0) pairs.push([bar.close, other]); }
  const tail = pairs.slice(-(n + 1));
  if (tail.length < 6) return null;
  const ra: number[] = [], rb: number[] = [];
  for (let i = 1; i < tail.length; i++) { ra.push(Math.log(tail[i][0] / tail[i - 1][0])); rb.push(Math.log(tail[i][1] / tail[i - 1][1])); }
  return pearson(ra, rb);
}

export function pearson(x: number[], y: number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 5) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx <= 0 || syy <= 0) return null;
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
}
