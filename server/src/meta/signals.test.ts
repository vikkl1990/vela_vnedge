import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetaStudy, type MetaCell, type MetaScanner } from './signals.ts';
const M = 60000;
function cell(tf: string, times: number[], plotValues: Record<string, Array<number | null>>, scannerId: MetaScanner = 'adaptive-macd'): MetaCell {
  return { scannerId, symbol: 'BTCUSD', tf, sourceHash: 'source', settingsHash: 'inputs', scheduled: true, events: [], bars: times.map(t => ({ time: t * M, open: 100, high: 101, low: 99, close: 100, volume: 1 })), plots: Object.entries(plotValues).map(([title, values]) => ({ title, style: 'line', overlay: false, data: times.map((t, i) => ({ time: t * M, value: values[i] })) })) };
}
function cells() { return [cell('15m', [0, 15, 30, 45, 60], { Histogram: [-1, -1, -1, 1, 1], MACD: [-2, -2, -2, -2, -2] }), cell('1h', [0, 60], { MACD: [1, -999], Histogram: [1, -999] })]; }

test('MACD uses histogram crosses as events, MACD sign as higher context; forming higher candle is excluded', () => {
  const evaluate = createMetaStudy('adaptive-macd', 'BTCUSD', cells());
  const r = evaluate('scalp', 60 * M);
  assert.equal(r.status, 'READY_LONG'); assert.equal(r.evidence[1].barTime, 0);
  assert.equal(r.trigger!.confirmedAt, 60 * M); assert.equal(r.reference.state, 'unknown', 'reference frame is not a hidden veto');
  assert.equal(evaluate('scalp', 60 * M - 1).status, 'UNKNOWN', 'the first higher candle is not known before its close');
  assert.equal(evaluate('scalp', 61 * M).key, r.key, 'one signal identity across repeated evaluations');
  assert.equal(r.researchOnly, true);
});

test('context disagreement and zero are blocked separately from unknown data', () => {
  const a = cells(); a[1].plots[0].data[0].value = -1;
  assert.equal(createMetaStudy('adaptive-macd', 'BTCUSD', a)('scalp', 60 * M).status, 'BLOCKED');
  a[1].plots[0].data[0].value = 0;
  assert.match(createMetaStudy('adaptive-macd', 'BTCUSD', a)('scalp', 60 * M).reason, /neutral/);
  a[1].plots[0].data[0].value = null;
  assert.equal(createMetaStudy('adaptive-macd', 'BTCUSD', a)('scalp', 60 * M).status, 'UNKNOWN');
});

test('trigger expires after one entry candle; old cross is not carried as an indefinite state', () => {
  const r = createMetaStudy('adaptive-macd', 'BTCUSD', cells())('scalp', 75 * M);
  assert.equal(r.status, 'WAIT'); assert.match(r.reason, /expired/);
});

test('missing closed-bar plot is not forward-filled; stale/disabled observations cannot signal readiness', () => {
  const a = cells(); a[0].plots[0].data.pop();
  assert.equal(createMetaStudy('adaptive-macd', 'BTCUSD', a)('scalp', 75 * M).status, 'UNKNOWN');
  const b = cells(); b[1].scheduled = false;
  assert.match(createMetaStudy('adaptive-macd', 'BTCUSD', b)('scalp', 60 * M).reason, /not observed/);
  const c = cells(); c[1].bars.pop(); c[1].plots.forEach(p => p.data.pop());
  assert.match(createMetaStudy('adaptive-macd', 'BTCUSD', c)('scalp', 120 * M).reason, /stale/);
});

test('Willy uses fresh squeeze release plus plotted Momentum, not a historical entry side', () => {
  const scanner = 'adaptive-squeeze-momentum-pro';
  const a = cell('15m', [0, 15, 30, 45], { Momentum: [-1, -1, -1, 1] }, scanner);
  const b = cell('1h', [0], { Momentum: [1] }, scanner);
  a.events = [{ kind: 'entry', side: 'long', tp: [], label: 'Squeeze fired ▲', message: '', source: 'derived', barTime: 45 * M, barIndex: 3 }];
  b.events = [{ ...a.events[0], side: 'short', barTime: 0 }];
  assert.equal(createMetaStudy(scanner, 'BTCUSD', [a, b])('scalp', 60 * M).status, 'READY_LONG');
  a.events[0].label = 'Bullish divergence';
  assert.equal(createMetaStudy(scanner, 'BTCUSD', [a, b])('scalp', 60 * M).status, 'WAIT');
});

