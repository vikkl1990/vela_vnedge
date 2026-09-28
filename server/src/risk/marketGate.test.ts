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

test('markets today: illiquid, too quiet and losing markets are blocked; the rest allowed; exempt always allowed', async t => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.risk.marketGate = { enabled: true, tf: '15m', minTurnoverUsd: 1_000_000, minAtrFeeMult: 4, lookbackDays: 14, minTrades: 3, minPf: 1, refreshMinutes: 60, exempt: ['EXEMPTUSD'] };
  const now = 100 * 86_400_000;
  // a losing recent record on LOSERUSD: three closed trades, two losers
  for (const pnl of [5, -10, -8]) db.run("INSERT INTO positions(status, scanner_id, scanner_name, symbol, tf, side, qty, qty_open, contract_value, entry_price, entry_at, realized_pnl, fees, exit_at, bt) VALUES ('closed','s','s','LOSERUSD','15m','long',1,0,1,1,?,?,0,?,0)", now - 86_400_000, pnl, now - 3_600_000);
  const candles = { get: (symbol: string) => symbol === 'QUIETUSD' ? bars(60, 100, 0.05) : symbol === 'NOCANDLESUSD' ? [] : bars(60, 100, 1.0) };
  const gate = new MarketGate({ db, candles, markets: async () => [{ symbol: 'THINUSD', volume24h: 200_000, price: 100 }, { symbol: 'QUIETUSD', volume24h: 5e6, price: 100 }, { symbol: 'LOSERUSD', volume24h: 5e6, price: 1 }, { symbol: 'GOODUSD', volume24h: 5e6, price: 100 }, { symbol: 'NOCANDLESUSD', volume24h: 5e6, price: 100 }], cfgRef: () => cfg, now: () => now });
  const r = await gate.refresh(['THINUSD', 'QUIETUSD', 'LOSERUSD', 'GOODUSD', 'NOCANDLESUSD', 'EXEMPTUSD']);
  const by = Object.fromEntries(r.markets.map(m => [m.symbol, m]));
  assert.equal(by.THINUSD.allowed, false); assert.match(by.THINUSD.reasons[0], /illiquid/);
  assert.equal(by.QUIETUSD.allowed, false); assert.match(by.QUIETUSD.reasons[0], /too quiet/);
  assert.equal(by.LOSERUSD.allowed, false); assert.match(by.LOSERUSD.reasons[0], /not paying: PF 0.28 over 3 trades/);
  assert.equal(by.GOODUSD.allowed, true);
  assert.equal(by.NOCANDLESUSD.allowed, true, 'no candles → no volatility opinion, not a block');
  assert.equal(by.EXEMPTUSD.allowed, true);
  assert.equal(gate.verdict('THINUSD')?.allowed, false);
  cfg.risk.marketGate.enabled = false;
  assert.equal(gate.verdict('THINUSD'), null, 'off → no opinion');
});
