import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shadowRefusal } from './shadow.ts';
import { regimeRefusal } from '../risk/manager.ts';
import type { Bar } from '../data/candleStore.ts';

const T = Date.UTC(2026, 9, 14, 12); // a Wednesday
const chop: Bar[] = Array.from({ length: 40 }, (_, i) => { const c = 100 + (i % 2 ? 1 : -1); return { time: T + i * 900_000, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1 }; });
const trend: Bar[] = Array.from({ length: 40 }, (_, i) => { const c = 100 + i; return { time: T + i * 900_000, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1 }; });
const regime = { enabled: true, minAtrPct: 0.3, noWeekend: false, exempt: [], minEr: 0.25 };

test('decision 112: the regime gate is one function for the account and the shadow book', () => {
  assert.match(regimeRefusal(regime, 's', { at: T, price: 100, atr: 1 }, chop) ?? '', /choppy/);
  assert.equal(regimeRefusal(regime, 's', { at: T, price: 139, atr: 1 }, trend), null);
  assert.match(regimeRefusal(regime, 's', { at: T, price: 100, atr: 0.1 }, trend) ?? '', /ATR 0.10%/);
  assert.equal(regimeRefusal({ ...regime, exempt: ['exempt-one'] }, 'exempt-one', { at: T, price: 100, atr: 1 }, chop), null, 'an exempt scanner passes');
  assert.equal(regimeRefusal({ ...regime, enabled: false }, 's', { at: T, price: 100, atr: 1 }, chop), null, 'a disabled gate passes');
  assert.match(regimeRefusal({ ...regime, noWeekend: true }, 's', { at: Date.UTC(2026, 9, 17), price: 100, atr: 1 }, trend) ?? '', /weekend/);
});

test('decision 112: a shadow entry is refused by the market gate, then by the regime gate, and otherwise passes', () => {
  const base = { regime, scannerId: 's', symbol: 'ETHUSD', at: T, price: 100, atr: 1, bars: trend, market: { allowed: true, reasons: [] } };
  assert.equal(shadowRefusal(base), null);
  const m = shadowRefusal({ ...base, market: { allowed: false, reasons: ['dead: $0.02M 24h turnover < $0.05M'] } });
  assert.deepEqual(m, { kind: 'market', reason: 'market: dead: $0.02M 24h turnover < $0.05M' });
  const r = shadowRefusal({ ...base, bars: chop });
  assert.equal(r?.kind, 'regime'); assert.match(r?.reason ?? '', /choppy/);
  // the market gate has not judged the symbol: nothing to refuse on
  assert.equal(shadowRefusal({ ...base, market: null }), null);
});
