import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInputs, splitArgs, validateInputOverrides } from './inputs.ts';

const SRC = `//@version=5
indicator("Demo", overlay=true)
// len = input.int(99, "commented out")
len = input.int(14, "Length", minval=1, maxval=200, step=1, tooltip="Lookback, bars")
float mult = input.float(defval=2.5, title="ATR Mult", minval=0.5, maxval=10, group="Risk")
useFilter = input.bool(true, "Use filter")
mode = input.string("Fast", "Mode", options=["Fast", "Slow", "Off"])
src = input.source(close, "Source")
htf = input.timeframe("60", title = "HTF")
var int x = input(5, "Bare int")
col = input.color(color.red, "Color")
plot(ta.sma(src, len) * mult, "MA")
if bar_index > input.int(3, "Inline threshold") and useFilter
    label.new(bar_index, close, "x")
`;

test('splitArgs respects strings and nesting', () => {
  assert.deepEqual(splitArgs('1, "a, b", f(x, y), [1, 2], k=v'), ['1', '"a, b"', 'f(x, y)', '[1, 2]', 'k=v']);
});

test('parseInputs extracts name, title, type, default, bounds and options', () => {
  const d = parseInputs(SRC);
  const by = Object.fromEntries(d.map(x => [x.name, x]));
  assert.deepEqual(d.map(x => x.name), ['len', 'mult', 'useFilter', 'mode', 'src', 'htf', 'x', 'col', 'Inline_threshold']);
  assert.equal(by.len.type, 'int'); assert.equal(by.len.default, 14); assert.equal(by.len.min, 1); assert.equal(by.len.max, 200); assert.equal(by.len.step, 1); assert.equal(by.len.title, 'Length'); assert.equal(by.len.tooltip, 'Lookback, bars'); assert.equal(by.len.line, 4);
  assert.equal(by.mult.type, 'float'); assert.equal(by.mult.default, 2.5); assert.equal(by.mult.min, 0.5); assert.equal(by.mult.group, 'Risk'); assert.equal(by.mult.title, 'ATR Mult');
  assert.equal(by.useFilter.type, 'bool'); assert.equal(by.useFilter.default, true);
  assert.equal(by.mode.type, 'string'); assert.deepEqual(by.mode.options, ['Fast', 'Slow', 'Off']);
  assert.equal(by.src.type, 'source'); assert.equal(by.src.default, 'close');
  assert.equal(by.htf.type, 'timeframe'); assert.equal(by.htf.default, '60'); assert.equal(by.htf.title, 'HTF');
  assert.equal(by.x.type, 'int'); assert.equal(by.x.default, 5);
  assert.equal(by.col.type, 'color'); assert.equal(by.col.default, 'color.red');
  assert.equal(by.Inline_threshold.title, 'Inline threshold'); assert.equal(by.Inline_threshold.default, 3);
});

test('validateInputOverrides accepts names or titles, coerces, and rejects out-of-range/unknown values', () => {
  const d = parseInputs(SRC);
  const ok = validateInputOverrides(d, { len: '21', 'ATR Mult': 3, useFilter: 'false', mode: 'Slow', 'Use filter': true });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.values, { len: 21, mult: 3, useFilter: true, mode: 'Slow' });
  const bad = validateInputOverrides(d, { len: 500, mult: 'x', mode: 'Turbo', nope: 1, useFilter: 'yes' });
  assert.equal(bad.errors.length, 5, bad.errors.join('; '));
  assert.deepEqual(bad.values, {});
});
