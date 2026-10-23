import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketStructureStops, statDeltaSeries, atrOf, MarketStructureTrail } from './luxExits.ts';
import { modelTrail, openPosition, type Position } from './logic.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';

const bar = (i: number, o: number, h: number, l: number, c: number): Bar => ({ time: i * 60_000, open: o, high: h, low: l, close: c, volume: 1 });
const walk = (n: number, f: (i: number) => number): Bar[] => Array.from({ length: n }, (_, i) => { const c = f(i); return bar(i, c, c + 1, c - 1, c); });

test('decision 178: the sigmoid model converges the stop toward price only while the gap is open, never past the minimum distance, never backwards', () => {
  const cfg = DEFAULT_CONFIG.paper;
  const p: Position = openPosition({ id: 1, scannerId: 's', scannerName: 's', symbol: 'X', tf: '15m', side: 'long', qty: 1, contractValue: 1, entryPrice: 100, sl: 95, tp: [], entryAt: 0, riskAmount: 5, levelsSource: 'atr-fallback', leverage: 1, cfg, bt: true } as any);
  const m = { sigmoid: { atr: 1, atrMult: 3, sigLength: 20, sigAmp: 3, minDist: 0.5 } };
  modelTrail(p, { close: 97 }, m);
  assert.equal(p.sl, 95, 'the gap (2) is under 3 ATR: nothing moves');
  modelTrail(p, { close: 100 }, m);
  assert.ok(p.sl! > 95 && p.sl! < 96, `the transition started: ${p.sl}`);
  let last = p.sl!;
  for (let k = 0; k < 25; k++) { modelTrail(p, { close: 100 }, m); assert.ok(p.sl! >= last, 'a trailing stop never falls'); last = p.sl!; }
  assert.ok(last <= 100 - 0.5 + 1e-9, `halts at the minimum distance from the close: ${last}`);
  assert.ok(last > 95 + 2, `it moved most of the 3 ATR amplitude: ${last}`);
  const s: Position = openPosition({ id: 2, scannerId: 's', scannerName: 's', symbol: 'X', tf: '15m', side: 'short', qty: 1, contractValue: 1, entryPrice: 100, sl: 105, tp: [], entryAt: 0, riskAmount: 5, levelsSource: 'atr-fallback', leverage: 1, cfg, bt: true } as any);
  for (let k = 0; k < 25; k++) modelTrail(s, { close: 100 }, m);
  assert.ok(s.sl! < 105 && s.sl! >= 100.5 - 1e-9, `mirrored for a short: ${s.sl}`);
});

test('decision 178: a level model ratchets and marks break-even once past the entry', () => {
  const cfg = DEFAULT_CONFIG.paper;
  const p: Position = openPosition({ id: 3, scannerId: 's', scannerName: 's', symbol: 'X', tf: '15m', side: 'long', qty: 1, contractValue: 1, entryPrice: 100, sl: 95, tp: [], entryAt: 0, riskAmount: 5, levelsSource: 'atr-fallback', leverage: 1, cfg, bt: true } as any);
  modelTrail(p, { close: 101 }, { level: { long: 94, short: null } });
  assert.equal(p.sl, 95, 'a lower level is ignored');
  modelTrail(p, { close: 103 }, { level: { long: 101, short: null } });
  assert.equal(p.sl, 101); assert.equal(p.breakEven, true);
  modelTrail(p, { close: 103 }, { level: { long: null, short: 90 } });
  assert.equal(p.sl, 101, 'the other side\'s level is not this position\'s');
});

test('decision 178: the statistical distance is log-normal in the trailing true range and formed only after the window', () => {
  const bars = walk(140, i => 100 + Math.sin(i / 3) * 2);
  const d1 = statDeltaSeries(bars, 1), d2 = statDeltaSeries(bars, 2);
  assert.equal(d2[100], null, 'not formed until data + distribution length');
  assert.ok(d2[139]! > d1[139]!, 'level 2 sits wider than level 1');
  assert.ok(d1[139]! > 0 && d1[139]! < 20);
});

