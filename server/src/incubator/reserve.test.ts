import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG, type AppConfig } from '../config.ts';
import { IncubatorStore } from './store.ts';
import { evaluate, recordScreen } from './cycle.ts';

const T0 = Date.UTC(2026, 9, 1);
function world(reserve: AppConfig['incubator']['admit']['reserve']) {
  const db = new Db(':memory:');
  const store = new IncubatorStore(db);
  const cfg: AppConfig = structuredClone(DEFAULT_CONFIG);
  cfg.scanners = {};
  cfg.incubator.maxShadow = 4; cfg.incubator.gate.pool = 'pair';
  cfg.incubator.admit.maxPerScannerTf = { '15m': 10, '1h': 10, '4h': 10 };
  cfg.incubator.admit.reserve = reserve;
  const screen = (pf: number) => ({ pass: true, at: T0, trades: 40, profitFactor: pf, netPnl: 100, netAtStress: 50, windowsUp: 6, winRatePct: 50, avgR: 0.2, bars: 4000 } as any);
  return { store, cfg, screen };
}

test('decision 182: reservations admit 4h and majors candidates over a full book, by score, and count what is already running', () => {
  const { store, cfg, screen } = world([{ tfs: ['4h'], markets: ['BTCUSD', 'ETHUSD'], slots: 2 }, { tfs: ['4h'], slots: 3 }]);
  // the book fills with four 15m alts (the highest scores)
  for (const s of ['a', 'b', 'c', 'd']) recordScreen(store, { scannerId: s, symbol: 'ZECUSD', tf: '15m' }, screen(3), cfg.incubator, T0);
  // candidates the score alone would never admit: 4h on the majors and on alts, and a fifth 15m alt
  recordScreen(store, { scannerId: 'm1', symbol: 'BTCUSD', tf: '4h' }, screen(1.5), cfg.incubator, T0);
  recordScreen(store, { scannerId: 'm2', symbol: 'ETHUSD', tf: '4h' }, screen(1.4), cfg.incubator, T0);
  recordScreen(store, { scannerId: 'm3', symbol: 'SOLUSD', tf: '4h' }, screen(1.3), cfg.incubator, T0);
  recordScreen(store, { scannerId: 'x1', symbol: 'AKEUSD', tf: '4h' }, screen(1.6), cfg.incubator, T0);
  recordScreen(store, { scannerId: 'x2', symbol: 'AKEUSD', tf: '4h' }, screen(1.2), cfg.incubator, T0);
  recordScreen(store, { scannerId: 'x3', symbol: 'AKEUSD', tf: '4h' }, screen(1.1), cfg.incubator, T0);
  recordScreen(store, { scannerId: 'e', symbol: 'ZECUSD', tf: '15m' }, screen(1.1), cfg.incubator, T0);
  const rep = evaluate(store, cfg, T0);
  const shadow = store.list(['shadow']).map(r => `${r.scannerId} ${r.symbol} ${r.tf}`).sort();
  // the book: four 15m by score (the fifth 15m waits); the majors reservation: BTC and ETH 4h (SOL is third, no room);
  // the 4h reservation: three more 4h by score — x1, SOL (m3, matching but not counted by the first), x2
  assert.deepEqual(shadow, ['a ZECUSD 15m', 'b ZECUSD 15m', 'c ZECUSD 15m', 'd ZECUSD 15m', 'm1 BTCUSD 4h', 'm2 ETHUSD 4h', 'm3 SOLUSD 4h', 'x1 AKEUSD 4h', 'x2 AKEUSD 4h']);
  assert.equal(store.find('e', 'ZECUSD', '15m')!.stage, 'candidate', 'no reservation covers 15m: the book is full');
  assert.equal(store.find('x3', 'AKEUSD', '4h')!.stage, 'candidate', 'the 4h reservation holds three');
  assert.equal(rep.free, 0);
  // the next admission counts the running reserved pairs: nothing more is admitted
  recordScreen(store, { scannerId: 'x4', symbol: 'AKEUSD', tf: '4h' }, screen(2.5), cfg.incubator, T0 + 1000);
  evaluate(store, cfg, T0 + 2000);
  assert.equal(store.find('x4', 'AKEUSD', '4h')!.stage, 'candidate', 'reservations are full');
});

test('decision 182: without reservations a full book admits nothing', () => {
  const { store, cfg, screen } = world([]);
  for (const s of ['a', 'b', 'c', 'd']) recordScreen(store, { scannerId: s, symbol: 'ZECUSD', tf: '15m' }, screen(3), cfg.incubator, T0);
  recordScreen(store, { scannerId: 'm1', symbol: 'BTCUSD', tf: '4h' }, screen(1.5), cfg.incubator, T0);
  evaluate(store, cfg, T0);
  assert.equal(store.find('m1', 'BTCUSD', '4h')!.stage, 'candidate');
});

test('decision 184: pairs running under a reservation do not consume the book\'s own capacity', () => {
  const { store, cfg, screen } = world([{ tfs: ['4h'], slots: 5 }]);
  cfg.incubator.maxShadow = 3;
  // three 15m pairs fill the book; five 4h pairs fill the reservation
  for (const s of ['a', 'b', 'c']) recordScreen(store, { scannerId: s, symbol: 'ZECUSD', tf: '15m' }, screen(3), cfg.incubator, T0);
  for (const s of ['h1', 'h2', 'h3', 'h4', 'h5']) recordScreen(store, { scannerId: s, symbol: 'AKEUSD', tf: '4h' }, screen(2), cfg.incubator, T0);
  evaluate(store, cfg, T0);
  assert.equal(store.list(['shadow']).length, 8, 'the book (3) and the reservation (5) both filled');
  // one 15m pair retires; a new 15m candidate must get its slot back even though eight pairs are active
  store.move(store.find('a', 'ZECUSD', '15m')!, 'retired', 'test', null, 'gone', T0 + 1000);
  recordScreen(store, { scannerId: 'd', symbol: 'ZECUSD', tf: '15m' }, screen(2.5), cfg.incubator, T0 + 2000);
  const rep = evaluate(store, cfg, T0 + 3000);
  assert.equal(store.find('d', 'ZECUSD', '15m')!.stage, 'shadow', 'the reserved 4h pairs did not count against maxShadow');
  assert.equal(rep.free, 0);
});
