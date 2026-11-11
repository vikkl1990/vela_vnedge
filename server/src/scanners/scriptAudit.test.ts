import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SCRIPTS_DIR } from '../config.ts';
import { auditScript, mirrorTitle, type Correction } from './scriptAudit.ts';

const codes = (cs: Correction[]) => cs.map(c => c.code);
const pine = (file: string) => fs.readFileSync(path.join(SCRIPTS_DIR, 'pine', file), 'utf8');
const specs = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, 'specs.json'), 'utf8'));

test('a retest drawn as an up-triangle under the bar and read as a short is a contradiction', () => {
  const a = auditScript(pine('d3IaFa7c-Trend-Impulse-Channels-Zeiierman.pine'), specs['trend-impulse-channels-zeiierman']);
  const sides = a.corrections.filter(c => c.code === 'side-against-drawing');
  assert.deepEqual(sides.map(c => [c.marker, c.severity]), [['Lower Retest', 'high'], ['Upper Retest', 'high']]);
  assert.deepEqual(sides[0].patch, { sides: { 'lower retest': 'long' } });
  // the as-drawn variant reads the same source without the contradiction
  const native = auditScript(pine('d3IaFa7c-Trend-Impulse-Channels-Zeiierman.pine'), specs['trend-impulse-channels-zeiierman-native']);
  assert.equal(native.corrections.some(c => c.code === 'side-against-drawing'), false);
});

test('a title that carries its own direction is a review, and a weak drawing is not evidence', () => {
  const src = (style: string, loc: string) => `//@version=6\nindicator("x")\nplotshape(c, title="Bullish break", style=${style}, location=${loc})`;
  const strong = auditScript(src('shape.triangledown', 'location.abovebar'));
  assert.deepEqual(strong.corrections.map(c => [c.code, c.severity]), [['side-against-drawing', 'review']]);
  assert.deepEqual(codes(auditScript(src('shape.circle', 'location.abovebar')).corrections), []);
});

test('the mirror of a traded marker that the reading switches off is a dropped side', () => {
  const src = '//@version=6\nindicator("x")\nplotshape(up, "Break Up", shape.triangleup, location.belowbar)\nplotshape(dn, "Break Dn", shape.triangledown, location.abovebar)';
  const off = auditScript(src, { sides: { 'break up': 'long', 'break dn': 'none' } }).corrections;
  assert.deepEqual(off.map(c => [c.code, c.marker]), [['side-dropped', 'Break Dn']]);
  assert.deepEqual(off[0].patch, { sides: { 'break dn': 'short' } });
  const allow = auditScript(src.replace('Break Dn', 'Break Down'), { labels: ['Break Up'] }).corrections;
  assert.deepEqual(allow[0].patch, { sides: { 'break down': 'short' }, labels: ['Break Up', 'Break Down'] });
  assert.deepEqual(codes(auditScript(src, { sides: { 'break up': 'long', 'break dn': 'short' } }).corrections), []);
});

test('an allow-list that names one alert text misses the mirror the script also sends', () => {
  const src = '//@version=6\nindicator("x")\nif a\n    alert("Bullish Breakout Detected")\nif b\n    alert("Bearish Breakout Detected")';
  const c = auditScript(src, { labels: ['Bullish Breakout Detected'] }).corrections;
  assert.deepEqual(c.map(x => [x.code, x.marker]), [['side-dropped', 'Bearish Breakout Detected']]);
  assert.deepEqual(codes(auditScript(src, { labels: ['Bullish Breakout Detected', 'Bearish Breakout Detected'] }).corrections), []);
});

test('a traded condition named for a state change is flagged for review, once per title', () => {
  const src = '//@version=6\nindicator("x")\nalertcondition(u, "Trend Flip Up", "m")\nalertcondition(d, "Trend Flip Down", "m")\nplotshape(u, "Bull Spike")\nplotshape(u, "Bull Spike")\nalertcondition(e, "Long Signal", "m")';
  const c = auditScript(src).corrections.filter(x => x.code === 'not-an-entry');
  assert.deepEqual(c.map(x => x.marker), ['Bull Spike', 'Trend Flip Up', 'Trend Flip Down']);
  assert.deepEqual(c[1].patch, { sides: { 'trend flip up': 'none' } });
});

