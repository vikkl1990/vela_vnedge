import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRules, labelKey } from './rules.ts';
import { parseAlert } from './extractor.ts';

const bars = Array.from({ length: 20 }, (_, i) => ({ time: 1_000_000 + i * 900_000, open: 100, high: 101, low: 99, close: 100 + i, volume: 1 }));
const A = (message: string, time: number, type: 'alert' | 'alertcondition' = 'alert', title?: string) => ({ barIndex: 0, time, type, message, title });

test('AMD Po3 DIST alerts parse as entries with stop/target', () => {
  const e = parseAlert(A('🔴 DIST ▼ DOWN (manip HIGH) | DELTA:BTCUSD | TF: 15 | Entry: 80000 | Stop: 80500 | Target: 79000 | R:R: 2 | Time: 2026-09-20 11:00', 1))!;
  assert.equal(e.kind, 'entry'); assert.equal(e.side, 'short'); assert.equal(e.sl, 80500); assert.deepEqual(e.tp, [79000]);
  assert.equal(parseAlert(A('🛑 STOP HIT | DELTA:BTCUSD | TF: 15 | ✗ -1R | Ref entry: 80000 | cycle 3', 2))!.exitType, 'sl');
  assert.equal(parseAlert(A('🎯 TARGET REACHED | DELTA:BTCUSD | TF: 15 | ✓ +2R | Ref entry: 80000 | cycle 3', 2))!.exitType, 'tp1');
});

test('pivot CHoCH, squeeze and 80% rule derive entries', () => {
  const t = bars[5].time;
  const piv = applyRules({ scannerId: 'adaptive-pivot-structure', alerts: [A('🔴 CHoCH ↓ Reversal | DELTA:BTCUSD | TF: 15 | Price: 105', t), A('🟢 BOS ↑ | DELTA:BTCUSD | TF: 15 | Price: 105', t)], shapes: [], labels: [], bars, mode: 'backtest' });
  assert.equal(piv.length, 1); assert.equal(piv[0].side, 'short'); assert.equal(piv[0].price, 105);
  const sq = applyRules({ scannerId: 'adaptive-squeeze-momentum-pro', alerts: [A('🟡 SQUEEZE FIRED | DELTA:BTCUSD | TF: 15 | Direction: BULLISH | Price: 105', t)], shapes: [], labels: [], bars, mode: 'backtest' });
  assert.equal(sq[0].side, 'long');
  const vp = applyRules({ scannerId: 'daily-volume-profile-pro', alerts: [A('📐 80% RULE | DELTA:BTCUSD | TF: 15 | Open below yVA, re-accepted inside → target yVAH 120.5', t)], shapes: [], labels: [], bars, mode: 'backtest' });
  assert.equal(vp[0].side, 'long'); assert.deepEqual(vp[0].tp, [120.5]);
});

test('label rules: backtest anchor shift and live new-label gating', () => {
  const lbl = { time: bars[3].time, y: 99, text: 'HL', style: 'style_label_up' };
  const bt = applyRules({ scannerId: 'structure-anchored-vwap', alerts: [], shapes: [], labels: [lbl], bars, mode: 'backtest' });
  assert.equal(bt.length, 1); assert.equal(bt[0].side, 'long'); assert.equal(bt[0].barTime, bars[8].time);
  const liveOld = applyRules({ scannerId: 'structure-anchored-vwap', alerts: [], shapes: [], labels: [lbl], bars, mode: 'live', newLabelKeys: new Set() });
  assert.equal(liveOld.length, 0);
  const liveNew = applyRules({ scannerId: 'structure-anchored-vwap', alerts: [], shapes: [], labels: [lbl], bars, mode: 'live', newLabelKeys: new Set([labelKey(lbl)]) });
  assert.equal(liveNew.length, 1); assert.equal(liveNew[0].barTime, bars.at(-1)!.time);
  const sr = applyRules({ scannerId: 'auto-s-r-channels', alerts: [], shapes: [], labels: [{ time: bars[4].time, y: 104, text: 'Breakout ▼', style: 'style_label_down' }, { time: 0, y: 95, text: '🎯 95.5', style: 'style_label_left' }], bars, mode: 'backtest' });
  assert.equal(sr[0].side, 'short'); assert.deepEqual(sr[0].tp, [95.5]);
});

test('fib entry zone takes direction from TP labels', () => {
  const t = bars[6].time;
  const ev = applyRules({ scannerId: 'automatic-fibonacci-levels', alerts: [A('🟡 ENTRY ZONE | DELTA:BTCUSD | TF: 15 | Price: 106', t)], shapes: [], labels: [{ time: 0, y: 110, text: 'TP1', style: '' }, { time: 0, y: 115, text: 'TP2', style: '' }, { time: 0, y: 120, text: 'TP3', style: '' }, { time: 0, y: 125, text: 'TP4', style: '' }], bars, mode: 'backtest' });
  assert.equal(ev[0].side, 'long'); assert.deepEqual(ev[0].tp, [110, 115, 120]);
});
