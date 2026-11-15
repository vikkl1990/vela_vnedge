import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenScope } from './screenScope.ts';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { IncubatorStore } from './store.ts';
import { recordScreen, candidateBlockers, type ScreenResult } from './cycle.ts';
import { saveTracker, listTrackers } from './tracker.ts';

test('explicit pair screening reaches watched cells and every requested market after silent probes', () => {
  const scope = screenScope({ shadowOnly: false, rescreenStages: new Set(), explicitCells: true });
  assert.equal(scope.skipStages.has('tracked'), false);
  assert.equal(scope.skipStages.has('candidate'), false);
  assert.equal(scope.skipStages.has('shadow'), true);
  assert.equal(scope.skipStages.has('live'), true);
  assert.equal(scope.silentProbeLimit, Infinity);
});

test('broad discovery and explicit shadow rescreens retain their existing stage boundaries', () => {
  const broad = screenScope({ shadowOnly: false, rescreenStages: new Set(), explicitCells: false });
  assert.equal(broad.skipStages.has('tracked'), true);
  assert.equal(broad.silentProbeLimit, 3);
  const shadow = screenScope({ shadowOnly: true, rescreenStages: new Set(['shadow', 'proposed']), explicitCells: true });
  assert.equal(shadow.skipStages.has('tracked'), true);
  assert.equal(shadow.skipStages.has('retired'), true);
  assert.equal(shadow.skipStages.has('shadow'), false);
  assert.equal(shadow.silentProbeLimit, Infinity);
});

test('a successful explicit screen records its result without admitting a tracker or changing its age', t => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const store = new IncubatorStore(db), cfg = structuredClone(DEFAULT_CONFIG);
  const cell = { scannerId: 'rsi-volume-ladder', symbol: 'ETHUSD', tf: '1h' };
  saveTracker(db, store, { id: 'watch-list', name: 'Watch list', scanners: [cell.scannerId], symbols: [cell.symbol], tfs: [cell.tf] }, 1000);
  const before = store.find(cell.scannerId, cell.symbol, cell.tf)!;
  const trackers = listTrackers(db);
  const result: ScreenResult = { pass: true, at: 2000, trades: 30, profitFactor: 2, netPnl: 100, netAtStress: 50, windowsUp: 6, winRatePct: 70, avgR: 0.3, bars: 4000, days: 166 };
  assert.equal(recordScreen(store, cell, result, cfg.incubator, 2000), 'updated');
  const after = store.find(cell.scannerId, cell.symbol, cell.tf)!;
  assert.equal(after.stage, 'tracked');
  assert.equal(after.since, before.since);
  assert.deepEqual(after.screen, result);
  assert.deepEqual(listTrackers(db), trackers);
  assert.equal(candidateBlockers(store, cfg, 2000).passed, 0);
  assert.equal(store.trades(cell.scannerId, cell.symbol, cell.tf, 2).length, 0);
});
