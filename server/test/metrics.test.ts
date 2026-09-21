/** Prometheus text exposition, counters with labels, gauges and the per-minute rate window. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsRegistry, RateWindow } from '../src/ops/metrics.ts';

test('counters and gauges render in the text exposition format', t => {
  const m = new MetricsRegistry('t_');
  t.after(() => m.stop());
  m.inc('runs_total', 'runs', { status: 'ok' }); m.inc('runs_total', 'runs', { status: 'ok' }); m.inc('runs_total', 'runs', { status: 'error' });
  m.inc('plain_total', 'no labels');
  m.gauge('depth', 'queue depth', () => 3);
  m.gauge('ratio', 'a fraction', () => 0.125);
  m.gauge('absent', 'omitted when null', () => null);
  m.gauge('multi', 'per label', () => [{ labels: { a: 'x"y' }, value: 1 }, { labels: { a: 'z' }, value: 2 }]);
  m.gauge('throws', 'sampler errors are skipped', () => { throw new Error('x'); });
  const text = m.render();
  assert.match(text, /^# HELP t_runs_total runs\n# TYPE t_runs_total counter\nt_runs_total\{status="ok"\} 2\nt_runs_total\{status="error"\} 1\n/);
  assert.match(text, /\n# TYPE t_plain_total counter\nt_plain_total 1\n/);
  assert.match(text, /\n# TYPE t_depth gauge\nt_depth 3\n/);
  assert.match(text, /\nt_ratio 0\.125\n/);
  assert.match(text, /\nt_multi\{a="x\\"y"\} 1\nt_multi\{a="z"\} 2\n/);
  assert.doesNotMatch(text, /t_absent|t_throws/);
  assert.match(text, /\n# TYPE t_process_resident_memory_bytes gauge\nt_process_resident_memory_bytes \d+\n/);
  assert.match(text, /t_event_loop_lag_p99_ms \d/);
  assert.ok(text.endsWith('\n'));
  assert.equal(m.value('runs_total'), 3); assert.equal(m.value('runs_total', { status: 'ok' }), 2); assert.equal(m.value('nope'), 0);
  const snap = m.snapshot();
  assert.equal(snap.t_plain_total, 1); assert.equal(snap.t_depth, 3);
});

test('RateWindow counts events in the trailing minute', () => {
  const w = new RateWindow(60_000);
  const t0 = 1_000_000;
  for (let i = 0; i < 10; i++) w.hit(t0 + i * 1000);
  assert.equal(w.perMinute(t0 + 10_000), 10);
  assert.equal(w.perMinute(t0 + 65_000), 5);
  assert.equal(w.perMinute(t0 + 200_000), 0);
});
