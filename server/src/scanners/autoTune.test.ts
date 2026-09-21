import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { PaperEngine } from '../paper/engine.ts';
import { ScannerEngine } from './engine.ts';
import { SIMULATION_VERSION } from '../paper/version.ts';
import type { OosSummary } from '../validation/walkForward.ts';

function build(opts: { tfs?: string[] } = {}) {
  const db = new Db(':memory:');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.symbols = ['BTCUSD', 'ETHUSD', 'SOLUSD']; cfg.timeframes = opts.tfs ?? ['15m'];
  cfg.scanners.s = { enabled: true, symbols: null, timeframes: null, exitMode: 'both' };
  const bt = (trades: number, pnl: number) => ({ version: SIMULATION_VERSION, at: Date.now(), trades: [], stats: { trades, pnl, grossProfit: pnl > 0 ? pnl : 0, grossLoss: pnl < 0 ? -pnl : 0 } });
  // in-sample: BTC good, ETH good, SOL bad (all tfs)
  for (const tf of cfg.timeframes) {
    db.run('INSERT INTO backtests(scanner_id, symbol, tf, at, bars, result) VALUES (?,?,?,?,?,?)', 's', 'BTCUSD', tf, 1, 1, JSON.stringify(bt(10, 500)));
    db.run('INSERT INTO backtests(scanner_id, symbol, tf, at, bars, result) VALUES (?,?,?,?,?,?)', 's', 'ETHUSD', tf, 1, 1, JSON.stringify(bt(8, 200)));
    db.run('INSERT INTO backtests(scanner_id, symbol, tf, at, bars, result) VALUES (?,?,?,?,?,?)', 's', 'SOLUSD', tf, 1, 1, JSON.stringify(bt(9, -300)));
  }
  const store = { setScanner: (id: string, patch: any) => { cfg.scanners[id] = { ...cfg.scanners[id], ...patch }; return cfg.scanners[id]; } };
  const engine = new ScannerEngine({ db, cfgRef: () => cfg, paper: new PaperEngine(db, () => cfg), candles: Object.assign(new EventEmitter(), { get: () => [] }) as any, pool: { stats: { queued: 0 }, run: async () => ({}) } as any,
    registry: { all: () => [{ id: 's', name: 'S', status: 'ok', patched: '' }], get: () => undefined } as any, rest: {} as any, cfgStore: store });
  return { db, cfg, engine };
}

const oos = (trades: number, pnl: number, pf: number | null, positiveWeeks: number): OosSummary => ({ at: 1, windows: 20, selectedWindows: 12, trades, pnl, profitFactor: pf, positiveWeeks, negativeWeeks: 1, weeks: positiveWeeks + 1, maxDrawdownPct: 2 });

test('in-sample rule (default) keeps profitable symbols and reports the rule', t => {
  const { db, cfg, engine } = build(); t.after(() => db.db.close());
  const [r] = engine.autoTune({ minTrades: 3, minProfitFactor: 1 });
  assert.equal(r.rule, 'in-sample'); assert.equal(r.provisional, false);
  assert.deepEqual(r.after, ['BTCUSD', 'ETHUSD']); assert.deepEqual(r.dropped.map(d => d.symbol), ['SOLUSD']);
  assert.ok(r.decisions.every(d => d.rule === 'in-sample' && d.tf === null));
  assert.deepEqual(cfg.scanners.s.symbols, ['BTCUSD', 'ETHUSD']);
  assert.equal(engine.lastAutoTune?.report[0].id, 's');
});

