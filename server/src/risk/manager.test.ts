/** Phase 3 portfolio risk layer: kill switches, caps, cooldown, drawdown scaling, regime filter, correlation cap. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG, type AppConfig, type RiskConfig } from '../config.ts';
import { PaperEngine } from '../paper/engine.ts';
import { RiskManager, utcDayStart, utcWeekStart, isWeekend } from './manager.ts';
import { returnCorrelation } from './correlation.ts';
import type { Bar } from '../data/candleStore.ts';

const DAY = 86_400_000;
// Tuesday 2026-09-22 12:00 UTC
const T0 = Date.UTC(2026, 8, 22, 12, 0, 0);

function bars(n: number, step: (i: number) => number, tf = 900_000): Bar[] {
  const out: Bar[] = []; let c = 100;
  for (let i = 0; i < n; i++) { c *= 1 + step(i); out.push({ time: i * tf, open: c, high: c, low: c, close: c, volume: 1 }); }
  return out;
}

function setup(t: { after: (fn: () => void) => void }, risk: Partial<RiskConfig> = {}, candles: Record<string, Bar[]> = {}) {
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  const cfg: AppConfig = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, { slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false, fillSource: 'candles', minRiskFeeRatio: 0 });
  Object.assign(cfg.risk, { regime: { enabled: false, minAtrPct: 0.3, noWeekend: true, exempt: [] } }, risk);
  const clock = { now: T0 };
  const paper = new PaperEngine(db, () => cfg);
  const mgr = new RiskManager({ db, paper, candles: { get: (symbol) => candles[symbol] ?? [] }, cfgRef: () => cfg, now: () => clock.now });
  paper.risk = mgr;
  const entry = (o: { scannerId?: string; symbol?: string; side?: 'long' | 'short'; atr?: number; at?: number; tf?: string } = {}) => {
    const side = o.side ?? 'long';
    return paper.onEntry({ kind: 'entry', side, price: 100, sl: side === 'long' ? 95 : 105, tp: side === 'long' ? [105, 110, 115] : [95, 90, 85], label: 'entry', message: '', source: 'alert', barTime: 0, barIndex: 0 },
      { scannerId: o.scannerId ?? 's', scannerName: 's', symbol: o.symbol ?? 'BTCUSD', tf: o.tf ?? '15m', market: { tickSize: 0.25, contractValue: 1 }, refPrice: 100, at: o.at ?? clock.now, signalId: null, exitMode: 'both', atr: o.atr });
  };
  /** Close position `id` at `price` (a loss when below entry for longs). */
  const closeAt = (id: number, price: number) => { paper.setMark('BTCUSD', price); paper.setMark('ETHUSD', price); paper.closeManual(id, 'test', clock.now); paper.setMark('BTCUSD', 100); paper.setMark('ETHUSD', 100); };
  return { db, cfg, paper, mgr, clock, entry, closeAt };
}

test('UTC day / ISO week boundaries', () => {
  assert.equal(utcDayStart(T0), Date.UTC(2026, 8, 22));
  assert.equal(utcWeekStart(T0), Date.UTC(2026, 8, 21), 'Monday');
  assert.equal(utcWeekStart(Date.UTC(2026, 8, 20, 23)), Date.UTC(2026, 8, 14), 'Sunday belongs to the previous Monday week');
  assert.equal(isWeekend(Date.UTC(2026, 8, 19)), true);
  assert.equal(isWeekend(T0), false);
});

test('daily kill switch trips on the day loss, blocks entries and resets when the UTC day rolls', t => {
  const { mgr, entry, closeAt, clock } = setup(t, { maxDailyLossPct: 15, maxWeeklyLossPct: 30 });
  const p = entry().position!;
  assert.equal(p.qty, 200, '1% risk on a 5-point stop');
  closeAt(p.id, 20); // -16 000 = -16 %
  const st = mgr.state();
  assert.equal(st.day.tripped, true); assert.equal(st.week.tripped, false); assert.equal(st.halted, true);
  const d = entry();
  assert.equal(d.action, 'rejected'); assert.match(d.reason!, /^risk daily loss limit 15%/);
  clock.now = utcDayStart(T0) + DAY + 1000;
  const d2 = entry();
  assert.equal(d2.action, 'opened', 'new UTC day → trading resumes');
  assert.equal(mgr.state().day.tripped, false);
  assert.equal(mgr.state().day.startEquity, mgr.state().equity, 'new day starts from the current equity');
});

