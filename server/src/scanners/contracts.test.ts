import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEvents, parseAlert, parseAlertAll, declaredChannels } from './extractor.ts';
import { applyRules, ruleErrors } from './rules.ts';
import { readingOf } from './reading.ts';

const A = (message: string, time = 1_000) => ({ barIndex: 10, time, type: 'alert' as const, message });
const C = (title: string, time = 1_000) => ({ barIndex: 10, time, type: 'alertcondition' as const, message: title, title });
const S = (title: string, times: number[], location = 'belowbar', shape = 'triangleup') => ({ title, times, location, shape });
const entries = (evs: any[]) => evs.filter(e => e.kind === 'entry').map(e => `${e.side}@${e.barTime}`);

test('decision 195: a scanner contract names each title\'s side — the retest reading, the short break, a title that is not an entry', () => {
  const retests = [S('Lower Retest', [1000]), S('Upper Retest', [2000], 'abovebar', 'triangledown')];
  // no contract: the words decide, as before (Upper → long, Lower → short)
  assert.deepEqual(entries(extractEvents([], retests)), ['short@1000', 'long@2000']);
  assert.deepEqual(entries(extractEvents([], retests, { sides: { 'lower retest': 'long', 'upper retest': 'short' } })), ['long@1000', 'short@2000'], 'retests as the script draws them');
  const breaks = [S('Break Up', [1000], 'absolute', 'xcross'), S('Break Dn', [2000], 'absolute', 'xcross')];
  assert.deepEqual(entries(extractEvents([], breaks)), ['long@1000'], 'Break Dn was never read');
  assert.deepEqual(entries(extractEvents([], breaks, { sides: { 'break up': 'long', 'break dn': 'short' } })), ['long@1000', 'short@2000']);
  const drops: Record<string, number> = {};
  assert.deepEqual(entries(extractEvents([], breaks, { sides: { 'break up': 'long', 'break dn': 'none' }, drops })), ['long@1000']);
  assert.equal(drops['shape: not an entry by the scanner contract'], 1);
});

test('decision 195: a packet with a stop and a new entry yields both, the stop first, whatever its formatting', () => {
  const pkt = { schema: 'sats.events.v2', events: [{ event: 'sl_hit', side: 'long', fill_price: 99 }, { event: 'sell', side: 'short', fill_price: 98.5, sl: 101 }] };
  const compact = extractEvents([A(JSON.stringify(pkt))], []);
  assert.deepEqual(compact.map(e => `${e.kind}:${e.side}`), ['exit:long', 'entry:short']);
  const pretty = extractEvents([A(JSON.stringify(pkt, null, 2))], []);
  assert.deepEqual(pretty.map(e => `${e.kind}:${e.side}`), ['exit:long', 'entry:short'], 'pretty-printed JSON means the same');
  const partials = parseAlertAll(A(JSON.stringify({ schema: 'sats.events.v2', events: [{ event: 'tp1_hit', side: 'long' }, { event: 'tp2_hit', side: 'long' }] })));
  assert.deepEqual(partials.map(e => e.exitType), ['tp1', 'tp2']);
  const fse = parseAlertAll(A(JSON.stringify({ schema_version: 2, events: [{ type: 'invalidated', direction: 1 }, { type: 'sell', direction: -1, entry: 100, stop: 102, target: 96 }] }, null, 1)));
  assert.deepEqual(fse.map(e => `${e.kind}:${e.side}`), ['exit:long', 'entry:short']);
});

test('decision 195: FVG Precision\'s own schema — entry with its stop and 2R target, exits at their levels, a broken gap closes at market', () => {
  const m = (o: any) => A(JSON.stringify({ schema_version: 1, source: 'FVG_INDICATOR', risk_reward: 2, ...o }));
  const e = parseAlert(m({ event_type: 'ENTRY', side: 'BUY', entry: 100, stop_loss: 98, take_profit: 104 }))!;
  assert.deepEqual([e.kind, e.side, e.price, e.sl, e.tp], ['entry', 'long', 100, 98, [104]]);
  const sl = parseAlert(m({ event_type: 'SL_HIT', side: 'SELL', exit_price: 102 }))!;
  assert.deepEqual([sl.kind, sl.side, sl.exitType, sl.price], ['exit', 'short', 'sl', 102]);
  assert.equal(parseAlert(m({ event_type: 'TP_HIT', side: 'BUY', exit_price: 104 }))!.exitType, 'tp1');
  assert.equal(parseAlert(m({ event_type: 'FVG_BROKEN', side: 'BUY', exit_price: 99 }))!.exitType, 'close');
  assert.equal(parseAlert(m({ event_type: 'SOMETHING_NEW', side: 'BUY' }))!.kind, 'info');
});