test('OOS rule: walk-forward result decides; pairs without walk-forward data fall back to in-sample as provisional', t => {
  const { db, cfg, engine } = build(); t.after(() => db.db.close());
  const wf: Record<string, OosSummary> = {
    'BTCUSD': oos(30, 900, 1.6, 4),     // passes
    'ETHUSD': oos(25, 100, 1.05, 3),    // PF below 1.1 → dropped despite a good in-sample result
    // SOLUSD: no walk-forward data → in-sample (negative) → dropped, provisional
  };
  engine.setWalkForwardSource((_id, symbol) => wf[symbol] ?? null);
  const gate = { enabled: true, minTrades: 10, minProfitFactor: 1.1, minPositiveWeeks: 2 };
  const [r] = engine.autoTune({ minTrades: 3, minProfitFactor: 1, oos: gate });
  assert.equal(r.rule, 'oos'); assert.equal(r.provisional, true);
  assert.deepEqual(r.after, ['BTCUSD']);
  const by = Object.fromEntries(r.decisions.map(d => [d.symbol, d]));
  assert.equal(by.BTCUSD.rule, 'oos'); assert.equal(by.BTCUSD.keep, true); assert.equal(by.BTCUSD.positiveWeeks, 4);
  assert.equal(by.ETHUSD.rule, 'oos'); assert.equal(by.ETHUSD.keep, false); assert.match(by.ETHUSD.reason, /PF ≥ 1.1/);
  assert.equal(by.SOLUSD.rule, 'provisional'); assert.equal(by.SOLUSD.keep, false);
  assert.deepEqual(cfg.scanners.s.symbols, ['BTCUSD']);
  const reset = () => { cfg.scanners.s = { enabled: true, symbols: null, timeframes: null, exitMode: 'both' }; };
  // too few positive weeks or too few trades also fail
  reset(); wf.BTCUSD = oos(30, 900, 1.6, 1);
  assert.equal(engine.autoTune({ oos: gate })[0].decisions.find(d => d.symbol === 'BTCUSD')!.keep, false);
  reset(); wf.BTCUSD = oos(5, 900, 3, 4);
  assert.equal(engine.autoTune({ oos: gate })[0].decisions.find(d => d.symbol === 'BTCUSD')!.keep, false);
  // no qualifying symbol → scanner disabled
  reset(); wf.ETHUSD = oos(0, 0, null, 0);
  const [r2] = engine.autoTune({ oos: gate });
  assert.equal(r2.disabled, true); assert.equal(cfg.scanners.s.enabled, false);
});

test('multi-timeframe: every (symbol, tf) pair is evaluated and both lists are tuned', t => {
  const { db, cfg, engine } = build({ tfs: ['5m', '15m', '1h'] }); t.after(() => db.db.close());
  const wf: Record<string, OosSummary> = { 'BTCUSD:15m': oos(30, 900, 1.6, 4), 'BTCUSD:5m': oos(40, -200, 0.8, 1), 'ETHUSD:1h': oos(12, 300, 1.3, 3) };
  engine.setWalkForwardSource((_id, symbol, tf) => wf[`${symbol}:${tf}`] ?? null);
  const gate = { enabled: true, minTrades: 10, minProfitFactor: 1.1, minPositiveWeeks: 2 };
  const [r] = engine.autoTune({ minTrades: 3, minProfitFactor: 1, oos: gate, tuneTimeframes: true });
  assert.deepEqual(r.beforeTimeframes, ['5m', '15m', '1h']);
  assert.deepEqual(r.after.sort(), ['BTCUSD', 'ETHUSD']);
  assert.deepEqual(r.afterTimeframes.sort(), ['15m', '1h', '5m'], 'ETH:5m has no walk-forward data and passes in-sample (provisional)');
  assert.equal(r.decisions.length, 9);
  assert.equal(r.decisions.find(d => d.symbol === 'ETHUSD' && d.tf === '5m')!.rule, 'provisional');
  assert.equal(r.decisions.find(d => d.symbol === 'SOLUSD' && d.tf === '15m')!.keep, false);
  assert.equal(r.decisions.find(d => d.symbol === 'BTCUSD' && d.tf === '1h')!.rule, 'provisional');
  assert.equal(r.decisions.find(d => d.symbol === 'BTCUSD' && d.tf === '5m')!.keep, false);
  assert.deepEqual(cfg.scanners.s.timeframes!.sort(), ['15m', '1h', '5m']);
  // strict OOS (no provisional pairs qualify) when every pair has walk-forward data
  cfg.scanners.s = { enabled: true, symbols: null, timeframes: null, exitMode: 'both' };
  engine.setWalkForwardSource((_id, symbol, tf) => wf[`${symbol}:${tf}`] ?? oos(0, 0, null, 0));
  const [r2] = engine.autoTune({ minTrades: 3, minProfitFactor: 1, oos: gate, tuneTimeframes: true });
  assert.equal(r2.provisional, false);
  assert.deepEqual(r2.after.sort(), ['BTCUSD', 'ETHUSD']);
  assert.deepEqual(r2.afterTimeframes.sort(), ['15m', '1h']);
  assert.deepEqual(cfg.scanners.s.timeframes!.sort(), ['15m', '1h']);
});
