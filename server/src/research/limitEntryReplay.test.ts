import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../config.ts';
import { calibration, clusteredMean, replayLimitCase, summarize, type Bar1m, type CaseResult, type LimitCase, type ReplayEnv } from './limitEntryReplay.ts';

const T0 = Date.UTC(2026, 10, 20, 10, 0, 0), MIN = 60_000, DAY = 86_400_000;
const env = (over: Partial<ReplayEnv> = {}, paper: Record<string, unknown> = {}): ReplayEnv => ({
  cfg: { ...DEFAULT_CONFIG.paper, ...paper }, market: { contractValue: 1, tickSize: 0.01 }, equity: 100_000, horizonMs: 24 * 3600_000, atrOffset: 0.1, bars: 2, ...over,
});
const sig = (over: Partial<LimitCase> = {}): LimitCase => ({ key: 'a', book: 0, scannerId: 's', symbol: 'TESTUSD', tf: '1h', side: 'long', signalAt: T0 + 3_000, reference: 100, atr: 1, ...over });
/** One bar per minute from T0, the price following `price(minute)`. */
const path = (minutes: number, price: (m: number) => number): Bar1m[] => Array.from({ length: minutes }, (_, m) => {
  const o = price(m), c = price(m + 1);
  return { time: T0 + m * MIN, open: o, close: c, high: Math.max(o, c), low: Math.min(o, c) };
});

test('a price that runs away leaves the limit unfilled while the market entry trades it', () => {
  // up 8 over the first hour, then back to 95 over four hours: the limit (99.9) is not reached inside its two bars
  const bars = path(600, (m) => (m <= 60 ? 100 + (8 * m) / 60 : 108 - (13 * (m - 60)) / 240 > 95 ? 108 - (13 * (m - 60)) / 240 : 95));
  const r = replayLimitCase(sig(), bars, env());
  assert.equal(r.limit.status, 'unfilled');
  assert.equal(r.market.status, 'closed');
  assert.ok(r.market.netR! > 0, `market entry on a breakout should win, got ${r.market.netR}`);
});

test('a dip through the limit fills it as a maker at its own price, with a lower fee than the market arm', () => {
  const bars = path(600, (m) => (m < 10 ? 100 - (0.25 * m) / 10 : m < 30 ? 99.75 + ((m - 10) * 6) / 20 : 105.75 + (m - 30) * 0.01));
  const r = replayLimitCase(sig(), bars, env());
  assert.equal(r.limit.status, 'closed');
  assert.equal(r.market.status, 'closed');
  assert.equal(r.limit.entryPrice, 99.9);
  assert.ok(r.limit.fees! < r.market.fees!, 'a maker fee is below a taker fee on the same notional');
  assert.ok(r.limit.entryAt! >= T0 + 2 * MIN);       // not before the latency window
});

test('the order fills only through its price under "through", and at it under "touch"', () => {
  const flatThenTouch = path(600, () => 100).map((b, i) => (i === 5 ? { ...b, low: 99.9 } : b));
  assert.equal(replayLimitCase(sig(), flatThenTouch, env({}, { limitFill: 'through' })).limit.status, 'unfilled');
  const touch = replayLimitCase(sig(), flatThenTouch, env({ horizonMs: 3600_000 }, { limitFill: 'touch' })).limit;
  assert.ok(['closed', 'censored'].includes(touch.status), `touch fills the order (status ${touch.status})`);
  assert.equal(touch.entryPrice, 99.9);
});

test('a touch after the order expires does not fill it; candles that end first are unverified, not unfilled', () => {
  const late = path(600, () => 100).map((b, i) => (i === 130 ? { ...b, low: 99.5 } : b));      // 130 minutes: after two 1h bars
  assert.equal(replayLimitCase(sig(), late, env()).limit.status, 'unfilled');
  const short = path(90, () => 100);                                                        // ends before the two bars are over
  assert.equal(replayLimitCase(sig(), short, env()).limit.status, 'unverified');
});

test('a trade still open at the horizon is censored in that arm and left out of the summary', () => {
  const flat = path(600, () => 100).map((b, i) => (i === 5 ? { ...b, low: 99.5 } : b));
  const r = replayLimitCase(sig(), flat, env({ horizonMs: 30 * MIN }));
  assert.equal(r.market.status, 'censored');
  const s = summarize([r]);
  assert.equal(s.counts.used, 0);
});

test('bad inputs are unverified, never guessed', () => {
  assert.equal(replayLimitCase(sig({ atr: 0 }), path(100, () => 100), env()).limit.status, 'unverified');
  assert.equal(replayLimitCase(sig(), [{ time: T0 + 1, open: 1, high: 1, low: 1, close: 1 }], env()).market.status, 'unverified');
  assert.equal(replayLimitCase(sig({ tf: '7x' }), path(100, () => 100), env()).limit.status, 'unverified');
});

