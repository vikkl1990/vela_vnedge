import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG, validateConfig } from '../config.ts';
import { PaperEngine } from './engine.ts';
import { fillDriftR } from './logic.ts';

test('fill drift is measured in R of the decision, positive against the trade', () => {
  assert.equal(fillDriftR('long', 100, 100.5, 99), 0.5);
  assert.ok(Math.abs(fillDriftR('long', 100, 99.8, 99)! + 0.2) < 1e-9, 'a better fill reads negative');
  assert.ok(Math.abs(fillDriftR('short', 100, 99.7, 101)! - 0.3) < 1e-9, 'a short filled lower is worse');
  assert.ok(Math.abs(fillDriftR('short', 100, 100.3, 101)! + 0.3) < 1e-9, 'a short filled higher is better');
  assert.equal(fillDriftR('long', 100, 101, 100), null, 'no stop distance, no reading');
  const cfg = structuredClone(DEFAULT_CONFIG);
  assert.equal(cfg.paper.maxFillDriftR, 0.3);
  cfg.paper.maxFillDriftR = -1;
  assert.ok(validateConfig(cfg).includes('paper.maxFillDriftR must be ≥ 0'));
});

// a market entry decided at 100 (stop 99, targets 101/102/103) that fills after the latency window at `print`
function run(print: number, maxFillDriftR?: number) {
  const db = new Db(':memory:');
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, { fillSource: 'tape', latencyMs: 50, slippageBps: 0, quotedSlippageBps: 0, useSpread: false, requireQuote: false, maxSignalAgeSec: 0, minRiskFeeRatio: 0, liquidation: false, skipScriptStops: false });
  if (maxFillDriftR !== undefined) cfg.paper.maxFillDriftR = maxFillDriftR;
  const e = new PaperEngine(db, () => cfg);
  e.onEntry({ kind: 'entry', side: 'long', price: 100, sl: 99, tp: [101, 102, 103], label: 'entry', message: '', source: 'alert', barTime: 0, barIndex: 0 },
    { scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '5m', market: { tickSize: 0.01, contractValue: 1 }, refPrice: 100, at: 60_010, signalId: null, exitMode: 'both' } as any);
  e.onTrade('BTCUSD', print, 1e6, 60_070, 60_070);
  const open = e.openPositions();
  db.db.close();
  return open;
}

test('a market fill that ran past the drift limit is cancelled; within it, or with the guard off, it fills', () => {
  assert.equal(run(100.2).length, 1, '0.2R against the long: fills');
  assert.equal(run(100.5).length, 0, '0.5R against the long: cancelled');
  assert.equal(run(99.6).length, 1, 'a better price is never refused');
  assert.equal(run(100.5, 0).length, 1, 'guard off: fills');
});
