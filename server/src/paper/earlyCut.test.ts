import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../config.ts';
import { earlyCutExit, openPosition } from './logic.ts';

const cfg = { ...DEFAULT_CONFIG.paper, earlyCut: { r: -0.5, minutes: 60 } };
const pos = () => openPosition({ id: 1, scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', side: 'long', qty: 10, contractValue: 0.001, entryPrice: 100, at: 0, sl: 98, tp: [104], riskAmount: 0.02, levelsSource: 'atr-fallback', signalId: null, cfg, bt: true });

test('the early cut fires at or past r inside the window and not after it', () => {
  const p = pos();
  assert.equal(earlyCutExit(p, 99.5, 10 * 60_000, cfg), null, '-0.25R: no cut');
  assert.equal(earlyCutExit(p, 99.0, 61 * 60_000, cfg), null, '-0.5R but past the window: no cut');
  const f = earlyCutExit(p, 99.0, 59 * 60_000, cfg);
  assert.ok(f && f.reason === 'cut' && Math.abs(f.price - 99.0) < 0.1, 'at -0.5R inside the window: cut at market, slippage paid');
  assert.equal(p.status, 'closed');
});

test('no rule, no cut', () => {
  assert.equal(earlyCutExit(pos(), 98.5, 5 * 60_000, DEFAULT_CONFIG.paper), null);
});