test('a clustered mean uses a standard error by day, and has none from a single day', () => {
  const xs = [1, 1, -1, -1].map((x, i) => ({ x, at: i < 2 ? 0 : DAY }));   // day 0 sums to +2, day 1 to -2, mean 0
  const e = clusteredMean(xs);
  assert.equal(e.mean, 0);
  assert.ok(Math.abs(e.se! - Math.sqrt(2 ** 2 + 2 ** 2) / 4) < 1e-12);
  assert.equal(clusteredMean([{ x: 1, at: 0 }, { x: 2, at: 1 }]).se, null);
  assert.equal(clusteredMean([]).mean, null);
});

const res = (k: string, day: number, limit: Partial<CaseResult['limit']>, market: Partial<CaseResult['market']>, over: Partial<LimitCase> = {}): CaseResult =>
  ({ case: sig({ key: k, signalAt: T0 + day * DAY, ...over }), limit: { status: 'closed', netR: 0, ...limit }, market: { status: 'closed', netR: 0, ...market } });

test('the summary counts an unfilled limit as zero R and reports what the unfilled signals would have made', () => {
  const rows: CaseResult[] = [];
  for (let d = 0; d < 10; d++) {
    rows.push(res(`f${d}`, d, { netR: 0.1 }, { netR: 0.1 }));                                // filled: both arms agree
    rows.push(res(`u${d}`, d, { status: 'unfilled' }, { netR: 0.5 }));                       // missed breakouts the market arm took
  }
  const s = summarize(rows);
  assert.equal(s.counts.used, 20);
  assert.equal(s.all.filled, 10);
  assert.equal(s.all.fillRatePct, 50);
  assert.ok(Math.abs(s.all.limitR.mean! - 0.05) < 1e-9 && Math.abs(s.all.marketR.mean! - 0.3) < 1e-9);
  assert.ok(Math.abs(s.all.difference.mean! + 0.25) < 1e-9);
  assert.ok(Math.abs(s.all.missedMinusTaken.mean! - 0.4) < 1e-9);                            // missed 0.5 vs taken 0.1
  assert.equal(s.all.verdict, 'limit costs R');                                              // -0.25 R on every one of ten days: no day-to-day spread to hide it
  assert.deepEqual(Object.keys(s.byTf), ['1h']);
  assert.deepEqual(Object.keys(s.byBook), ['account']);
});

test('the verdict needs the whole interval on one side of zero', () => {
  const rows: CaseResult[] = [];
  for (let d = 0; d < 30; d++) for (let i = 0; i < 5; i++) rows.push(res(`x${d}-${i}`, d, { netR: -0.2 + (d % 3 === 0 ? 0.02 : -0.02) }, { netR: 0.2 + (d % 2 === 0 ? 0.02 : -0.02) }));
  assert.equal(summarize(rows).all.verdict, 'limit costs R');
  const flip = rows.map((r) => ({ ...r, limit: { ...r.limit, netR: r.market.netR! + (r.case.signalAt / DAY % 2 > 0.5 ? 0.3 : -0.3) } }));
  assert.equal(summarize(flip).all.verdict, 'no difference detected');
});

test('the calibration compares the replayed fill with the one the account recorded', () => {
  const a = res('a', 0, { netR: 0.3, entryAt: T0 + 5 * MIN, entryPrice: 99.9 }, { netR: 0 }, { actual: { entryAt: T0 + 5 * MIN + 30_000, entryPrice: 99.9, netR: 0.4 } });
  const b = res('b', 1, { netR: -1, entryAt: T0 + DAY + 9 * MIN, entryPrice: 50 }, { netR: 0 }, { actual: { entryAt: T0 + DAY + 20 * MIN, entryPrice: 50.2, netR: -0.9 } });
  const c = res('c', 2, { status: 'unfilled' }, { netR: 0 }, { actual: { entryAt: T0 + 2 * DAY, entryPrice: 10, netR: 0.1 } });
  const cal = calibration([a, b, c], () => 0.01);
  assert.equal(cal.recordedFills, 3);
  assert.equal(cal.replayAlsoFilled, 2);
  assert.equal(cal.replayDidNotFill, 1);
  assert.equal(cal.sameFillTimeAndPricePct, 50);
  assert.ok(Math.abs(cal.actualMeanR! - -0.25) < 1e-9 && Math.abs(cal.replayMeanR! - -0.35) < 1e-9);
});