test('weekly kill switch survives the day roll and resets on Monday; close-all on trip', t => {
  const { mgr, entry, closeAt, clock, paper } = setup(t, { maxDailyLossPct: 0, maxWeeklyLossPct: 10, closeAllOnKill: true });
  const p = entry().position!;
  const q = entry({ scannerId: 'other' }).position!;
  closeAt(p.id, 40); // -12 %
  assert.equal(mgr.state().week.tripped, true);
  assert.equal(paper.openPositions().length, 0, 'closeAllOnKill flattened the other position');
  assert.equal(q.exitReason, 'risk-kill');
  clock.now += DAY;
  assert.match(entry().reason!, /weekly loss limit/);
  clock.now = utcWeekStart(T0) + 7 * DAY + 1000;
  assert.equal(entry().action, 'opened');
});

test('manual kill halts even with risk disabled, reset clears it; state persists across restarts', t => {
  const { mgr, entry, db, paper, cfg, clock } = setup(t, { enabled: false });
  mgr.kill('ops', false);
  assert.match(entry().reason!, /manual halt \(ops\)/);
  const again = new RiskManager({ db, paper, candles: null, cfgRef: () => cfg, now: () => clock.now });
  assert.equal(again.state().manualHalt?.reason, 'ops', 'kv-persisted');
  mgr.reset();
  assert.equal(entry().action, 'opened');
});

test('position caps: total, per symbol, per scanner (pending entries count too)', t => {
  const { entry, cfg } = setup(t, { maxPositionsTotal: 3, maxPositionsPerSymbol: 2, perScannerMaxPositions: 2 });
  assert.equal(entry({ scannerId: 'a', symbol: 'BTCUSD' }).action, 'opened');
  assert.equal(entry({ scannerId: 'a', symbol: 'ETHUSD' }).action, 'opened');
  assert.match(entry({ scannerId: 'a', symbol: 'SOLUSD' }).reason!, /scanner at its 2-position budget/);
  assert.equal(entry({ scannerId: 'b', symbol: 'BTCUSD' }).action, 'opened');
  assert.match(entry({ scannerId: 'c', symbol: 'BTCUSD' }).reason!, /max positions 3 reached/);
  cfg.risk.maxPositionsTotal = 10;
  assert.match(entry({ scannerId: 'c', symbol: 'BTCUSD' }).reason!, /max 2 positions on BTCUSD/);
  // tape mode: a pending entry occupies a slot
  cfg.paper.fillSource = 'tape';
  assert.equal(entry({ scannerId: 'c', symbol: 'ETHUSD' }).action, 'pending');
  assert.match(entry({ scannerId: 'd', symbol: 'ETHUSD' }).reason!, /max 2 positions on ETHUSD/);
});

test('cooldown after N consecutive losses per scanner, cleared by a win or by time', t => {
  const { entry, closeAt, clock, mgr } = setup(t, { cooldownAfterLosses: 2, cooldownMinutes: 30, maxDailyLossPct: 0, maxWeeklyLossPct: 0 });
  closeAt(entry().position!.id, 99);
  closeAt(entry().position!.id, 99);
  const d = entry();
  assert.match(d.reason!, /cooldown after 2 losses/);
  assert.equal(entry({ scannerId: 'other' }).action, 'opened', 'other scanners unaffected');
  assert.equal(mgr.state().scanners.s.inCooldown, true);
  clock.now += 31 * 60_000;
  const p = entry().position!;
  assert.ok(p);
  closeAt(p.id, 101); // a win resets the streak
  assert.equal(mgr.state().scanners.s.consecutive, 0);
});

test('drawdown-scaled sizing halves risk below the configured drawdown from the equity peak', t => {
  const { entry, closeAt, mgr } = setup(t, { ddScale: [{ ddPct: 10, leverageMult: 0.5 }, { ddPct: 20, leverageMult: 0.25 }], maxDailyLossPct: 0, maxWeeklyLossPct: 0 });
  const p = entry().position!;
  assert.equal(p.qty, 200);
  closeAt(p.id, 101); // small win → peak 100 200
  assert.equal(mgr.leverageMult(), 1);
  const q = entry().position!;
  closeAt(q.id, 40); // -60 × 200 = -12 000 → dd ≈ 12 %
  assert.ok(mgr.drawdownPct() > 10 && mgr.drawdownPct() < 20, `dd ${mgr.drawdownPct()}`);
  assert.equal(mgr.leverageMult(), 0.5);
  const r = entry().position!;
  const expected = Math.floor(mgr.state().equity * 0.005 / 5);
  assert.equal(r.qty, expected, 'risk per trade halved');
  closeAt(r.id, 5); // deeper
  assert.equal(mgr.leverageMult(), 0.25);
});