test('decision 195: numbers are whole tokens — exponents, thousands groups, and no partial reads', () => {
  const st = parseAlert(A('STRATEGY entry long @ 1e-7 sl=9e-8 tp=2e-7'))!;
  assert.deepEqual([st.price, st.sl, st.tp], [1e-7, 9e-8, [2e-7]]);
  assert.equal(parseAlert(A('🟢 LONG | DELTA:BTCUSD | Price:78,777.5 | SL: 78,402'))!.price, 78777.5);
  assert.equal(parseAlert(A('🟢 LONG | DELTA:BTCUSD | Price: 78,77 | SL: 78402'))!.price, undefined, 'a malformed number is not read as its first part');
});

test('decision 195: an exit condition closes the old trade even when an alert() entry owns the bar or the condition channel is excluded for entries', () => {
  const alerts = [A('🔴 SHORT | DELTA:BTCUSD | Price: 100', 5000), C('Exit Long', 5000)];
  assert.deepEqual(extractEvents(alerts, []).map(e => `${e.kind}:${e.side}`).sort(), ['entry:short', 'exit:long']);
  const only = extractEvents([C('Exit Long', 5000), C('Bullish Breakout', 6000)], [], { sources: ['alert'] });
  assert.deepEqual(only.map(e => `${e.kind}:${e.side}`), ['exit:long'], 'the excluded channel opens nothing but still closes');
});

test('decision 195: inverted, an exit for the script\'s long closes the short this reading holds', () => {
  const evs = extractEvents([A('🟢 LONG | DELTA:BTCUSD | Price: 100', 1000), A('🛑 SL HIT | Long | Entry: 100 | SL: 95', 2000)], [], { invert: true });
  assert.deepEqual(evs.map(e => `${e.kind}:${e.side}`), ['entry:short', 'exit:short']);
});

test('decision 195: with the source\'s declared channels, a later alert no longer erases an earlier label signal', () => {
  const drawn = [{ time: 1000, createdAt: 1000, y: 1, text: 'Buy', style: 'label_up' }];
  const later = [A('🟢 LONG | DELTA:BTCUSD | Price: 100', 2000)];
  const labelsOnly = declaredChannels('//@version=5\nindicator("x")\nlabel.new(bar_index, low, "Buy")');
  assert.equal(labelsOnly.size, 0);
  const alone = entries(extractEvents([], [], { drawn, declared: labelsOnly }));
  const withLater = entries(extractEvents(later, [], { drawn, declared: labelsOnly }));
  assert.ok(alone.includes('long@1000') && withLater.includes('long@1000'), `the label stays: ${withLater}`);
  // a script that declares alert() reads its alerts, not its labels, in every window
  const withAlerts = declaredChannels('alert("LONG")\nlabel.new(bar_index, low, "Buy")');
  assert.deepEqual(entries(extractEvents([], [], { drawn, declared: withAlerts })), []);
});

