import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerAlerts, restingLevels } from './strategyLedger.ts';
import { extractEvents } from '../scanners/extractor.ts';

const timeAt = (i: number) => i * 1000;

test('decision 111: a last-bar entry carries the stop and limit the strategy has resting; earlier fills do not', () => {
  const st = {
    closedtrades: [{ id: 't1', entry_id: 'L', size: 1, status: 'closed' as const, entry_bar_index: 10, entry_price: 100, exit_bar_index: 14, exit_price: 104 }],
    opentrades: [{ id: 't2', entry_id: 'L', size: 1, status: 'open' as const, entry_bar_index: 20, entry_price: 110 }],
    pending_orders: [
      { id: 'x1', status: 'pending' as const, category: 'exit' as const, type: 'stop' as const, stop: 107.5, from_entry: 'L' },
      { id: 'x2', status: 'pending' as const, category: 'exit' as const, type: 'limit' as const, limit: 115, from_entry: 'L' },
      { id: 'x3', status: 'pending' as const, category: 'exit' as const, type: 'limit' as const, limit: 120, from_entry: 'L' },
      { id: 'e9', status: 'pending' as const, category: 'entry' as const, type: 'stop' as const, stop: 125, direction: 1 },
    ],
  };
  const out = ledgerAlerts(st, 0, 20, timeAt);
  assert.deepEqual(out.map(a => a.message), ['STRATEGY entry long @ 100', 'STRATEGY exit long @ 104', 'STRATEGY entry long @ 110 sl=107.5 tp=115,120']);
  // the same ledger read when the open trade is NOT on the last bar: no levels attached (history stays as it was)
  const later = ledgerAlerts(st, 0, 25, timeAt);
  assert.equal(later[2].message, 'STRATEGY entry long @ 110');
  // the extractor turns the levels into the entry's own stop and targets
  const ev = extractEvents(out.map(a => ({ ...a })) as any, []);
  const last = ev.find(e => e.barTime === 20_000)!;
  assert.deepEqual([last.kind, last.side, last.price, last.sl, last.tp], ['entry', 'long', 110, 107.5, [115, 120]]);
  const first = ev.find(e => e.barTime === 10_000)!;
  assert.deepEqual([first.sl, first.tp], [undefined, []]);
});

test('decision 111: resting levels must sit on the right side, a short takes the stop above and limits below, and the nearest stop wins', () => {
  const t = { id: 's1', entry_id: 'S', size: -2, status: 'open' as const, entry_bar_index: 5, entry_price: 50 };
  const lv = restingLevels(t, [
    { status: 'pending', category: 'exit', type: 'stop', stop: 53, from_entry: 'S' },
    { status: 'pending', category: 'exit', type: 'stop', stop: 52, from_entry: 'S' },
    { status: 'pending', category: 'exit', type: 'limit', limit: 47, from_entry: 'S' },
    { status: 'pending', category: 'exit', type: 'limit', limit: 55, from_entry: 'S' },   // wrong side for a short: ignored
    { status: 'filled', category: 'exit', type: 'stop', stop: 51, from_entry: 'S' },      // already filled: ignored
    { status: 'pending', category: 'exit', type: 'stop', stop: 54, from_entry: 'OTHER' }, // another entry's bracket: ignored
  ], 2);
  assert.deepEqual(lv, { sl: 52, tp: [47] });
  // an exit order naming no entry belongs to the position only when it is the one open trade
  assert.deepEqual(restingLevels(t, [{ status: 'pending', category: 'exit', type: 'stop', stop: 52 }], 1), { sl: 52, tp: [] });
  assert.deepEqual(restingLevels(t, [{ status: 'pending', category: 'exit', type: 'stop', stop: 52 }], 2), { sl: undefined, tp: [] });
});

test('an exit that leaves other trades of the strategy open is marked partial; closing the whole position is not', () => {
  const partial = {
    closedtrades: [{ id: 't1', entry_id: 'L', size: 1, status: 'closed' as const, entry_bar_index: 10, entry_price: 100, exit_bar_index: 14, exit_price: 104 }],
    opentrades: [{ id: 't2', entry_id: 'L', size: 1, status: 'open' as const, entry_bar_index: 10, entry_price: 100 }],
  };
  const out = ledgerAlerts(partial, 0, 20, timeAt);
  assert.equal(out.find(a => a.barIndex === 14)!.message, 'STRATEGY exit long @ 104 partial=1');
  // the extractor keeps it an exit but says it is partial, so a consumer that cannot replicate a partial close can refuse it
  const ev = extractEvents(out.map(a => ({ ...a })) as any, []).find(e => e.kind === 'exit')!;
  assert.equal(ev.partial, true);
  // two entries that the strategy closes on the same bar leave the position flat: a whole closure
  const whole = {
    closedtrades: [
      { id: 't1', size: 1, status: 'closed' as const, entry_bar_index: 10, entry_price: 100, exit_bar_index: 14, exit_price: 104 },
      { id: 't2', size: 1, status: 'closed' as const, entry_bar_index: 12, entry_price: 102, exit_bar_index: 14, exit_price: 104 },
    ],
    opentrades: [],
  };
  const w = ledgerAlerts(whole, 0, 20, timeAt).filter(a => a.barIndex === 14);
  assert.equal(w.length, 1);
  assert.equal(w[0].message, 'STRATEGY exit long @ 104');
  assert.equal(extractEvents(w.map(a => ({ ...a })) as any, [])[0].partial, undefined);
  // a short that is still open does not make a long's exit partial
  const mixed = {
    closedtrades: [{ id: 't1', size: 1, status: 'closed' as const, entry_bar_index: 10, entry_price: 100, exit_bar_index: 14, exit_price: 104 }],
    opentrades: [{ id: 't2', size: -1, status: 'open' as const, entry_bar_index: 12, entry_price: 102 }],
  };
  assert.equal(ledgerAlerts(mixed, 0, 20, timeAt).find(a => a.barIndex === 14)!.message, 'STRATEGY exit long @ 104');
});
