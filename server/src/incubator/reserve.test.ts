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

test('decisions 186/200: a failed re-screen retires a shadow pair only when its own record agrees; a passing one, a winning one or one still collecting stays', () => {
  const { store, cfg, screen } = world([]);
  cfg.incubator.maxShadow = 10;
  const pairs = [['a', 'ZECUSD'], ['b', 'AKEUSD'], ['c', 'SOLUSD'], ['d', 'ETHUSD']] as const;
  for (const [s, m] of pairs) recordScreen(store, { scannerId: s, symbol: m, tf: '4h' }, screen(2), cfg.incubator, T0);
  evaluate(store, cfg, T0);
  for (const [s, m] of pairs) assert.equal(store.find(s, m, '4h')!.stage, 'shadow');
  // shadow records since admission: a loses over 3 trades, c wins over 3, d has only 2 (losing)
  const db = (store as any).db;
  let id = 1000;
  const trade = (s: string, m: string, r: number) => db.run("INSERT INTO positions(id, status, scanner_id, scanner_name, symbol, tf, side, qty, qty_open, contract_value, entry_price, entry_at, exit_at, realized_pnl, fees, risk_amount, bt) VALUES (?,'closed',?,?,?,'4h','long',1,0,1,100,?,?,?,0,10,2)", id++, s, s, m, T0 + 100, T0 + 200, r * 10);
  for (const r of [-1, -1, 0.5]) trade('a', 'ZECUSD', r);
  for (const r of [1, -1, 2]) trade('c', 'SOLUSD', r);
  for (const r of [-1, -1]) trade('d', 'ETHUSD', r);
  const fail = { ...screen(0.9), pass: false, at: T0 + 2000, reason: 'PF 0.90' };
  for (const [s, m] of [['a', 'ZECUSD'], ['c', 'SOLUSD'], ['d', 'ETHUSD']] as const) recordScreen(store, { scannerId: s, symbol: m, tf: '4h' }, fail, cfg.incubator, T0 + 2000);
  recordScreen(store, { scannerId: 'b', symbol: 'AKEUSD', tf: '4h' }, { ...screen(1.8), at: T0 + 2000 }, cfg.incubator, T0 + 2000);
  const rep = evaluate(store, cfg, T0 + 3000);
  assert.ok(rep.retired.includes('a ZECUSD 4h'), rep.retired.join(', '));
  assert.match(store.find('a', 'ZECUSD', '4h')!.note ?? '', /screen no longer passes .* and the shadow record agrees \(3 trades, -1\.50R\)/);
  assert.equal(store.find('b', 'AKEUSD', '4h')!.stage, 'shadow', 're-screened and still passing: kept');
  assert.equal(store.find('c', 'SOLUSD', '4h')!.stage, 'shadow', 'failed the re-screen but winning in the shadow book: kept');
  assert.equal(store.find('d', 'ETHUSD', '4h')!.stage, 'shadow', 'failed with only 2 shadow trades: still collecting');
});

test('admission prefers a judgeable sample over a slower higher backtest score without enlarging capacity',()=>{
 const {store,cfg,screen}=world([]);cfg.incubator.maxShadow=1;
 recordScreen(store,{scannerId:'slow',symbol:'BTCUSD',tf:'15m'},{...screen(3),days:400},cfg.incubator,T0);
 recordScreen(store,{scannerId:'fast',symbol:'ETHUSD',tf:'15m'},{...screen(1.8),days:20},cfg.incubator,T0);
 evaluate(store,cfg,T0);
 assert.equal(store.find('fast','ETHUSD','15m')!.stage,'shadow');
 assert.equal(store.find('slow','BTCUSD','15m')!.stage,'candidate');
 assert.equal(store.list(['shadow']).length,1);
 const e=store.events(10).find(e=>e.to==='shadow')!;
 assert.ok(e.evidence.admissionEvidence.estimatedDays>0);
});
