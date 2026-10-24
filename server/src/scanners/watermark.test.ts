import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BarWatermark, liveSince } from './watermark.ts';

const M = 60_000, T0 = 1_700_000_000_000;

test('a run with no mark reads its last bar only', () => {
  assert.equal(liveSince(undefined, T0, '15m'), T0);
});

test('a run after a skipped bar reads the skipped bar too, but entries older than the look-back are not reached', () => {
  const tf = 15 * M;
  assert.equal(liveSince(T0, T0 + tf, '15m'), T0 + tf, 'nothing skipped: the last bar');
  assert.equal(liveSince(T0, T0 + 2 * tf, '15m'), T0 + tf, 'one bar skipped: read from it');
  assert.equal(liveSince(T0, T0 + 5 * tf, '15m'), T0 + 3 * tf, 'four skipped: capped at the look-back');
  assert.equal(liveSince(T0 + tf, T0, '15m'), T0, 'a mark ahead of the bar (replayed history) reads the bar only');
});

test('the watermark persists through its store and never moves backwards', () => {
  let saved: Record<string, number> | undefined;
  const w = new BarWatermark({ load: () => saved, save: r => { saved = { ...r }; } });
  w.advance('a:BTCUSD:15m', T0);
  w.advance('a:BTCUSD:15m', T0 - M);
  assert.equal(w.get('a:BTCUSD:15m'), T0);
  assert.deepEqual(saved, { 'a:BTCUSD:15m': T0 });
  const again = new BarWatermark({ load: () => saved, save: () => {} });
  assert.equal(again.since('a:BTCUSD:15m', T0 + 2 * 15 * M, '15m'), T0 + 15 * M);
});

test('decision 193: the job returns output back to the watermark after a stall, capped, and reports what lies beyond', async () => {
  const { liveWindow, MAX_CATCHUP_BARS } = await import('./watermark.ts');
  const H = 3600_000, last = 1_800_000_000_000 - (1_800_000_000_000 % H);
  assert.deepEqual(liveWindow(undefined, last, '1h'), { since: last, tailBars: 3, missed: 0 }, 'no mark: the last bar');
  assert.deepEqual(liveWindow(last - H, last, '1h'), { since: last, tailBars: 3, missed: 0 }, 'the usual run: one new bar');
  const ten = liveWindow(last - 10 * H, last, '1h');
  assert.deepEqual(ten, { since: last - 9 * H, tailBars: 10, missed: 0 }, 'ten bars behind: nine skipped bars and the new one, all returned');
  const far = liveWindow(last - (MAX_CATCHUP_BARS + 11) * H, last, '1h');
  assert.equal(far.tailBars, MAX_CATCHUP_BARS + 1);
  assert.equal(far.since, last - MAX_CATCHUP_BARS * H);
  assert.equal(far.missed, 10, 'the bars beyond the cap are reported, not silently skipped');
});
