import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { dailyReport, dailyText } from './daily.ts';

test('the daily report counts each book on the day its trades closed, net of fees, and the incubator moves', () => {
  const db = new Db(':memory:'); const D = 86_400_000; const now = Date.UTC(2026, 9, 19, 10);
  const yesterday = Date.UTC(2026, 9, 18, 12);
  const ins = (bt: number, exitAt: number, pnl: number, fees: number, reason: string, peak: number, tf = '15m') => db.run(
    "INSERT INTO positions(status, scanner_id, scanner_name, symbol, tf, side, qty, qty_open, contract_value, entry_price, entry_at, exit_at, realized_pnl, fees, risk_amount, exit_reason, peak_r, bt) VALUES ('closed','s','S','XUSD',?,'long',1,0,1,100,?,?,?,?,10,?,?,?)",
    tf, exitAt - 3600_000, exitAt, pnl, fees, reason, peak, bt);
  ins(0, yesterday, 6, 1, 'trail', 1.0); ins(0, yesterday, -9.5, 0.5, 'sl', 0.1); ins(2, yesterday, 20, 0, 'trail', 2.5, '4h');
  db.run("INSERT INTO incubator_events(at, pair_id, scanner_id, symbol, tf, from_stage, to_stage, actor) VALUES (?,1,'s','XUSD','15m','candidate','shadow','screen')", yesterday);
  const rows = dailyReport(db, 1000, 3, now);
  assert.equal(rows.length, 3); assert.equal(rows[0].partial, true);
  const y = rows[1];
  assert.equal(y.day, '2026-10-18'); assert.equal(y.account.trades, 2); assert.equal(y.account.net, -5);
  assert.equal(y.account.stops, 1); assert.equal(y.account.trails, 1);
  assert.equal(Math.round(y.account.trailKeeps! * 100), 50, 'the trail exit banked 0.5R of a 1R peak');
  assert.equal(y.shadow.byTf['4h'].sumR, 2); assert.equal(y.incubator.admitted, 1);
  assert.equal(y.equity, 995);
  assert.equal(y.account.marginSumR, y.account.sumR, 'with no leverage recorded the margin weight is 1'); assert.match(dailyText(rows), /VNEdge daily report 2026-10-18/);
  assert.equal(rows[2].account.trades, 0);
  void D;
});
