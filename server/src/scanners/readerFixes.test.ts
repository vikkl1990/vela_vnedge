import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEvents, parseAlertAll, type ScanEvent } from './extractor.ts';
import { readingOf } from './reading.ts';
import { validateConfig, DEFAULT_CONFIG } from '../config.ts';
import type { WorkerAlert, WorkerLabel, WorkerShape } from '../pine/worker.ts';

const T = 1_700_000_000_000;
const alert = (message: string, time = T): WorkerAlert => ({ type: 'alert', title: 'alert', message, time, barIndex: 10 } as WorkerAlert);
const cond = (title: string, time = T): WorkerAlert => ({ type: 'alertcondition', title, message: title, time, barIndex: 10 } as WorkerAlert);
const shape = (title: string, extra: Partial<WorkerShape> = {}): WorkerShape => ({ title, times: [T], ...extra });
const brief = (es: ScanEvent[]) => es.map(e => `${e.kind}:${e.side ?? '-'}${e.exitType ? ':' + e.exitType : ''}`);
const v1 = { scannerId: 'x' }, v2 = { scannerId: 'x', reader: 2 };

test('a reversal that names the closed trade first closes that trade', () => {
  const msg = '🔄 REVERSAL | BTCUSD | Long → Short | Prev entry: 100 | Closed before TP1 (loss)';
  assert.deepEqual(brief(parseAlertAll(alert(msg), true)), ['exit:long:flip']);
  assert.deepEqual(brief(extractEvents([alert(msg)], [], v2)), ['exit:long:flip']);
  // the reader the record was earned under is unchanged: it files the close for the short
  assert.deepEqual(brief(extractEvents([alert(msg)], [], v1)), ['exit:short:flip']);
  // the mirror was already right, and stays right
  const back = '🔄 REVERSAL | BTCUSD | Short → Long | Prev entry: 100';
  assert.deepEqual(brief(extractEvents([alert(back)], [], v2)), ['exit:short:flip']);
  assert.deepEqual(brief(extractEvents([alert(back)], [], v1)), ['exit:short:flip']);
  // "REVERSAL → LONG" names only the new side: the previous (short) trade closed, as before
  assert.deepEqual(brief(extractEvents([alert('🔄 REVERSAL → LONG | ETHUSD')], [], v2)), ['exit:short:flip']);
  assert.deepEqual(brief(extractEvents([alert('REVERSAL | Long -> Short')], [], v2)), ['exit:long:flip']);
});

test('a condition that closes a position is an exit for that side, not an entry', () => {
  for (const [title, side] of [['⬛ Cierre Long', 'long'], ['CIERRE SHORT por cruce alcista SMA', 'short'], ['Salida Long', 'long'], ['Long Win', 'long'], ['Short Loss', 'short']] as const) {
    assert.deepEqual(brief(extractEvents([cond(title)], [], v2)), [`exit:${side}:close`], title);
  }
  // under the old reader these were entries on the named side
  assert.deepEqual(brief(extractEvents([cond('⬛ Cierre Long')], [], v1)), ['entry:long']);
  assert.deepEqual(brief(extractEvents([cond('Long Win')], [], v1)), ['entry:long']);
});

test('an alert() that closes a position is an exit; one that reports a failed pattern is information', () => {
  assert.deepEqual(brief(extractEvents([alert('CIERRE LONG por cruce bajista SMA | ETHUSD')], [], v2)), ['exit:long:close']);
  assert.deepEqual(brief(extractEvents([alert('CIERRE LONG por cruce bajista SMA | ETHUSD')], [], v1)), ['entry:long']);
  const failed = extractEvents([alert('Bullish Measured Move Invalidated | BTCUSD | Price: 100')], [], v2);
  assert.deepEqual(brief(failed), ['info:-']);
  assert.deepEqual(brief(extractEvents([alert('Bullish Measured Move Invalidated | BTCUSD | Price: 100')], [], v1)), ['entry:long']);
});