test('decision 195: a confirmed 55-bar pivot fires live on the bar it appears; the delay follows the script\'s input', () => {
  const H = 3600_000, bars = Array.from({ length: 120 }, (_, i) => ({ time: i * H, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
  const label = { time: bars[119 - 55].time, y: 1, text: 'HL' };
  const key = `${label.text}@${label.time}@${Math.round(label.y * 100)}`;
  const live = applyRules({ scannerId: 'structure-anchored-vwap', alerts: [], shapes: [], labels: [label], bars, mode: 'live', newLabelKeys: new Set([key]) });
  assert.equal(live.length, 1, 'the 40-bar cut-off used to throw this away');
  const viaVariant = applyRules({ scannerId: 'structure-anchored-vwap-pivots', ruleFor: 'structure-anchored-vwap', alerts: [], shapes: [], labels: [label], bars, mode: 'live', newLabelKeys: new Set([key]) });
  assert.equal(viaVariant.length, 1, 'a variant reads with its base\'s rule');
  const bt = applyRules({ scannerId: 'structure-anchored-vwap', alerts: [], shapes: [], labels: [{ ...label, time: bars[10].time }], bars, mode: 'backtest', inputs: { pivRInput: 20 } });
  assert.equal(bt[0].barTime, bars[30].time, 'entered 20 bars after the pivot when the script is set to 20');
});

test('decision 195: a live generic rule refuses an unpinned plot and says why; a pinned one trades', () => {
  const H = 3600_000, bars = Array.from({ length: 40 }, (_, i) => ({ time: i * H, open: 100, high: 101, low: 99, close: i < 20 ? 98 : 102, volume: 1 }));
  const plots = [{ title: 'Trail', style: 'line', overlay: true, data: bars.map(b => ({ time: b.time, value: 100 })) }];
  ruleErrors.clear();
  assert.deepEqual(applyRules({ scannerId: 'g', alerts: [], shapes: [], labels: [], bars, plots, mode: 'live', rule: 'trailing' }), []);
  assert.equal([...ruleErrors.values()][0]?.scannerId, 'g');
  const pinned = applyRules({ scannerId: 'g', alerts: [], shapes: [], labels: [], bars, plots, mode: 'live', rule: 'trailing', pin: { plot: 'Trail' } });
  assert.deepEqual(pinned.map(e => e.side), ['long']);
});

test('decision 195: every production path reads a scanner the same way, the live bar length included', () => {
  const r = readingOf({ enabled: true, symbols: null, timeframes: null, exitMode: 'both', edge: true, sides: { 'break dn': 'none' }, inputs: { pivRInput: 30 } }, 'x', 3600_000, 'plotshape(x)', 'base');
  assert.equal(r.extract.barMs, 3600_000);
  assert.deepEqual(r.extract.sides, { 'break dn': 'none' });
  assert.deepEqual([...r.extract.declared!], ['shape']);
  assert.equal(r.rule.ruleFor, 'base');
  assert.deepEqual(r.rule.inputs, { pivRInput: 30 });
});

test('decision 195: variants load as their own ids over the base source, with their own contracts in specs.json', async () => {
  const { ScannerRegistry } = await import('./registry.ts');
  const { loadSpecs } = await import('../config.ts');
  const reg = new ScannerRegistry();
  const specs = loadSpecs();
  for (const [v, base] of [['trend-impulse-channels-zeiierman-native', 'trend-impulse-channels-zeiierman'], ['pivot-channel-breaks-two-sided', 'pivot-channel-breaks'], ['structure-anchored-vwap-pivots', 'structure-anchored-vwap']]) {
    const s = reg.get(v), b = reg.get(base);
    assert.ok(s && b, v);
    assert.equal(s!.variantOf, base);
    assert.equal(s!.patched, b!.patched);
    assert.notDeepEqual(specs[v], specs[base], `${v} reads its source differently from ${base}`);
  }
  // the base ids keep the reading they were measured on, now written down
  assert.deepEqual(specs['trend-impulse-channels-zeiierman'].sides, { 'upper retest': 'long', 'lower retest': 'short' });
  assert.deepEqual(specs['pivot-channel-breaks'].sides, { 'break up': 'long', 'break dn': 'none' });
});

test('decision 195: a shadow pair whose scanner cannot run is retired with the library\'s reason', async () => {
  const { Db } = await import('../db.ts');
  const { DEFAULT_CONFIG } = await import('../config.ts');
  const { IncubatorStore } = await import('../incubator/store.ts');
  const { evaluate } = await import('../incubator/cycle.ts');
  const db = new Db(':memory:');
  const store = new IncubatorStore(db);
  const cfg = structuredClone(DEFAULT_CONFIG); cfg.scanners = {};
  store.move({ scannerId: 'tjr-v4-strategy', symbol: 'BTWUSD', tf: '15m' }, 'shadow', 'screen', null, null, Date.UTC(2026, 9, 1));
  store.move({ scannerId: 'fine', symbol: 'BTCUSD', tf: '15m' }, 'shadow', 'screen', null, null, Date.UTC(2026, 9, 1));
  const rep = evaluate(store, cfg, Date.UTC(2026, 9, 2), { unavailable: id => (id === 'tjr-v4-strategy' ? 'unavailable (source not published)' : null) });
  assert.ok(rep.retired.some(x => x.includes('tjr-v4-strategy')));
  const r = store.list(['retired']).find(x => x.scannerId === 'tjr-v4-strategy')!;
  assert.match(r.note ?? '', /scanner unavailable: unavailable \(source not published\)/);
  assert.equal(store.list(['shadow']).some(x => x.scannerId === 'fine'), true);
});
