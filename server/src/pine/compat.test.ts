import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropQualifiers, dropStatementCommas, fundamentalsToNa, intWindowLengths, joinContinuations, liftV4, renameReserved, replaceCall } from './compat.ts';
import { PATCH_RULES, applyPatches } from './patches.ts';

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

test('decision 158: the "timeframe above the chart" guard is removed, other timeframe guards are kept', () => {
  const guard = PATCH_RULES.find((r) => r.id === 'htf-guard')!.apply;
  assert.equal(guard('a = 1\nif barstate.isfirst and timeframe.in_seconds(tf)<=timeframe.in_seconds(timeframe.period)\n    runtime.error("Selected timeframe must be higher than the chart timeframe.")\nb = 2\n'), 'a = 1\nb = 2\n');
  const daily = 'if timeframe.in_seconds(timeframe.period) >= timeframe.in_seconds("D")\n    runtime.error("Timeframe is too High!")\nb = 2\n';
  assert.equal(guard(daily), daily, 'a guard on the chart timeframe alone stays');
  const more = 'if timeframe.in_seconds(tf) <= timeframe.in_seconds(timeframe.period)\n    runtime.error("x")\n    y := 1\n';
  assert.equal(guard(more), more, 'a block that does more than stop the script stays');
});

test('decision 163: a comma that ends a statement is dropped, a comma that wraps a line is kept', () => {
  assert.equal(dropStatementCommas('if a\n    x := 1, y := 2,\n\nelse\n    x := 0'), 'if a\n    x := 1, y := 2\n\nelse\n    x := 0');
  assert.equal(dropStatementCommas('switch k\n    1 => f(a,\n         b),\n    => g()'), 'switch k\n    1 => f(a,\n         b)\n    => g()');
  const wrapped = 'var t = table.new(position.top_right, 2, 2),\n     bg = color.red';
  assert.equal(dropStatementCommas(wrapped), wrapped, 'a following line at a wrap indent continues the statement');
  const call = 'x = f(a,\n    b)';
  assert.equal(dropStatementCommas(call), call, 'a comma inside open brackets is an argument separator');
  assert.equal(dropStatementCommas('s = "a,"\nt = 1'), 's = "a,"\nt = 1', 'a comma inside a string is not counted');
});

test('decision 163: an unused TradingView/ta import is removed, a used one kept', () => {
  const rule = PATCH_RULES.find((r) => r.id === 'unused-ta-import')!.apply;
  assert.equal(rule('//@version=6\nindicator("x")\nimport TradingView/ta/12\nplot(ta.sma(close, 5))'), '//@version=6\nindicator("x")\n\nplot(ta.sma(close, 5))');
  const used = '//@version=6\nindicator("x")\nimport TradingView/ta/12\nplot(ta.tema(close, 5))';
  assert.equal(rule(used), used);
  const aliased = 'import TradingView/ta/9 as tl\nplot(tl.kama(close, 10))';
  assert.equal(rule(aliased), aliased);
});

test('decision 172: every label.new call is stamped with its creation bar; a call with its own tooltip or eleven positional arguments is left alone', () => {
  const src = '//@version=5\nindicator("x")\nif close > open\n    label.new(bar_index[2], high, "▼", style = label.style_label_down)\nlabel.new(bar_index, low, "▲", tooltip = "mine")\nlabel.new(bar_index, low, "x", xloc.bar_index, yloc.price, color.red, label.style_label_up, color.white, size.small, text.align_center, "own")\nn = array.size(label.all)';
  const r = applyPatches(src, 'x.pine');
  assert.equal(r.applied.at(-1), 'label-created-bar');
  assert.match(r.source, /label\.new\(bar_index\[2\], high, "▼", style = label\.style_label_down, tooltip = "vn:" \+ str\.tostring\(bar_index\)\)/);
  assert.match(r.source, /label\.new\(bar_index, low, "▲", tooltip = "mine"\)/, 'its own tooltip kept');
  assert.match(r.source, /text\.align_center, "own"\)/, 'eleven positional arguments: untouched');
  assert.match(r.source, /n = 0$/, 'the earlier label.all-size rewrite still applies');
  const without = applyPatches('//@version=5\nindicator("y")\nplot(close)', 'y.pine');
  assert.ok(!without.applied.includes('label-created-bar'));
});

test('decision 186: the array-get-field patch rewrites plain ifs with distinct names and leaves an else-if chain intact', async () => {
  const { applyPatches } = await import('./patches.ts');
  const src = ['//@version=5', 'indicator("t")', 'var a = array.new<int>()', 'if array.get(a, 0).x > 1', '    y = 1', 'else if array.get(a, 1).x > 2', '    y = 2', 'if array.get(a, 2).x > 3', '    y = 3'].join('\n');
  const { source } = applyPatches(src, 'test.pine');
  assert.match(source, /__vnedge_el_0 = array\.get\(a, 0\)\nif __vnedge_el_0\.x > 1/);
  assert.match(source, /else if array\.get\(a, 1\)\.x > 2/, 'the else-if line is left as it was');
  assert.match(source, /__vnedge_el_1 = array\.get\(a, 2\)\nif __vnedge_el_1\.x > 3/, 'the second rewrite takes its own name');
});