test('decision 178: the market-structure stop appears on the first change of character and then follows the running close', () => {
  // a slow wobble (a pivot low forms at its trough), a rise to 130 (a pivot high), a fall through the trough
  // (bearish structure: os = -1), then a rise through 130: a bullish change of character, where the long stop
  // resets to the fall's low and then follows the running max close. In 'CHoCH' mode the first break of a
  // structure that was never bearish sets no stop, exactly as the Pine does.
  const bars = [...walk(40, i => 100 + Math.sin(i / 5) * 3), ...walk(30, i => 100 + i), ...walk(40, i => 130 - i), ...walk(60, i => 90 + i)].map((b, i) => ({ ...b, time: i * 60_000 }));
  const ms = marketStructureStops(bars);
  assert.equal(ms[10].long, null, 'no structure yet');
  assert.ok(ms.slice(0, 110).every(m => m.long === null), 'no long stop before the change of character');
  const first = ms.findIndex(m => m.long !== null);
  assert.ok(first > 140 && first < 160, `the long stop appears on the break above 130: ${first}`);
  assert.ok(ms[first].long! <= 91, `reset to the leg's local low: ${ms[first].long}`);
  assert.ok(ms[169].long! > ms[first].long!, 'then it rises with the running max close');
  for (let i = first + 1; i < 170; i++) assert.ok(ms[i].long! >= ms[i - 1].long! - 1e-9, 'never falls while the structure holds');
  assert.equal(ms[169].short, null, 'no short stop in a bullish structure');
  const a = atrOf(bars, 14); assert.ok(a[13] > 0 && Number.isNaN(a[12]));
});

// the batch port as it was first written, kept here as the reference the incremental tracker must match
function referenceStops(bars: Bar[], length = 14, incrPct = 100): Array<{ long: number | null; short: number | null }> {
  const out: Array<{ long: number | null; short: number | null }> = [];
  let phY = NaN, phX = -1, plY = NaN, plX = -1, phCross = false, plCross = false;
  let top = NaN, btm = NaN, max = NaN, min = NaN, ts = NaN, os = 0, prevMax = NaN, prevMin = NaN;
  for (let n = 0; n < bars.length; n++) {
    if (n >= 2 * length) {
      const c = n - length; let isHigh = true, isLow = true;
      for (let k = n - 2 * length; k <= n; k++) { if (k === c) continue; if (bars[k].high >= bars[c].high) isHigh = false; if (bars[k].low <= bars[c].low) isLow = false; }
      if (isHigh) { phY = bars[c].high; phX = c; phCross = false; }
      if (isLow) { plY = bars[c].low; plX = c; plCross = false; }
    }
    const close = bars[n].close; let ms = 0;
    if (Number.isFinite(phY) && close > phY && !phCross) { ms = os === -1 ? 1 : 0; phCross = true; os = 1; btm = bars[n].low; for (let i = phX; i <= n; i++) btm = Math.min(btm, bars[i].low); }
    if (Number.isFinite(plY) && close < plY && !plCross) { ms = os === 1 ? -1 : 0; plCross = true; os = -1; top = bars[n].high; for (let i = plX; i <= n; i++) top = Math.max(top, bars[i].high); }
    prevMax = max; prevMin = min;
    if (ms === 1) max = close; else if (ms === -1) min = close; else { max = Number.isFinite(max) ? Math.max(close, max) : close; min = Number.isFinite(min) ? Math.min(close, min) : close; }
    if (ms === 1) ts = btm; else if (ms === -1) ts = top; else if (os === 1 && Number.isFinite(ts) && Number.isFinite(prevMax)) ts += (max - prevMax) * incrPct / 100; else if (os === -1 && Number.isFinite(ts) && Number.isFinite(prevMin)) ts += (min - prevMin) * incrPct / 100;
    const level = Number.isFinite(ts) ? ts : null;
    out.push({ long: os === 1 ? level : null, short: os === -1 ? level : null });
  }
  return out;
}

test('decision 178: the incremental tracker matches the batch port bar for bar on a long random walk, trims its history, and ignores a bar seen twice', () => {
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let p = 1000; const bars: Bar[] = [];
  for (let i = 0; i < 3000; i++) { const o = p; p = p * (1 + (rnd() - 0.5) * 0.02); const h = Math.max(o, p) * (1 + rnd() * 0.005), l = Math.min(o, p) * (1 - rnd() * 0.005); bars.push({ time: i * 900_000, open: o, high: h, low: l, close: p, volume: 1 }); }
  const ref = referenceStops(bars);
  const t = new MarketStructureTrail(14, 100);
  for (let i = 0; i < bars.length; i++) {
    const lv = t.push(bars[i]);
    assert.deepEqual(lv, ref[i], `bar ${i}`);
    if (i % 500 === 0) assert.deepEqual(t.push(bars[i]), ref[i], 'the same bar again changes nothing');
  }
  assert.ok(ref.some(r => r.long !== null) && ref.some(r => r.short !== null), 'the walk produced both structures');
  assert.ok((t as any).history.length < 600, `history is trimmed: ${(t as any).history.length}`);
});
