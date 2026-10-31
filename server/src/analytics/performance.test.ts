import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { performanceReport } from './performance.ts';
import { dailyReport } from './daily.ts';

const DAY = 86_400_000, start = Date.UTC(2026, 9, 30), now = start + DAY + 1234;
function insert(db: Db, opts: Partial<{ bt: number; at: number; pnl: number; fees: number; risk: number; reason: string; status: string; symbol: string; scanner: string; tf: string; side: string; fills: string }> = {}) {
  const o = { bt: 0, at: start, pnl: 11, fees: 1, risk: 10, reason: 'trail', status: 'closed', symbol: 'ETHUSD', scanner: 's', tf: '15m', side: 'long', fills: '[]', ...opts };
  db.run('INSERT INTO positions(status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at,exit_at,realized_pnl,fees,risk_amount,exit_reason,bt,fills) VALUES (?,?,?,?,?,?,1,0,1,100,?,?,?,?,?,?,?,?)',
    o.status, o.scanner, `Scanner ${o.scanner}`, o.symbol, o.tf, o.side, o.at - 3600_000, o.at, o.pnl, o.fees, o.risk, o.reason, o.bt, o.fills);
}

test('performance applies identical closing bounds and filters, excludes open/backtest/archive/future trades', () => {
  const db = new Db(':memory:');
  for (const bt of [0, 2]) {
    insert(db, { bt }); insert(db, { bt, at: start - 1 }); insert(db, { bt, at: start + DAY });
    insert(db, { bt, symbol: 'BTCUSD' }); insert(db, { bt, scanner: 'other' });
    insert(db, { bt, tf: '1h' }); insert(db, { bt, side: 'short' }); insert(db, { bt, reason: 'sl' });
    insert(db, { bt, status: 'open' }); insert(db, { bt, at: now + 100 });
  }
  insert(db, { bt: 1 }); insert(db, { bt: 3 });
  const r = performanceReport(db, { from: start, to: start + DAY, symbol: 'ETHUSD', scanner: 's', tf: '15m', side: 'long', reason: 'trail' }, now);
  assert.equal(r.paper.trades, 1); assert.equal(r.shadow.trades, 1);
  assert.equal(r.paper.net, 10); assert.equal(r.shadow.avgR, 1);
  assert.equal(r.daily.length, 1); assert.equal(r.firstClose, start); assert.equal(r.lastClose, start);
  assert.equal(performanceReport(db, { from: now }, now).paper.trades, 0);
  assert.throws(() => performanceReport(db, { from: NaN }, now));
  assert.throws(() => performanceReport(db, { from: start, to: start }, now));
  assert.throws(() => performanceReport(db, { side: 'up' }, now));
});

test('net equals trading P&L minus commission plus signed funding; group totals reconcile', () => {
  const db = new Db(':memory:');
  insert(db, { pnl: 8, fees: 2, fills: JSON.stringify({ fills: [{ reason: 'funding', pnl: -3 }, { reason: 'funding', pnl: 1 }] }) });
  insert(db, { pnl: -8, fees: 2, reason: 'sl', scanner: 'other', tf: '1h', symbol: 'BTCUSD', at: start + DAY });
  insert(db, { bt: 2, pnl: 5, fees: 1 });
  const r = performanceReport(db, {}, now), s = r.paper;
  assert.equal(s.net, -4); assert.equal(s.commission, 4); assert.equal(s.funding, -2); assert.equal(s.grossTrading, 2);
  assert.equal(s.grossTrading - s.commission + s.funding, s.net);
  assert.equal(s.avgCommissionR, 0.2); assert.equal(s.avgR, -0.2); assert.equal(s.winRate, 50); assert.equal(s.stopRate, 50); assert.equal(s.profitFactor, 0.6);
  for (const group of [r.byTf, r.byScanner, r.bySymbol, r.byExit, r.daily]) {
    assert.equal(group.reduce((n, g) => n + g.paper.net, 0), s.net);
    assert.equal(group.reduce((n, g) => n + g.shadow.trades, 0), 1);
  }
  assert.equal(r.daily[1].shadow.avgR, null, 'no closes is not a 0R observation');
});

test('tracker exclusion affects shadow only; Daily retains every paper close too', () => {
  const db = new Db(':memory:');
  insert(db); insert(db, { bt: 2 });
  db.run("INSERT INTO incubator_pairs(scanner_id,symbol,tf,stage,since,updated) VALUES ('s','ETHUSD','15m','tracked',?,?)", start, start);
  const r = performanceReport(db, {}, now);
  assert.equal(r.paper.trades, 1); assert.equal(r.shadow.trades, 0);
  const d = dailyReport(db, 1000, 2, now)[1];
  assert.equal(d.account.net, r.paper.net); assert.equal(d.account.trades, 1); assert.equal(d.shadow.trades, 0);
});

test('missing risk and corrupt fill data are explicit; empty and no-loss books are not zero-expectancy claims', () => {
  const db = new Db(':memory:');
  insert(db, { risk: 0, pnl: -4, fills: 'broken' }); insert(db);
  const r = performanceReport(db, {}, now);
  assert.equal(r.paper.trades, 2); assert.equal(r.paper.rTrades, 1); assert.equal(r.paper.avgR, 1);
  assert.equal(r.paper.net, 5); assert.equal(r.paper.fundingUnknown, 1);
  assert.equal(r.shadow.avgR, null); assert.equal(r.shadow.winRate, null); assert.equal(r.shadow.profitFactor, null); assert.equal(r.shadow.noLosses, false);
  const winners = performanceReport(db, { from: start, symbol: 'ETHUSD' }, now);
  assert.equal(winners.paper.profitFactor, 2);
  insert(db, { bt: 2 });
  assert.equal(performanceReport(db, {}, now).shadow.noLosses, true);
});

test('performance does not truncate history at the old 5000-trade limit', () => {
  const db = new Db(':memory:');
  db.run('BEGIN');
  for (let i = 0; i < 5001; i++) insert(db);
  db.run('COMMIT');
  const r = performanceReport(db, {}, now);
  assert.equal(r.paper.trades, 5001); assert.equal(r.paper.net, 50010); assert.equal(r.paper.avgR, 1);
});

test('paired execution plans do not inflate ordinary shadow performance or daily evidence',()=>{
 const db=new Db(':memory:');insert(db,{bt:2});insert(db,{bt:2,scanner:'plan:ltm:v1:hash',pnl:10000});
 assert.equal(performanceReport(db,{},now).shadow.trades,1);
 assert.equal(dailyReport(db,1000,2,now)[1].shadow.trades,1);db.db.close();
});
