import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../config.ts';
import { checkRiskVsFees, costRuleRatio, feeInR } from './logic.ts';

test('S5: fees in R is the cost rule\'s own arithmetic, and the rule refuses exactly above 1/ratio', () => {
  const cfg = structuredClone(DEFAULT_CONFIG.paper);
  const ratio = costRuleRatio(cfg);
  assert.ok(ratio > 0, 'the default cost rule is on');
  const entry = 100;
  // sweep stop distances across the limit: the refusal and feeR > 1/ratio always agree
  for (const stopPct of [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 1, 2, 5]) {
    const sl = entry * (1 - stopPct / 100);
    const r = feeInR(entry, sl, cfg)!;
    assert.ok(r > 0);
    assert.equal(checkRiskVsFees(entry, sl, cfg) !== null, r > 1 / ratio + 1e-12, `stop ${stopPct}%: feeR ${r}`);
  }
  // a wider stop costs fewer R; long and short are symmetric
  assert.ok(feeInR(entry, 98, cfg)! < feeInR(entry, 99, cfg)!);
  assert.equal(feeInR(entry, 99, cfg), feeInR(entry, 101, cfg));
});

test('S5: per-market overrides, rule off, and missing levels', () => {
  const cfg = { ...structuredClone(DEFAULT_CONFIG.paper), minRiskFeeRatio: 4, minRiskFeeRatioBySymbol: { BTCUSD: 8 } };
  assert.equal(costRuleRatio(cfg, 'BTCUSD'), 8);
  assert.equal(costRuleRatio(cfg, 'ETHUSD'), 4);
  assert.equal(costRuleRatio({ ...cfg, minRiskFeeRatio: 0, minRiskFeeRatioBySymbol: undefined }), 0);
  assert.equal(feeInR(100, null, cfg), null);
  assert.equal(feeInR(100, 100, cfg), null, 'a stop at the entry has no R');
  assert.equal(feeInR(0, 99, cfg), null);
});
