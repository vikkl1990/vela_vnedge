import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, type AppConfig } from '../config.ts';
import { runBacktest } from './backtest.ts';
import { backtestPolicy, entryPolicy, scannerExitPolicy } from './policy.ts';

const H = 3600_000;
const T0 = Date.UTC(2026, 0, 5);
const bar = (i: number, o: number, h: number, l: number, c: number) => ({ time: T0 + i * H, open: o, high: h, low: l, close: c, volume: 1 });
const flat = (n: number) => Array.from({ length: n }, (_, i) => bar(i, 100, 101, 99, 100));
const entry = (i: number, side: 'long' | 'short', extra: Record<string, unknown> = {}) => ({ kind: 'entry' as const, side, tp: [], label: side, message: side, source: 'alert' as const, barTime: T0 + i * H, barIndex: i, ...extra });
function cfgWith(f: (c: AppConfig) => void = () => {}): AppConfig { const c = structuredClone(DEFAULT_CONFIG); c.paper.minRiskFeeRatio = 0; c.paper.slippageBps = 0; c.risk.regime = { ...c.risk.regime, enabled: false }; f(c); return c; }
const run = (c: AppConfig, bars: any[], events: any[], book: 'account' | 'shadow' = 'shadow', tf = '1h') =>
  runBacktest({ scannerId: 's', scannerName: 's', symbol: 'XUSD', tf, bars, events, ...backtestPolicy(c, 's', tf, book), contractValue: 1, tickSize: 0.01 });

test('account backtests reject native and mixed plans; shadow keeps measuring them', () => {
  const c = cfgWith(c => { c.paper.skipScriptStops = true; c.paper.limitEntry!.enabled = false; c.paper.trendGate!.enabled = false; });
  for (const plan of [{sl:95,tp:[110]}, {sl:95}]) {
    const events = [entry(30, 'long', plan)];
    const account = run(c, flat(60), events, 'account');
    assert.equal(account.entries, 0);
    assert.equal(account.rejected['account requires ATR stop'], 1);
    assert.equal(run(c, flat(60), events, 'shadow').entries, 1);
  }
  assert.equal(run(c, flat(60), [entry(30,'long')], 'account').entries, 1);
});

test('an account-native reversal cannot close the held ATR trade', () => {
  const c = cfgWith(c => { c.paper.skipScriptStops=true;c.paper.allowReversal=true;c.paper.reversalMinR=-Infinity;c.paper.limitEntry!.enabled=false;c.paper.trendGate!.enabled=false; });
  const result=run(c,flat(60),[entry(30,'long'),entry(40,'short',{sl:105,tp:[90]})],'account');
  assert.equal(result.entries,1);
  assert.equal(result.rejected['reversal refused: replacement not admissible'],1);
  assert.ok(!result.trades.some(t=>t.exitReason==='reversal'));
});

test('decision 191: the entry policy is the books\' — a limit on the configured timeframes and books, market otherwise', () => {
  const c = cfgWith(x => { x.paper.limitEntry = { enabled: true, tfs: ['1h', '4h'], atr: 0, atrByTf: { '1h': 0.1 }, bars: 2, books: ['account', 'shadow'] } as any; });
  assert.deepEqual(entryPolicy(c, '1h', 'shadow'), { pullbackAtr: 0.1, pullbackBars: 2, limitWhenFlatOnly: true });
  assert.deepEqual(entryPolicy(c, '4h', 'account'), { pullbackAtr: 0, pullbackBars: 2, limitWhenFlatOnly: true });
  assert.equal(entryPolicy(c, '15m', 'shadow'), undefined);
  assert.equal(entryPolicy(c, '1h', 'account', { executor: true }), undefined, 'an exchange-mirrored account enters at market');
});

test('decision 191: the screen\'s limit needs price through it, as the books\' does; a touch is not a fill', () => {
  const c = cfgWith(x => { x.paper.limitFill = 'through'; x.paper.limitEntry = { enabled: true, tfs: ['1h'], atr: 0, bars: 3, books: ['shadow'] } as any; });
  // the signal bar closes at 102, so the limit rests at 102 (0 ATR back); the bars after it stay at or above 102
  const lift = (b: any[]) => { b[30] = bar(30, 100, 102.5, 99.5, 102); for (let k = 31; k < 40; k++) b[k] = bar(k, 102.5, 103, 102, 102.5); return b; };
  const touch = lift(flat(40));
  const t = run(c, touch, [entry(30, 'long')]);
  assert.equal(t.trades.length + (t.stats.open ?? 0), 0, 'touched only: no fill');
  assert.equal(t.rejected['no pullback'], 1);
  const thru = lift(flat(40)); thru[32] = bar(32, 102.5, 103, 101.9, 102.5); thru[36] = bar(36, 102.5, 130, 102.4, 129);
  const r = run(c, thru, [entry(30, 'long')]);
  assert.equal(r.trades.length + (r.stats.open ?? 0), 1);
  assert.equal((r.trades[0] ?? { entryPrice: 102 }).entryPrice, 102, 'filled at the limit');
});

