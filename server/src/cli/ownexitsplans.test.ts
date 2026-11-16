import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../config.ts';
import { MAX_RESEARCH_PLANS, type ExecutionPlan } from '../paper/executionPlans.ts';
import { proposeOwnExitsPlans, OWN_EXITS_SURVIVORS } from './ownexitsplans.ts';

test('every survivor id is a script in the manifest', async () => {
  const fs = await import('node:fs');
  const m = JSON.parse(fs.readFileSync(new URL('../../../scripts/manifest.json', import.meta.url), 'utf8')), list = Array.isArray(m) ? m : (m.scripts ?? Object.values(m));
  const ids = new Set(list.map((x: any) => x.id));
  assert.deepEqual(OWN_EXITS_SURVIVORS.filter(id => !ids.has(id)), []);
});

test('proposes own-exits plans for the survivors, slow timeframe first, and they validate', () => {
  const cfg = structuredClone(DEFAULT_CONFIG); cfg.executionPlans = [];
  const r = proposeOwnExitsPlans(cfg, OWN_EXITS_SURVIVORS, ['BTCUSD', 'ETHUSD'], ['4h', '1h'], 1000);
  assert.deepEqual(r.errors, []);
  assert.equal(r.add.length, 40); assert.equal(r.dropped.length, 0);
  assert.ok(r.add.slice(0, 20).every(p => p.tf === '4h'));
  assert.ok(r.add.every(p => p.exitPolicy === 'own-exits' && p.variant === 'current' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(p.id)));
  assert.equal(new Set(r.add.map(p => p.id)).size, r.add.length);
});

test('capacity is respected and what does not fit is listed, not dropped silently', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.executionPlans = Array.from({ length: MAX_RESEARCH_PLANS - 5 }, (_, i) => ({ id: `x-${i}`, revision: 1, enabled: false, scannerId: 's', symbol: 'BTCUSD', tf: '4h', variant: 'current', referenceEquity: 1000 } as ExecutionPlan));
  const r = proposeOwnExitsPlans(cfg, OWN_EXITS_SURVIVORS, ['BTCUSD'], ['4h'], 1000);
  assert.equal(r.free, 5); assert.equal(r.add.length, 5); assert.equal(r.dropped.length, 5);
});

test('a cell that already has an own-exits plan is not proposed twice', () => {
  const cfg = structuredClone(DEFAULT_CONFIG); cfg.executionPlans = [];
  const first = proposeOwnExitsPlans(cfg, ['norn-weave-thurisaz'], ['BTCUSD'], ['4h'], 1000);
  cfg.executionPlans = first.add;
  assert.equal(proposeOwnExitsPlans(cfg, ['norn-weave-thurisaz'], ['BTCUSD'], ['4h'], 1000).add.length, 0);
});

test('a script that exits in parts is named and left out, never proposed', () => {
  const cfg = structuredClone(DEFAULT_CONFIG); cfg.executionPlans = [];
  const r = proposeOwnExitsPlans(cfg, ['norn-weave-thurisaz', 'dema-atr-strategy'], ['BTCUSD'], ['4h'], 1000, new Set(['dema-atr-strategy']));
  assert.deepEqual(r.skipped, ['dema-atr-strategy']);
  assert.deepEqual(r.add.map(p => p.scannerId), ['norn-weave-thurisaz']);
});