test('source/settings drift or mixed scanner/symbol evidence cannot silently align', () => {
  const a = cells(); a[1].settingsHash = 'different';
  assert.equal(createMetaStudy('adaptive-macd', 'BTCUSD', a)('scalp', 60 * M).status, 'UNKNOWN');
  const b = cells(); b[1].symbol = 'ETHUSD';
  assert.throws(() => createMetaStudy('adaptive-macd', 'BTCUSD', b), /mixes/);
  const c = cells(); c[0].bars.reverse();
  assert.throws(() => createMetaStudy('adaptive-macd', 'BTCUSD', c), /ascending/);
});

test('a gap cannot create a MACD cross; duplicate plot titles are unknown', () => {
  const a = cells(); a[0] = cell('15m', [0, 45], { Histogram: [-1, 1] });
  assert.equal(createMetaStudy('adaptive-macd', 'BTCUSD', a)('scalp', 60 * M).status, 'WAIT');
  const b = cells(); b[1].plots.push(b[1].plots[0]);
  assert.equal(createMetaStudy('adaptive-macd', 'BTCUSD', b)('scalp', 60 * M).status, 'UNKNOWN');
});

test('swing uses 1h trigger and 4h context, and produces a separate identity', () => {
  const a = cell('1h', [0, 60, 120, 180], { Histogram: [-1, -1, -1, 1], MACD: [1, 1, 1, 1] });
  const b = cell('4h', [0], { MACD: [1] });
  const r = createMetaStudy('adaptive-macd', 'BTCUSD', [a, b])('swing', 240 * M);
  assert.equal(r.status, 'READY_LONG'); assert.deepEqual(r.evidence.map(e => e.tf), ['1h', '4h']);
  assert.equal(r.trigger!.expiresAt, 300 * M);
});

test('future suffixes cannot change a past meta decision', () => {
  const a = cells(); const cut = a.map(c => ({ ...c, bars: c.bars.filter(b => b.time < 60 * M), plots: c.plots.map(p => ({ ...p, data: p.data.filter(d => d.time < 60 * M) })) }));
  assert.deepEqual(createMetaStudy('adaptive-macd', 'BTCUSD', a)('scalp', 60 * M), createMetaStudy('adaptive-macd', 'BTCUSD', cut)('scalp', 60 * M));
});

test('contradictory same-bar squeeze triggers are unknown, never an arbitrary winning side', () => {
  const scanner = 'adaptive-squeeze-momentum-pro';
  const a = cell('15m', [0, 15, 30, 45], { Momentum: [1, 1, 1, 1] }, scanner);
  a.events = (['long', 'short'] as const).map(side => ({ kind: 'entry', side, tp: [], label: 'Squeeze fired', message: '', source: 'derived', barTime: 45 * M, barIndex: 3 }));
  const b = cell('1h', [0], { Momentum: [1] }, scanner);
  const r = createMetaStudy(scanner, 'BTCUSD', [a, b])('scalp', 60 * M);
  assert.equal(r.status, 'UNKNOWN'); assert.match(r.reason, /contradictory/);
});

test('a closed candle is not usable before its scanner output actually arrives', () => {
  const a = cells(); a[1].availableAt = { 0: 61 * M };
  const evaluate = createMetaStudy('adaptive-macd', 'BTCUSD', a);
  assert.equal(evaluate('scalp', 60 * M).status, 'UNKNOWN');
  assert.equal(evaluate('scalp', 61 * M).status, 'READY_LONG');
  assert.equal(evaluate('scalp', 61 * M).evidence[1].availability, 'observed');
});