test('decision 191: a reversal is admitted before the held trade closes, and enters at market even under a limit policy', () => {
  const c = cfgWith(x => { x.paper.allowReversal = true; x.paper.reversalMinR = undefined as any; x.paper.limitEntry = { enabled: true, tfs: ['1h'], atr: 0.5, bars: 3, books: ['shadow'] } as any; });
  const bars = flat(60);
  bars[31] = bar(31, 100, 100.5, 98, 99);   // fills the long's limit (100 − 0.5 ATR = 99)… through it
  // a short whose stop sits 0.001 above the close cannot be sized against fees: the long must survive it
  c.paper.minRiskFeeRatio = 1;
  const refused = run(c, bars, [entry(30, 'long'), entry(40, 'short', { sl: 100.001 })]);
  assert.equal(refused.rejected['reversal refused: replacement not admissible'], 1);
  assert.ok(!refused.trades.some((t: any) => t.exitReason === 'reversal'), 'the held long was not closed');
  c.paper.minRiskFeeRatio = 0;
  const ok = run(c, bars, [entry(30, 'long'), entry(40, 'short')]);
  const rev = ok.trades.find((t: any) => t.exitReason === 'reversal');
  assert.ok(rev, 'the long closed on the reversal');
  const short = ok.trades.find((t: any) => t.side === 'short') ?? null;
  assert.ok(short === null ? ok.stats.open === 1 : short.entryPrice === bars[40].close, 'the short entered at the signal close, not as a limit');
});

test('decision 191: a script-exit scanner gets the books\' trail and floor in the backtest too, not only the disaster stop', () => {
  const c = cfgWith(x => { x.scanners.s = { enabled: true, symbols: null, timeframes: null, exitMode: 'script' } as any; x.paper.scriptExitTrailFrom = 0; x.paper.limitEntry = { ...x.paper.limitEntry!, enabled: false };
    Object.assign(x.paper, { trailAfterR: 0.5, trailGiveBackPct: 10, floorAtR: 0.5, floorKeepR: 0.25 }); });
  const pol = scannerExitPolicy(c, 's', Date.now());
  assert.equal(pol?.trailAfterR, c.paper.trailAfterR, 'protection layered over script mode');
  assert.equal(pol?.fallbackAtrSl, c.paper.scriptDisasterStopAtr ?? 3);
  // up 4 ATR, then all the way back down: the protected trade keeps a profit, the unprotected one gives it all back
  const bars = flat(80);
  for (let k = 31; k <= 40; k++) bars[k] = bar(k, 100 + (k - 31), 101 + (k - 30), 99 + (k - 31), 100 + (k - 30));
  for (let k = 41; k <= 60; k++) bars[k] = bar(k, 110 - (k - 41), 111 - (k - 41), 109 - (k - 40), 110 - (k - 40));
  const prot = run(c, bars, [entry(30, 'long')]);
  const bare = runBacktest({ scannerId: 's', scannerName: 's', symbol: 'XUSD', tf: '1h', bars, events: [entry(30, 'long')], cfg: c.paper, exitMode: 'script', contractValue: 1, tickSize: 0.01 });
  assert.ok(prot.trades[0].pnl > 0, `protected: ${prot.trades[0]?.pnl}`);
  assert.ok((bare.trades[0]?.pnl ?? -1) < prot.trades[0].pnl, 'without the protection the trade keeps less');
});

test('decision 202: the backtest is charged the book crossing only — the market gate\'s book cost already holds the fees', async () => {
  const { crossingPct } = await import('../risk/marketGate.ts');
  const { checkRiskVsFees } = await import('./logic.ts');
  const paper = { ...structuredClone(DEFAULT_CONFIG.paper), feeRatePct: 0.05, feeTaxPct: 18, minRiskFeeRatio: 6 };
  const btcBookCost = 0.1186227212295008;   // the gate's reading for BTCUSD on 25 October: 0.118% fees + 0.0006% spread
  const cross = crossingPct(btcBookCost, paper);
  assert.ok(Math.abs(cross - 0.0006227212295008) < 1e-9, `crossing ${cross}`);
  // a 1h BTC stop of 0.75% clears six times the real round trip; charged the book cost on top of the fees it did not
  assert.equal(checkRiskVsFees(80_000, 80_000 * (1 - 0.0075), paper, 'BTCUSD', cross), null);
  assert.notEqual(checkRiskVsFees(80_000, 80_000 * (1 - 0.0075), paper, 'BTCUSD', btcBookCost), null);
});
