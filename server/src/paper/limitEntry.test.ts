import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG, type AppConfig } from '../config.ts';
import { PaperEngine } from './engine.ts';

const H = 3600_000;
function setup(tf = '4h', over: Partial<AppConfig['paper']> = {}) {
  const db = new Db(':memory:');
  const cfg: AppConfig = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, { slippageBps: 0, feeRatePct: 0.05, makerFeeRatePct: 0.02, liquidation: false, latencyMs: 0, minRiskFeeRatio: 0, limitFill: 'through', limitEntry: { enabled: true, tfs: ['4h'], atr: 0.3, bars: 2, books: ['account', 'shadow'] } }, over);
  const engine = new PaperEngine(db, () => cfg);
  const at = Date.UTC(2026, 9, 24, 8, 0, 1);
  const enter = (side: 'long' | 'short' = 'long') => engine.onEntry({ kind: 'entry', side, price: 100, tp: [], label: 'entry', message: '', source: 'alert', barTime: at - 4 * H, barIndex: 0 }, { scannerId: 's', scannerName: 's', symbol: 'ETHUSD', tf, market: { tickSize: 0.01, contractValue: 1 }, refPrice: 100, at, signalId: null, exitMode: 'both', atr: 2 } as any);
  return { db, cfg, engine, at, enter };
}

test('decision 185: a 4h entry rests as a maker limit 0.3 ATR back, fills when price trades through it, with the stop measured from the fill', () => {
  const { engine, at, enter } = setup();
  const d = enter('long');
  assert.equal(d.action, 'pending'); assert.match(d.reason ?? '', /resting limit at 99.4/);
  assert.equal(engine.openPositions().length, 0);
  engine.onBar('ETHUSD', { time: at + 60_000, high: 100.5, low: 99.4, close: 99.8 }, at + 2 * 60_000);
  assert.equal(engine.openPositions().length, 0, 'a touch is not a fill under limitFill: through');
  engine.onBar('ETHUSD', { time: at + 2 * 60_000, high: 99.9, low: 99.3, close: 99.5 }, at + 3 * 60_000);
  const [p] = engine.openPositions();
  assert.ok(p, 'filled once price traded through');
  assert.equal(p.entryPrice, 99.4, 'at the limit price, no slippage');
  assert.ok(p.fees < 99.4 * p.qty * 0.0005, `a maker fee, under the taker rate: ${p.fees}`);
  assert.ok(Math.abs((p.slOriginal ?? 0) - (99.4 - 1.5 * 2)) < 1e-6, `the ATR stop from the fill: ${p.slOriginal}`);
});

test('decision 185: a limit that price never comes back to lapses after its bars; a short mirrors it', () => {
  const { engine, at, enter, db } = setup();
  const d = enter('short');
  assert.match(d.reason ?? '', /resting limit at 100.6/);
  engine.onBar('ETHUSD', { time: at + 60_000, high: 100.5, low: 99, close: 99.2 }, at + 2 * 60_000);
  assert.equal(engine.openPositions().length, 0);
  engine.housekeeping(at + 8 * H + 1000);
  assert.equal(engine.pendingEntries().length, 0, 'lapsed after two 4h bars');
  assert.equal(db.all("SELECT * FROM positions WHERE status='pending'").length, 0);
});

test('decision 185: a resting limit survives a restart; 15m entries and executor-mirrored books keep the market entry', () => {
  const a = setup();
  a.enter('long');
  const again = new PaperEngine(a.db, () => a.cfg);
  assert.equal(again.pendingEntries().length, 1, 'restored from its row');
  again.onBar('ETHUSD', { time: a.at + 60_000, high: 100, low: 99.3, close: 99.5 }, a.at + 2 * 60_000);
  assert.equal(again.openPositions().length, 1, 'and fills after the restart');

  const b = setup('15m');
  assert.notEqual(b.enter('long').action, 'pending', '15m is not in limitEntry.tfs: the market entry');
  const c = setup();
  c.engine.limitEntryAllowed = () => false;
  assert.notEqual(c.enter('long').action, 'pending', 'an executor attached: the market entry');
});