test('regime filter: ATR floor and weekend, with per-scanner exemption', t => {
  const { entry, cfg } = setup(t, { maxPositionsPerSymbol: 10, regime: { enabled: true, minAtrPct: 0.3, noWeekend: true, exempt: ['vip'] } });
  assert.match(entry({ atr: 0.2 }).reason!, /regime: ATR 0\.20% < 0\.3%/);
  assert.equal(entry({ atr: 0.5 }).action, 'opened');
  const sat = Date.UTC(2026, 8, 19, 10);
  assert.match(entry({ scannerId: 'b', at: sat, atr: 1 }).reason!, /regime: weekend/);
  assert.equal(entry({ scannerId: 'vip', at: sat, atr: 0.1 }).action, 'opened', 'exempt scanner');
  assert.equal(entry({ scannerId: 'c', atr: undefined }).action, 'opened', 'no ATR → no ATR check');
  cfg.risk.regime.enabled = false;
  assert.equal(entry({ scannerId: 'd', at: sat, atr: 0.1 }).action, 'opened');
});

test('per-scanner daily loss budget', t => {
  const { entry, closeAt } = setup(t, { perScannerDailyLossPct: 5, maxDailyLossPct: 0, maxWeeklyLossPct: 0 });
  closeAt(entry().position!.id, 70); // -6 %
  assert.match(entry().reason!, /scanner daily loss -6\.00% ≤ -5%/);
  assert.equal(entry({ scannerId: 'other' }).action, 'opened');
});

test('return correlation of aligned bar series', () => {
  const a = bars(30, i => (i % 2 ? 0.01 : -0.01));
  const same = bars(30, i => (i % 2 ? 0.02 : -0.02));
  const inverse = bars(30, i => (i % 2 ? -0.01 : 0.01));
  assert.ok(returnCorrelation(a, same, 20)! > 0.999);
  assert.ok(returnCorrelation(a, inverse, 20)! < -0.999);
  assert.equal(returnCorrelation(a, bars(3, () => 0.01), 20), null, 'too little overlap');
  assert.equal(returnCorrelation(a, bars(30, () => 0), 20), null, 'flat series');
});

test('BTC-beta exposure cap uses the rolling correlation with BTCUSD', t => {
  const btc = bars(40, i => (i % 3 === 0 ? 0.01 : -0.004));
  const eth = bars(40, i => (i % 3 === 0 ? 0.02 : -0.008));   // corr +1
  const inv = bars(40, i => (i % 3 === 0 ? -0.01 : 0.004));   // corr -1
  const { entry, mgr, cfg } = setup(t, { maxBetaExposurePct: 30, maxPositionsTotal: 20 }, { BTCUSD: btc, ETHUSD: eth, INVUSD: inv });
  // each entry is 200 contracts × 100 = 20 000 notional = 20 % of equity
  assert.equal(entry({ scannerId: 'a', symbol: 'BTCUSD' }).action, 'opened');
  const x = mgr.exposure('15m');
  assert.ok(Math.abs(x.netBetaPct - 20) < 0.5, `net beta ${x.netBetaPct}`);
  const d = entry({ scannerId: 'b', symbol: 'ETHUSD' });
  assert.equal(d.action, 'rejected');
  assert.match(d.reason!, /^risk beta exposure 40% of equity would exceed ±30% \(corr ETHUSD\/BTCUSD 1\.00\)/);
  assert.equal(entry({ scannerId: 'c', symbol: 'ETHUSD', side: 'short' }).action, 'opened', 'a short in a correlated symbol reduces net beta');
  assert.equal(entry({ scannerId: 'd', symbol: 'INVUSD' }).action, 'opened', 'inversely correlated long also reduces net beta');
  cfg.risk.maxBetaExposurePct = 0;
  assert.equal(entry({ scannerId: 'e', symbol: 'ETHUSD' }).action, 'opened', 'cap off');
});

test('risk state endpoint shape and rejection log', t => {
  const { entry, mgr } = setup(t, { maxPositionsTotal: 1 });
  entry();
  entry({ scannerId: 'b' });
  const st = mgr.state();
  assert.equal(st.positions.open, 1);
  assert.equal(st.rejections.length, 1);
  assert.equal(st.day.limitPct, 15); assert.equal(st.week.limitPct, 30);
  assert.equal(typeof st.drawdownPct, 'number');
  assert.equal(st.exposure.limitPct, 0);
});