test('own stop and targets: carried and discarded, plotted and unread, or not exported at all', () => {
  const head = '//@version=6\nindicator("x")\nsl = close - atr\ntp1 = close + atr\n';
  assert.deepEqual(codes(auditScript(head + 'plotshape(b, "Buy")').corrections), ['levels-not-exported']);
  assert.deepEqual(codes(auditScript(head + 'plot(sl, "Stop Loss")\nplotshape(b, "Buy")').corrections), ['levels-plotted-unread']);
  const carried = head + 'alert("LONG | SL: " + str.tostring(sl) + " | TP1: " + str.tostring(tp1))';
  assert.deepEqual(codes(auditScript(carried, {}, { skipScriptStops: true }).corrections), ['own-stop-discarded']);
  assert.deepEqual(codes(auditScript(carried, { entryProtection: 'native' }, { skipScriptStops: true }).corrections), []);
  assert.deepEqual(codes(auditScript(carried).corrections), []);
  const strat = '//@version=6\nstrategy("x")\nstrategy.entry("L", strategy.long)\nstrategy.exit("X", stop=low, limit=high)\nplot(low, "Stop Loss")';
  assert.deepEqual(codes(auditScript(strat).corrections), ['levels-plotted-unread']);
});

test('alert switches that default to off are proposed as input overrides', () => {
  const src = '//@version=6\nindicator("x")\ntpAlerts = input.bool(false, "Alert on TP / Break-Even")\nshow = input.bool(false, "Show table")\non = input.bool(true, "Alert on entries")\nif x\n    alert("LONG")';
  const c = auditScript(src).corrections;
  assert.deepEqual(c.map(x => x.code), ['alerts-off-by-default']);
  assert.deepEqual(c[0].patch, { inputs: { 'Alert on TP / Break-Even': true } });
});

test('a pivot length is resolved through its input, and short pivots are not reported', () => {
  const src = (n: number) => `//@version=6\nindicator("x")\nlen = input.int(${n}, "Pivot")\nph = ta.pivothigh(high, len, len)\nplotshape(b, "Buy")`;
  const c = auditScript(src(55)).corrections;
  assert.deepEqual(codes(c), ['late-pivot']);
  assert.match(c[0].finding, /55 bars.*13\.8 h on 15m, 55 h on 1h, 220 h on 4h/);
  assert.deepEqual(codes(auditScript(src(5)).corrections), []);
});

test('lookahead on a plain series is certain, behind a function it is a review, with an offset it is fine', () => {
  const src = (e: string) => `//@version=6\nindicator("x")\nh = request.security(syminfo.tickerid, "D", ${e}, lookahead=barmerge.lookahead_on)\nplotshape(b, "Buy")`;
  assert.deepEqual(auditScript(src('close')).corrections.map(c => [c.code, c.severity]), [['lookahead', 'high']]);
  assert.deepEqual(auditScript(src('f(len)')).corrections.map(c => [c.code, c.severity]), [['lookahead', 'review']]);
  assert.deepEqual(codes(auditScript(src('close[1]')).corrections), []);
  assert.deepEqual(codes(auditScript(src('close').replace('lookahead_on', 'lookahead_off')).corrections), []);
});

test('a script with nothing the reader can take as an entry is context only; a strategy is not', () => {
  assert.deepEqual(codes(auditScript('//@version=6\nindicator("x")\nplot(close, "Line")').corrections), ['no-entry-read']);
  assert.deepEqual(codes(auditScript('//@version=6\nindicator("x")\nplotshape(c, "Pivot High", shape.circle)').corrections), ['no-entry-read']);
  assert.deepEqual(codes(auditScript('//@version=6\nstrategy("x")\nstrategy.entry("L", strategy.long)').corrections), []);
});

test('the reader is emulated: exits, excluded channels, contracts and titles built from variables', () => {
  const src = '//@version=6\nindicator("x")\nalertcondition(a, "Long Stop Hit", "m")\nalertcondition(b, "Buy Signal", "m")\nplotshape(c, title=name, style=shape.triangleup)\nplotshape(d, "Sell", shape.triangledown, location.abovebar)\n// plotshape(e, "Buy")';
  const m = auditScript(src, { sources: ['alertcondition'] }).markers;
  assert.deepEqual(m.map(x => [x.title, x.reads, x.why ?? '']), [['name', 'unread', 'the title is an expression'], ['Sell', 'unread', 'the channel is excluded'], ['Long Stop Hit', 'exit', ''], ['Buy Signal', 'long', '']]);
  assert.equal(m[1].drawn, 'short');
});

test('mirrorTitle swaps every direction word and leaves a neutral title alone', () => {
  assert.equal(mirrorTitle('Asia Bull Breakout'), 'asia bear breakout');
  assert.equal(mirrorTitle('Break Dn'), 'break up');
  assert.equal(mirrorTitle('Cross above AVWAP'), 'cross below avwap');
  assert.equal(mirrorTitle('New ranked anchor'), undefined);
});
