import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { compareParity, isPortfolioRefusal, judgeCell, type Baseline } from '../analytics/edgeVerdict.ts';
import { CandleArchive } from '../data/candleArchive.ts';
import { EdgeWatch, KV } from './edgeWatch.ts';
import { RiskManager } from '../risk/manager.ts';
import { PaperEngine } from '../paper/engine.ts';

const base: Baseline = { meanR: 0.12, sdR: 1.1, n: 600, since: 0, source: 'test' };
const series = (n: number, win: number, loss: number, winRate: number) => Array.from({ length: n }, (_, i) => ((i * 7919) % 100) / 100 < winRate ? win : loss);

test('verdict states follow the live record against its baseline', () => {
  assert.equal(judgeCell([1, -1, 1], base).state, 'collecting');
  const inLine = judgeCell(series(25, 1.2, -1, 0.5), base);   // ~+0.1R a trade
  assert.equal(inLine.state, 'consistent', inLine.reason);
  const bad = judgeCell(series(30, 1, -1, 0.25), base);       // ~−0.5R a trade
  assert.equal(bad.state, 'pause', bad.reason);
  assert.ok(bad.pBelow! < 0.05);
  const soft = judgeCell(series(12, 1, -1, 0.42), base);      // a little below, few trades
  assert.ok(['watch', 'consistent'].includes(soft.state));
  const strong = judgeCell(series(60, 2, -1, 0.55), base);    // ~+0.65R a trade
  assert.equal(strong.state, 'confirmed', strong.reason);
  assert.equal(judgeCell(Array(11).fill(-1), base).state, 'pause', 'the −10R breaker trips before the sample is large');
});

test('parity matches same-side entries within the slack and explains the rest', () => {
  const r = compareParity(
    [{ at: 1000, side: 'long' }, { at: 5000, side: 'short' }, { at: 9000, side: 'long' }],
    [{ at: 1200, side: 'long' }, { at: 20000, side: 'long' }],
    [{ barTime: 4700, at: 5050, side: 'short', action: 'rejected:risk burst: a short entry was already taken' }],
    600);
  assert.equal(r.matched, 1);
  assert.deepEqual(r.backtestOnly.map(x => x.live), ['rejected:risk burst: a short entry was already taken', 'no live signal']);
  assert.equal(r.liveOnly.length, 1);
  assert.ok(isPortfolioRefusal(r.backtestOnly[0].live));
  assert.ok(!isPortfolioRefusal('rejected:stop too tight for fees'));
});

test('the archive keeps closed bars only, back-fills once and tops up without duplicates', async () => {
  const now = Date.UTC(2026, 10, 28, 12, 0, 30);
  const calls: Array<[number, number]> = [];
  const a = new CandleArchive(':memory:', {
    now: () => now,
    fetch: async (_s, tf, startSec, endSec) => {
      calls.push([startSec, endSec]);
      const step = tf === '1m' ? 60 : 300, out = [];
      for (let t = Math.ceil(startSec / step) * step; t <= endSec + step * 3; t += step) out.push({ time: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
      return out;   // deliberately runs past the window, into the still-open bar
    },
  });
  const first = await a.sync(['BTCUSD'], ['5m']);
  assert.equal(first[0].error, undefined);
  const bars = a.bars('BTCUSD', '5m');
  assert.ok(Math.abs(bars.length - 60 * 288) <= 1, `sixty days of 5m bars (${bars.length})`);
  assert.ok(bars.at(-1)!.time + 300_000 <= now, 'the open bar is never archived');
  assert.equal(new Set(bars.map(b => b.time)).size, bars.length);
  const before = calls.length;
  const second = await a.sync(['BTCUSD'], ['5m']);
  assert.equal(second[0].added, 0, 'nothing new inside the same bar');
  assert.equal(calls.length, before, 'no request when no new bar has closed');
  assert.equal(a.coverage()[0].bars, bars.length);
  a.close();
});

test('a paused cell is refused by the risk gate until the operator resumes it', () => {
  const db = new Db(':memory:');
  const cfg = structuredClone(DEFAULT_CONFIG);
  const closed = series(30, 1, -1, 0.25).map((r, i) => ({ scannerId: 's', tf: '5m', status: 'closed', entryAt: 1000 + i, side: 'long', entryPrice: 100, slOriginal: 99, sl: 99, r }));
  const notes: string[] = [];
  const w = new EdgeWatch({
    db, cfgRef: () => cfg,
    account: { closedPositions: () => closed as any, openPositions: () => [] },
    cells: () => [{ scannerId: 's', symbol: 'BTCUSD', tf: '5m' }],
    backtestNow: async () => null, notify: t => notes.push(t), archive: null, symbols: () => [],
  });
  w.liveR = () => closed.map(c => c.r);   // the R of each fixture trade
  db.kvSet(KV.baseline, { 's|5m': base });
  assert.equal(w.runVerdict().cells['s|5m'].state, 'pause');
  assert.ok(w.pauseReason('s', '5m'));
  assert.equal(w.pauseReason('s', '1h'), null, 'a pause belongs to one timeframe');
  assert.equal(notes.length, 1);
  w.runVerdict();
  assert.equal(notes.length, 1, 'no repeat alert while paused');
  assert.ok(w.resume('s|5m'));
  w.runVerdict();
  assert.equal(w.pauseReason('s', '5m'), null, 'resumed: not re-paused without five further trades');
  closed.push(...Array.from({ length: 5 }, (_, i) => ({ ...closed[0], entryAt: 5000 + i, r: -1 })));
  w.runVerdict();
  assert.ok(w.pauseReason('s', '5m'), 'five more losing trades pause it again');
  db.db.close();
});

test('the risk gate refuses an account entry of a paused cell and names the reason', () => {
  const db = new Db(':memory:');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.risk.enabled = true;
  cfg.risk.regime.enabled = false;   // the weekend and quiet-market rules would make this test depend on the calendar
  const paper = new PaperEngine(db, () => cfg);
  const paused = new Map([['s|5m', 'live −0.5R a trade against +0.12R']]);
  const risk = new RiskManager({ db, paper, candles: null, cfgRef: () => cfg, paused: (id, tf) => paused.get(`${id}|${tf}`) ?? null });
  const req = { scannerId: 's', symbol: 'BTCUSD', tf: '5m', side: 'long' as const, price: 100, sl: 99, at: Date.now() };
  assert.match(risk.gate(req).reject ?? '', /paused by edge watch: live −0.5R/);
  assert.equal(risk.gate({ ...req, tf: '1h' }).reject, undefined, 'the same scanner on another timeframe still trades');
  db.db.close();
});
