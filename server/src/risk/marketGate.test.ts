import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { MarketGate } from './marketGate.ts';

function bars(n: number, price: number, rangePct: number) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ time: i * 900_000, open: price, high: price * (1 + rangePct / 100), low: price * (1 - rangePct / 100), close: price, volume: 1 });
  return out;
}

test('markets today: dead, costly-book, thin-book, too quiet and losing markets are blocked; the rest allowed; exempt always allowed', async t => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.risk.marketGate = { enabled: true, tf: '15m', minTurnoverUsd: 1_000_000, probeNotionalUsd: 2_500, maxBookCostPct: 0.25, minAtrFeeMult: 4, lookbackDays: 14, minTrades: 3, minPf: 1, refreshMinutes: 60, exempt: ['EXEMPTUSD'] };
  const now = 100 * 86_400_000;
  // a losing recent record on LOSERUSD: three closed trades, two losers
  for (const pnl of [5, -10, -8]) db.run("INSERT INTO positions(status, scanner_id, scanner_name, symbol, tf, side, qty, qty_open, contract_value, entry_price, entry_at, realized_pnl, fees, exit_at, bt) VALUES ('closed','s','s','LOSERUSD','15m','long',1,0,1,1,?,?,0,?,0)", now - 86_400_000, pnl, now - 3_600_000);
  const candles = { get: (symbol: string) => symbol === 'QUIETUSD' ? bars(60, 100, 0.05) : symbol === 'NOCANDLESUSD' ? [] : bars(60, 100, 1.0) };
  // books: tight (0.02% spread, deep), wide (0.3% spread), shallow (tight but only $500 a side), and one that cannot be read
  const tight = { bids: [[99.99, 100], [99.98, 100]] as Array<[number, number]>, asks: [[100.01, 100], [100.02, 100]] as Array<[number, number]> };
  const wide = { bids: [[99.85, 100]] as Array<[number, number]>, asks: [[100.15, 100]] as Array<[number, number]> };
  const shallow = { bids: [[99.99, 5]] as Array<[number, number]>, asks: [[100.01, 5]] as Array<[number, number]> };
  const book = async (symbol: string) => symbol === 'WIDEUSD' ? wide : symbol === 'SHALLOWUSD' ? shallow : symbol === 'NOBOOKUSD' ? Promise.reject(new Error('503')) : tight;
  const tick = (symbol: string, volume24h = 5e6, price = 100) => ({ symbol, volume24h, price });
  const gate = new MarketGate({ db, candles, book, markets: async () => [{ ...tick('NVDAXUSD'), description: 'NVIDIA xStock Token perpetual future quoted in USD' }, { ...tick('VVVUSD'), description: 'Venice Token Perpetual future quoted in USD' }, tick('THINUSD', 200_000), tick('QUIETUSD'), tick('LOSERUSD', 5e6, 1), tick('GOODUSD'), tick('NOCANDLESUSD'), tick('WIDEUSD'), tick('SHALLOWUSD'), tick('NOBOOKUSD')], cfgRef: () => cfg, now: () => now });
  const r = await gate.refresh(['THINUSD', 'QUIETUSD', 'LOSERUSD', 'GOODUSD', 'NOCANDLESUSD', 'EXEMPTUSD', 'WIDEUSD', 'SHALLOWUSD', 'NOBOOKUSD', 'NVDAXUSD', 'VVVUSD']);
  const by = Object.fromEntries(r.markets.map(m => [m.symbol, m]));
  assert.equal(by.THINUSD.allowed, false); assert.match(by.THINUSD.reasons[0], /dead/);
  assert.equal(by.NVDAXUSD.allowed, false); assert.match(by.NVDAXUSD.reasons[0], /not crypto/);
  assert.equal(by.VVVUSD.allowed, true, 'Venice Token is crypto');
  assert.ok(!(await gate.universe([])).includes('NVDAXUSD'), 'tokenized stocks are not in the universe');
  assert.equal(by.WIDEUSD.allowed, false); assert.match(by.WIDEUSD.reasons[0], /costly book: 0.418% round trip/);
  assert.equal(by.SHALLOWUSD.allowed, false); assert.match(by.SHALLOWUSD.reasons[0], /thin book/);
  assert.equal(by.NOBOOKUSD.allowed, false, 'decision 82: an unread book is a refusal, not a pass'); assert.match(by.NOBOOKUSD.reasons.join(' '), /unavailable: order book/);
  assert.equal(by.NOBOOKUSD.bookCostPct, null);
  assert.ok(Math.abs(by.GOODUSD.bookCostPct! - (0.02 + 0.118)) < 1e-9, `tight book costs spread + fee, got ${by.GOODUSD.bookCostPct}`);
  assert.equal(by.QUIETUSD.allowed, false); assert.match(by.QUIETUSD.reasons[0], /too quiet/);
  assert.equal(by.LOSERUSD.allowed, false); assert.match(by.LOSERUSD.reasons[0], /not paying: PF 0.28 over 3 trades/);
  assert.equal(by.GOODUSD.allowed, true);
  assert.equal(by.NOCANDLESUSD.allowed, false, 'decision 82: a tracked market with no candles cannot pass the volatility test'); assert.match(by.NOCANDLESUSD.reasons.join(' '), /unavailable: no 15m candles/);
  assert.equal(by.EXEMPTUSD.allowed, true);
  assert.equal(gate.verdict('THINUSD')?.allowed, false);
  // decision 76: while the gate is on, a market it never judged and a verdict set gone stale are refusals, not passes
  const unknown = gate.verdict('NEVERJUDGEDUSD', now);
  assert.equal(unknown?.allowed, false); assert.match(unknown!.reasons[0], /not judged/);
  const later = now + (cfg.risk.marketGate.refreshMinutes * 3 + 1) * 60_000;
  const stale = gate.verdict('GOODUSD', later);
  assert.equal(stale?.allowed, false); assert.match(stale!.reasons[0], /min old/);
  assert.equal(gate.verdict('GOODUSD', now)?.allowed, true, 'fresh and judged: the real verdict');
  cfg.risk.marketGate.enabled = false;
  assert.equal(gate.verdict('THINUSD'), null, 'off → no opinion');
});
