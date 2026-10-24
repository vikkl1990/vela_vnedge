import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG, validateConfig } from '../config.ts';
import { PaperEngine } from './engine.ts';
import { exitConfigFor } from './logic.ts';
import { lockStudy } from '../analytics/lockStudy.ts';

test('decision 197: a per-timeframe exit rule applies to its timeframe only, under the market\'s and the scanner\'s', () => {
  const p = structuredClone(DEFAULT_CONFIG.paper);
  p.exitByTf = { '15m': { floorAtR: 0.3, floorKeepR: 0.1 } };
  assert.equal(exitConfigFor(p, 'BTCUSD', undefined, '15m').floorAtR, 0.3);
  assert.equal(exitConfigFor(p, 'BTCUSD', undefined, '1h').floorAtR, p.floorAtR);
  p.exitBySymbol = { BTCUSD: { floorAtR: 0.4 } };
  assert.equal(exitConfigFor(p, 'BTCUSD', undefined, '15m').floorAtR, 0.4, 'the market\'s rule sits above the timeframe\'s');
  assert.equal(exitConfigFor(p, 'BTCUSD', { floorAtR: 0.6 }, '15m').floorAtR, 0.6, 'the scanner\'s own rule wins');
  const bad = structuredClone(DEFAULT_CONFIG); bad.paper.exitByTf = { '15m': { floorAtR: 0.1, floorKeepR: 0.3 }, '7m': {} };
  const errs = validateConfig(bad).join(' | ');
  assert.match(String(errs), /exitByTf\.15m\.floorKeepR/); assert.match(String(errs), /exitByTf\.7m: unknown timeframe/);
});

test('decision 197: in the engine, the 15m lock closes a 15m trade back at +0.1R while the same path leaves a 1h trade open', () => {
  const db = new Db(':memory:');
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, { slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false, latencyMs: 0, trailAfterR: 0, floorAtR: 0, floorKeepR: 0, limitEntry: { ...cfg.paper.limitEntry!, enabled: false }, exitByTf: { '15m': { floorAtR: 0.3, floorKeepR: 0.1 } } });
  const engine = new PaperEngine(db, () => cfg);
  const open = (symbol: string, tf: string) => engine.onEntry({ kind: 'entry', side: 'long', price: 100, sl: 95, tp: [130], label: 'e', message: '', source: 'alert', barTime: 0, barIndex: 0 }, { scannerId: 's' + tf, scannerName: 's', symbol, tf, market: { tickSize: 0.01, contractValue: 1 }, refPrice: 100, at: 60_010, signalId: null, exitMode: 'both' }).position!;
  const a = open('AUSD', '15m'), b = open('BUSD', '1h');
  for (const sym of ['AUSD', 'BUSD']) {
    engine.onBar(sym, { time: 120_000, high: 101.6, low: 100.2, close: 101.5 } as any, 180_000);   // +0.32R
    engine.onBar(sym, { time: 180_000, high: 101.0, low: 100.3, close: 100.4 } as any, 240_000);   // back to +0.06R
  }
  const pa = engine.position(a.id)!, pb = engine.position(b.id)!;
  assert.equal(pa.status, 'closed');
  assert.ok(Math.abs((pa.exitPrice ?? 0) - 100.5) < 1e-6, `closed at the +0.1R level, got ${pa.exitPrice}`);
  assert.equal(pb.status, 'open', 'the 1h trade has no lock');
});

test('decision 197: the study keeps a trade as it was unless the lock fires, then closes the rest at the level with its own fee and slippage', () => {
  const db = new Db(':memory:');
  const paper = { ...structuredClone(DEFAULT_CONFIG.paper), slippageBps: 2, feeRatePct: 0.05, feeTaxPct: 18, depthUsdPerBp: 0 };
  const T = 1_800_000_000_000;
  const add = (id: number, bt: number, tf: string, pnl: number, fees: number, peak: number, path: Array<[number, number]>) => {
    db.run("INSERT INTO positions(id, status, scanner_id, scanner_name, symbol, tf, side, qty, qty_open, contract_value, entry_price, entry_at, sl, sl_original, realized_pnl, fees, risk_amount, exit_at, exit_reason, bt, peak_r, fills) VALUES (?,'closed','s','s','XUSD',?,'long',10,0,1,100,?,95,95,?,?,50,?,'sl',?,?,?)",
      id, tf, T, pnl, fees, T + 3600_000, bt, peak, JSON.stringify({ fills: [{ at: T, price: 100, qty: 10, reason: 'entry', fee: 0.59, pnl: 0 }] }));
    for (const [m, r] of path) db.run('INSERT INTO position_path(position_id, at, price, r) VALUES (?,?,?,?)', id, T + m * 60_000, 100 + r * 5, r);
  };
  add(1, 0, '15m', -50, 1.2, 0.4, [[1, 0.2], [2, 0.4], [3, 0.05], [4, -1]]);   // reached +0.4R, fell through +0.1R, stopped: rescued
  add(2, 0, '15m', 100, 1.2, 2.1, [[1, 0.35], [2, 0.08], [3, 1], [4, 2]]);      // dipped to +0.08R, then ran to +2R: cut short
  add(3, 2, '4h', -50, 1.2, 0.2, [[1, 0.2], [2, -1]]);                         // never armed: unchanged
  const s = lockStudy(db, paper, { since: T - 1, now: T + 7200_000 });
  const acc = s.rows.find(r => r.book === 'account' && r.tf === '15m')!;
  // the lock fill: 100.5 less 2 bps, on 10 contracts; the entry fee as recorded, the exit fee at the taker rate with tax
  const fill = 100.5 * (1 - 2 / 10_000), exitFee = fill * 10 * 0.0005 * 1.18;
  const lockR = ((fill - 100) * 10 - 0.59 - exitFee) / 50;
  assert.equal(acc.fired, 2);
  assert.equal(acc.rescued, 1); assert.equal(acc.cutShort, 1);
  assert.ok(Math.abs(acc.rescuedR - (lockR - (-51.2 / 50))) < 1e-9);
  assert.ok(Math.abs(acc.cutShortR - ((98.8 / 50) - lockR)) < 1e-9);
  const sh = s.rows.find(r => r.book === 'shadow')!;
  assert.deepEqual([sh.fired, sh.deltaR], [0, 0]);
  assert.equal(s.assumptions.length, 5);
});
