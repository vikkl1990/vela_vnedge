import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropQualifiers, fundamentalsToNa, intWindowLengths, joinContinuations, liftV4, renameReserved, replaceCall } from './compat.ts';

test('continuation lines inside brackets and leading-operator lines are joined; comments re-indented', () => {
  const src = [
    '// @version=6',
    'var tb = table.new(table_position, 3, 8 // 4 + countErrors',
    '  , bgcolor = #1e222d',
    '  , border_width = 1)',
    'rss = aY.variance()',
    '      - r2',
    'x = "a // not a comment" + y',
    'if cond',
    '//Zone Management',
    '    if (i == 1)',
    '        y := 2',
  ].join('\n');
  const out = joinContinuations(src).split('\n');
  assert.equal(out.shift(), '// @version=6', 'the version annotation is kept, even with a space');
  assert.equal(out[0], 'var tb = table.new(table_position, 3, 8 , bgcolor = #1e222d , border_width = 1)');
  assert.equal(out[1], 'rss = aY.variance() - r2');
  assert.equal(out[2], 'x = "a // not a comment" + y');
  assert.equal(out[3], 'if cond');
  assert.equal(out[4], '    if (i == 1)', 'the comment-only line is gone');
});

test('a block whose value starts with a minus is not a continuation', () => {
  const src = 'dir = if not na(ph)\n    1\nelse if not na(pl)\n    -1\nx = a\n      - b';
  assert.equal(joinContinuations(src), 'dir = if not na(ph)\n    1\nelse if not na(pl)\n    -1\nx = a - b');
});

test('loop and declaration qualifiers are dropped', () => {
  assert.equal(dropQualifiers('for int j = 0 to 45 by 1'), 'for j = 0 to 45 by 1');
  assert.equal(dropQualifiers('var series float source_h = float(na)'), 'var float source_h = float(na)');
  assert.equal(dropQualifiers('simple int len = 14'), 'int len = 14');
  assert.equal(dropQualifiers('for [i, v] in arr'), 'for [i, v] in arr');
});

test('type and method used as variables are renamed, declarations and strings untouched', () => {
  const src = 'type Dom\n    float v\nmethod = input.string("Linreg", "Trend Method")\nif method == "Linreg"\n    x := 1\ntype = input.string("TEMA", "MA Type")\nm = type == "TEMA"';
  const out = renameReserved(src);
  assert.match(out, /^type Dom$/m);
  assert.match(out, /^method_ = input\.string\("Linreg", "Trend Method"\)$/m);
  assert.match(out, /^if method_ == "Linreg"$/m);
  assert.match(out, /^type_ = input\.string\("TEMA", "MA Type"\)$/m);
  assert.match(out, /^m = type_ == "TEMA"$/m);
});

test('balanced call replacement and fundamentals lowering', () => {
  assert.equal(replaceCall('a = f(g(1, "x)"), 2) + f(3)', 'f', a => `[${a}]`), 'a = [g(1, "x)"), 2] + [3]');
  assert.equal(fundamentalsToNa('e = request.earnings(syminfo.tickerid, earnings.actual)\nta.sma(e, 3)'), 'e = float(na)\nta.sma(e, 3)');
});

test('v4 is lifted to v5 by the migration table', () => {
  const src = '//@version=4\nstudy("X", overlay=true, resolution="")\nlen = input(14, "Len", type=input.integer)\nsrc = input(close, title="Src", type=input.source)\nm = sma(src, len)\nh = security(syminfo.tickerid, "60", high)\nv = iff(m > h, 1, 0)\nplot(m, transp=50)\ns = tostring(len)\nk = ta.rsi(src, 2)';
  const out = liftV4(src);
  assert.match(out, /^\/\/@version=5$/m);
  assert.match(out, /^indicator\("X", overlay=true, timeframe =""\)$/m);
  assert.match(out, /^len = input\.int\(14, "Len"\)$/m);
  assert.match(out, /^src = input\.source\(close, title="Src"\)$/m);
  assert.match(out, /^m = ta\.sma\(src, len\)$/m);
  assert.match(out, /^h = request\.security\(syminfo\.tickerid, "60", high\)$/m);
  assert.match(out, /^v = \(m > h \? 1 : 0\)$/m);
  assert.match(out, /^plot\(m\)$/m);
  assert.match(out, /^s = str\.tostring\(len\)$/m);
  assert.match(out, /^k = ta\.rsi\(src, 2\)$/m);
  assert.equal(liftV4('//@version=5\nm = sma(close, 3)'), '//@version=5\nm = sma(close, 3)');
  assert.match(liftV4("//@version=4\npos = input('Long', 'Position Type', options=['Long', 'Short'])\nn = input(3, 'N', options=[3, 5])\nk = input(close)\nc = input(#ff5d00, 'Color')\nb = input(true)\nf = input(1.5, minval=0)\nt = input(title='T', type=bool, defval=false)\nz = input(syminfo.tickerid)"), /^pos = input\.string\('Long', 'Position Type', options=\['Long', 'Short'\]\)\nn = input\.int\(3, 'N', options=\[3, 5\]\)\nk = input\.source\(close\)\nc = input\.color\(#ff5d00, 'Color'\)\nb = input\.bool\(true\)\nf = input\.float\(1\.5, minval=0\)\nt = input\.bool\(title='T', defval=false\)\nz = input\(syminfo\.tickerid\)$/m);
});

test('decision 151: a ta.* window length written as a division is truncated to an int', () => {
  assert.equal(intWindowLengths('x = ta.wma(ta.wma(_src,_length / 3) * 3 - ta.wma(_src, _length / 2), _length)'), 'x = ta.wma(ta.wma(_src,int(_length / 3)) * 3 - ta.wma(_src, int(_length / 2)), _length)');
  assert.equal(intWindowLengths('h = ta.highest(high, len/2)'), 'h = ta.highest(high, int(len/2))');
  assert.equal(intWindowLengths('a = ta.sma(close, 20)\nb = ta.ema(close / 2, len)'), 'a = ta.sma(close, 20)\nb = ta.ema(close / 2, len)', 'whole lengths and divided sources are untouched');
});
