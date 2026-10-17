import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankAuc, theCall, yardstick, type YardTrade } from './yardstick.ts';

const t = (prob: number | null, r: number, scored: YardTrade['scored'] = 'entry'): YardTrade => ({ prob, r, scored: prob === null ? null : scored });

test('rankAuc: perfect ranking is 1, reversed is 0, ties split, one-sided outcomes are null', () => {
  assert.equal(rankAuc([{ prob: 0.9, win: true }, { prob: 0.1, win: false }]), 1);
  assert.equal(rankAuc([{ prob: 0.1, win: true }, { prob: 0.9, win: false }]), 0);
  assert.equal(rankAuc([{ prob: 0.5, win: true }, { prob: 0.5, win: false }]), 0.5);
  assert.equal(rankAuc([{ prob: 0.5, win: true }]), null);
});

test('yardstick: a gate pays when the trades it drops are a losing set that matters', () => {
  // 40 low-probability losers, 60 high-probability trades that net positive
  const trades = [
    ...Array.from({ length: 40 }, () => t(0.42, -1)),
    ...Array.from({ length: 60 }, (_, i) => t(0.62, i % 3 === 0 ? -1 : 0.8)),
  ];
  const y = yardstick(trades);
  assert.equal(y.trades, 100); assert.equal(y.scored, 100); assert.equal(y.scoredAtEntry, 100);
  assert.equal(y.buckets.find(b => b.label === '< 45%')!.n, 40);
  const at45 = y.thresholds.find(x => x.minProb === 0.45)!;
  assert.equal(at45.dropped, 40); assert.equal(at45.droppedSumR, -40); assert.equal(at45.kept, 60);
  assert.ok(Math.abs(at45.deltaSumR - 40) < 1e-9, 'the book would have had 40R more under the gate');
  assert.ok(y.verdict.pays); assert.equal(y.verdict.minProb, 0.45);
  assert.ok(y.auc! > 0.7);
});

test('yardstick: discarding winners along with losers does not count as paying', () => {
  // the low bucket is mixed and nets positive: a gate would raise the average but lose R
  const trades = [
    ...Array.from({ length: 30 }, (_, i) => t(0.42, i % 2 ? -1 : 1.5)),
    ...Array.from({ length: 30 }, () => t(0.62, 0.3)),
  ];
  const y = yardstick(trades);
  assert.equal(y.verdict.pays, false); assert.equal(y.verdict.minProb, null);
  assert.ok(y.thresholds.find(x => x.minProb === 0.45)!.deltaSumR < 0);
});

test('yardstick: unscored trades are kept by every gate and counted apart', () => {
  const y = yardstick([t(null, 0.5), t(null, -1), ...Array.from({ length: 10 }, () => t(0.3, -1))]);
  assert.equal(y.unscored, 2); assert.equal(y.scored, 10);
  for (const x of y.thresholds) assert.equal(x.kept, 2 + y.scored - x.dropped);
  assert.equal(y.verdict.pays, false);
  assert.match(y.verdict.text, /too few/);
});

test('theCall: the shadow book decides, the account may only veto', () => {
  const paying = yardstick([...Array.from({ length: 40 }, () => t(0.42, -1)), ...Array.from({ length: 60 }, () => t(0.62, 0.5))]);
  const neutral = yardstick(Array.from({ length: 50 }, () => t(0.62, 0.2)));
  assert.equal(theCall(neutral, paying).minProb, 0.45);
  assert.equal(theCall(paying, neutral).minProb, null, 'the account paying alone is in-sample evidence');
  // the account would have lost R under the shadow book's threshold: veto
  const hurt = yardstick([...Array.from({ length: 10 }, () => t(0.42, 1)), ...Array.from({ length: 10 }, () => t(0.62, 0.2))]);
  const call = theCall(hurt, paying);
  assert.equal(call.minProb, null); assert.match(call.text, /would have lost/);
});