test('failure titles are not entries on any channel', () => {
  const drops: Record<string, number> = {};
  const titles = ['Bullish Measured Move Invalidated', 'Bearish Band Walk Ended', 'Support lost', 'Main Chart Bull Brake'];
  assert.deepEqual(extractEvents(titles.map(t => cond(t)), [], { ...v2, drops }), []);
  assert.equal(drops['condition: a failed pattern or a closed trade, not an entry'], 4);
  // a shape is not rescued by its geometry
  assert.deepEqual(brief(extractEvents([], [shape('Salida Long', { shape: 'triangleup', location: 'belowbar' })], v2)), ['exit:long:close']);
  assert.deepEqual(brief(extractEvents([], [shape('Salida Long', { shape: 'triangleup', location: 'belowbar' })], v1)), ['entry:long']);
  const label: WorkerLabel = { time: T, createdAt: T, y: 1, text: 'Support lost', style: 'label_up' } as WorkerLabel;
  assert.deepEqual(extractEvents([], [], { ...v2, drawn: [label], sources: ['label'] }), []);
});

test('"Dn" is a direction, and a contract still decides what it names', () => {
  const up = shape('Break Up'), dn = shape('Break Dn');
  assert.deepEqual(brief(extractEvents([], [up, dn], v2)), ['entry:long', 'entry:short']);
  assert.deepEqual(brief(extractEvents([], [up, dn], v1)), ['entry:long']);
  // the trend-flip markers of a classifier are not entries: its contract keeps both off, with or without the fix
  const flips = [shape('ST Flip Up'), shape('ST Flip Dn')];
  const contract = { 'st flip up': 'none', 'st flip dn': 'none' } as const;
  assert.deepEqual(extractEvents([], flips, { ...v2, sides: contract }), []);
  assert.deepEqual(brief(extractEvents([], [shape('Break Dn')], { ...v2, sides: { 'break dn': 'long' } })), ['entry:long']);
  assert.deepEqual(brief(extractEvents([cond('Breakout Dn')], [], v2)), ['entry:short']);
});

test('genuine buy and sell entries are untouched by the fixes', () => {
  for (const opts of [v1, v2]) {
    assert.deepEqual(brief(extractEvents([], [shape('SELL', { shape: 'labeldown', location: 'abovebar' })], opts)), ['entry:short']);
    assert.deepEqual(brief(extractEvents([cond('Sell Signal')], [], opts)), ['entry:short']);
    assert.deepEqual(brief(extractEvents([alert('🟢 LONG | BTCUSD | Price: 100 | SL: 95 | TP1: 110')], [], opts)), ['entry:long']);
    assert.deepEqual(brief(extractEvents([alert('🛑 SL HIT | BTCUSD | Long | Entry: 100 | SL: 95')], [], opts)), ['exit:long:sl']);
    assert.deepEqual(brief(extractEvents([cond('Exit Long')], [], opts)), ['exit:long:close']);
    assert.deepEqual(brief(extractEvents([cond('Bullish Breakout')], [], opts)), ['entry:long']);
  }
});

test('the reader revision travels with the reading, so opting in is part of the record', () => {
  assert.equal(readingOf({ reader: 2 } as any, 'x', 900_000).extract.reader, 2);
  assert.equal(readingOf({}, 'x', 900_000).extract.reader, undefined);
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.scanners = { a: { enabled: false, symbols: null, timeframes: null, exitMode: 'both', reader: 2 }, b: { enabled: false, symbols: null, timeframes: null, exitMode: 'both', reader: 3 as any } };
  const errs = validateConfig(cfg);
  assert.equal(errs.some(e => e.startsWith('scanners.a.')), false);
  assert.ok(errs.includes('scanners.b.reader must be 1 or 2'));
});

test('closing shape and label titles cannot create entries; explicit contracts keep precedence',()=>{
 for(const title of ['Long Win','Short Loss','Salida Long']){
  assert.equal(extractEvents([], [shape(title)],v2)[0].kind,'exit');
  assert.equal(extractEvents([],[],{...v2,sources:['label'],drawn:[{text:title,time:T,createdAt:T,y:1} as WorkerLabel]})[0].kind,'exit');
  assert.deepEqual(extractEvents([cond(title)],[],{...v2,sides:{[title]:'none'}}),[]);
 }
});

test('opted-in label closes pass entry-channel filters while timestamp-less labels never invent exits',()=>{
 const drawn=[{text:'Long Win',time:T-900000,createdAt:T,y:1} as WorkerLabel];
 assert.deepEqual(brief(extractEvents([],[],{...v2,sources:['shape'],declared:new Set(['shape']),drawn})),['exit:long:close']);
 assert.deepEqual(extractEvents([],[],{...v1,sources:['shape'],drawn}),[]);
 assert.deepEqual(extractEvents([],[],{...v2,drawn:[{...drawn[0],createdAt:undefined}]}),[]);
});
