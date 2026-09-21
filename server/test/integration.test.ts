/**
 * End-to-end replay: boots `App` + `ApiServer` against a synthetic Delta (no network), pushes a
 * recorded candle sequence and asserts bars close exactly once, the scanner runs on bar close,
 * its signal becomes a paper position, 1m fills close the trade, gaps are backfilled, and the
 * health / metrics / ops endpoints respond.
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

// A deterministic "now": 30 s into a 5-minute bar. Only Date is mocked; timers stay real.
const TF = 300_000;
const T0 = Math.floor(1_760_000_000_000 / TF) * TF;
let NOW = T0 + 30_000;
mock.timers.enable({ apis: ['Date'], now: NOW });
const setNow = (t: number) => { NOW = t; mock.timers.setTime(t); };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnedge-it-'));
process.env.VNEDGE_DATA_DIR = dataDir;
process.env.VNEDGE_WORKERS = '1';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';
delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  symbols: ['BTCUSD'], timeframes: ['5m'], historyBars: 200,
  autoTune: { enabled: false }, ml: { minProb: 0, useAsScore: false },
  paper: { initialEquity: 100_000, riskPerTradePct: 1, maxLeverage: 10, minRiskFeeRatio: 0, slippageBps: 0 },
  alerts: { onTrade: true, dailySummaryHourUtc: null },
  scanners: { tiny: { enabled: true, symbols: null, timeframes: null, exitMode: 'both' } },
}));

const { App } = await import('../src/app.ts');
const { ApiServer } = await import('../src/api/server.ts');
const { DeltaRest } = await import('../src/delta/rest.ts');
const { DeltaFeed } = await import('../src/delta/ws.ts');
const { ScannerRegistry } = await import('../src/scanners/registry.ts');
const { attachRawMetrics } = await import('../src/ops/routes.ts');

const PINE = `//@version=6
indicator("Tiny test scanner", overlay=true)
bull = close > open and close[1] <= open[1]
if bull
    alert("🟢 LONG | DELTA:" + syminfo.ticker + " | TF: " + timeframe.period + " | Price: " + str.tostring(close) + " | SL: " + str.tostring(close - 100) + " | TP1: " + str.tostring(close + 50) + " | TP2: " + str.tostring(close + 100) + " | TP3: " + str.tostring(close + 150), alert.freq_once_per_bar_close)
plotshape(bull, title="Buy", style=shape.triangleup, location=location.belowbar)
`;

// ---- synthetic exchange ----
type C = { time: number; open: number; high: number; low: number; close: number; volume: number };
function bar(timeMs: number, open: number, close: number): C { return { time: Math.floor(timeMs / 1000), open, high: Math.max(open, close) + 5, low: Math.min(open, close) - 5, close, volume: 100 }; }
// 5m history ending with a bearish closed bar (no entry at warm-up) and a forming bar at T0
const history5m: C[] = [];
for (let i = 240; i >= 1; i--) { const t = T0 - i * TF; const o = 50_000 + (240 - i) * 2; history5m.push(bar(t, o, i % 2 === 1 ? o - 20 : o + 20)); }
history5m.push(bar(T0, 50_480, 50_470)); // forming
const history1m: C[] = [];
for (let i = 300; i >= 0; i--) { const t = T0 - i * 60_000; history1m.push(bar(t, 50_470, 50_470)); }
const rest5m = new Map(history5m.map(c => [c.time, c]));
const rest1m = new Map(history1m.map(c => [c.time, c]));

class FakeRest extends DeltaRest {
  calls: string[] = [];
  override async products() { return new Map([['BTCUSD', { id: 1, symbol: 'BTCUSD', description: 'Bitcoin Perpetual', contract_type: 'perpetual_futures', state: 'live', tick_size: '0.5', contract_value: '0.001' }]]); }
  override async product(symbol: string) { return (await this.products()).get(symbol); }
  override async tickers() { return [{ symbol: 'BTCUSD', product_id: 1, close: 50_470, mark_price: '50470', timestamp: NOW * 1000, contract_type: 'perpetual_futures', tick_size: '0.5', contract_value: '0.001' }]; }
  override async ticker() { return { symbol: 'BTCUSD', product_id: 1, close: 50_470, mark_price: '50470', timestamp: NOW * 1000 }; }
  override async candles(symbol: string, resolution: string, startSec: number, endSec: number) {
    this.calls.push(`${resolution}:${startSec}-${endSec}`);
    const src = resolution === '5m' ? rest5m : resolution === '1m' ? rest1m : new Map<number, C>();
    return [...src.values()].filter(c => c.time >= startSec && c.time <= endSec).sort((a, b) => a.time - b.time);
  }
  override async recentCandles(symbol: string, resolution: string, bars: number) {
    const end = Math.floor(NOW / 1000);
    return (await this.candles(symbol, resolution, 0, end)).filter(c => c.time <= end).slice(-bars);
  }
}

class FakeFeed extends DeltaFeed {
  subs = new Set<string>();
  override start() { this.connected = true; this.emit('status', { connected: true }); }
  override stop() { this.connected = false; }
  override subscribe(channel: string, symbols: string[]) { for (const s of symbols) this.subs.add(`${s}:${channel}`); }
  override unsubscribe(channel: string, symbols: string[]) { for (const s of symbols) this.subs.delete(`${s}:${channel}`); }
  push(resolution: string, c: C) {
    (this as any).lastMessageAt = NOW;
    this.emit('candle', { symbol: 'BTCUSD', resolution, candleStartMs: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, updatedMs: NOW });
  }
}

class FakeRegistry extends ScannerRegistry {
  override reload() { /* no manifest on disk for this test */ }
  private list = [{ id: 'tiny', name: 'Tiny', author: 'test', file: 'tiny.pine', url: '', pub: null, access: null, pineVersion: '6', lines: 6, updated: null, status: 'ok' as const, reason: null, overlay: true, category: 'Other', source: PINE, patched: PINE, patches: [] as string[] }];
  override all() { return this.list; }
  override get(id: string) { return this.list.find(s => s.id === id); }
  override runnable() { return this.list; }
}

const sentAlerts: string[] = [];
const rest = new FakeRest();
const feed = new FakeFeed();
const app = new App({ rest, feed, registry: new FakeRegistry(), alertTransport: async text => { sentAlerts.push(text); } });
const api = new ApiServer(app);
assert.equal(attachRawMetrics((api as any).server, app), true);
const port = 20_000 + Math.floor(Math.random() * 10_000);
const base = `http://127.0.0.1:${port}`;

const closedCounts = new Map<string, number>();
app.candles.on('closed', (e: any) => { const k = `${e.tf}:${e.bar.time}`; closedCounts.set(k, (closedCounts.get(k) ?? 0) + 1); });
const integrity: any[] = [];
app.candles.on('integrity', (e: any) => integrity.push(e));

async function waitFor(pred: () => boolean, what: string, ms = 30_000) {
  const t0 = performance.now();
  while (!pred()) { if (performance.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`); await new Promise(r => setTimeout(r, 25)); }
}
const getJson = async (p: string, init?: RequestInit) => { const r = await fetch(base + p, init); return { status: r.status, body: await r.json(), headers: r.headers }; };

test('boot: API listens, history backfills and warm-up runs the scanner once', async () => {
  await api.listen(port, '127.0.0.1');
  await app.start();
  await waitFor(() => app.candles.has('BTCUSD', '5m') && app.candles.has('BTCUSD', '1m'), 'candle backfill');
  await waitFor(() => app.scanners.getLastRun('tiny') !== null, 'warm-up run', 60_000);
  const run = app.scanners.getLastRun('tiny')!;
  assert.equal(run.error, null, `warm-up error: ${run.error}`);
  assert.equal(run.barTime, T0 - TF, 'warm-up ran on the last closed bar');
  assert.equal(app.paper.openPositions().length, 0, 'no entry from the bearish last bar');
  assert.equal(closedCounts.size, 0, 'history load must not announce closes');
  const h = await getJson('/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.feed.connected, true);
  assert.ok(h.body.integrity && h.body.alerts && h.body.ops, 'health carries integrity/alerts/ops');
  assert.equal(h.body.integrity.gapsFound, 0);
});

test('bar close → scanner run → signal → paper position (exactly one close per bar)', async () => {
  // finish the forming bar bullish, then start the next bar → `closed` for T0
  feed.push('5m', bar(T0, 50_480, 50_520));
  setNow(T0 + TF + 5_000);
  const signal = once(app.scanners, 'signal');
  feed.push('5m', bar(T0 + TF, 50_520, 50_521));
  assert.equal(closedCounts.get(`5m:${T0}`), 1);
  const [sig] = await signal;
  assert.equal(sig.kind, 'entry'); assert.equal(sig.side, 'long'); assert.equal(sig.barTime, T0);
  assert.equal(sig.action, 'opened', `signal action ${sig.action}`);
  const open = app.paper.openPositions();
  assert.equal(open.length, 1);
  assert.equal(open[0].side, 'long'); assert.equal(open[0].sl, 50_420); assert.deepEqual(open[0].tp, [50_570, 50_620, 50_670]);
  // a second update of the same new bar must not close anything again
  feed.push('5m', bar(T0 + TF, 50_520, 50_530));
  assert.equal(closedCounts.get(`5m:${T0}`), 1);
  assert.equal([...closedCounts.values()].every(n => n === 1), true);
  const m = await fetch(base + '/api/metrics');
  assert.match(m.headers.get('content-type') ?? '', /text\/plain/);
  const text = await m.text();
  assert.match(text, /^# TYPE vnedge_bars_closed_total counter$/m);
  assert.match(text, /vnedge_bars_closed_total\{symbol="BTCUSD",tf="5m"\} 1/);
  assert.match(text, /vnedge_open_positions 1/);
  assert.match(text, /vnedge_script_runs_total\{status="ok"\} \d+/);
});

test('1m feed fills TP1..TP3 and closes the trade; the trade alert goes out', async () => {
  const pos = app.paper.openPositions()[0];
  const trade = once(app.paper, 'trade');
  let t = T0 + TF;
  for (const px of [50_575, 50_625, 50_680]) {
    t += 60_000; setNow(t + 5_000);
    feed.push('1m', bar(t, px - 5, px));
  }
  const [closed] = await trade;
  assert.equal(closed.positionId, pos.id);
  assert.equal(closed.exitReason, 'tp3');
  assert.ok(closed.pnl > 0, `pnl ${closed.pnl}`);
  assert.equal(app.paper.openPositions().length, 0);
  const trades = await getJson('/api/trades');
  assert.equal(trades.body.length, 1);
  await waitFor(() => sentAlerts.length >= 1, 'trade alert');
  assert.match(sentAlerts[0], /LONG BTCUSD 5m closed \(tp3\)/);
});

test('a gap on bar close is detected and backfilled from REST; closes stay exactly-once', async () => {
  // the exchange has bars T0+2TF and T0+3TF that the websocket never delivered
  const g1 = bar(T0 + 2 * TF, 50_530, 50_500), g2 = bar(T0 + 3 * TF, 50_500, 50_480);
  rest5m.set(g1.time, g1); rest5m.set(g2.time, g2);
  setNow(T0 + 4 * TF + 5_000);
  const filled = new Promise<any>(res => app.candles.on('integrity', e => { if (e.type === 'gap-filled' && e.tf === '5m') res(e); }));
  feed.push('5m', bar(T0 + 4 * TF, 50_480, 50_490));
  assert.equal(closedCounts.get(`5m:${T0 + TF}`), 1, 'the bar before the gap closes once');
  const ev = await filled;
  assert.equal(ev.filled, 2, JSON.stringify(integrity));
  assert.deepEqual(app.candles.gapsIn('BTCUSD', '5m'), []);
  const bars = app.candles.get('BTCUSD', '5m', { from: T0 + TF });
  assert.deepEqual(bars.map(b => b.time), [T0 + TF, T0 + 2 * TF, T0 + 3 * TF, T0 + 4 * TF]);
  // the newest filled bar (T0+3TF) is the last closed bar → announced once so scanners re-run on it
  await waitFor(() => (closedCounts.get(`5m:${T0 + 3 * TF}`) ?? 0) >= 1, 'close for the filled bar');
  assert.equal(closedCounts.get(`5m:${T0 + 3 * TF}`), 1);
  assert.equal(closedCounts.get(`5m:${T0 + 2 * TF}`), undefined, 'inner gap bars are not announced');
  // the next websocket bar must not re-announce T0+3TF (already emitted) but must announce T0+4TF once
  setNow(T0 + 5 * TF + 5_000);
  feed.push('5m', bar(T0 + 5 * TF, 50_490, 50_495));
  assert.equal(closedCounts.get(`5m:${T0 + 3 * TF}`), 1);
  assert.equal(closedCounts.get(`5m:${T0 + 4 * TF}`), 1);
  assert.equal([...closedCounts.values()].every(n => n === 1), true, 'every bar closed exactly once');
  const h = await getJson('/api/health');
  // 2 five-minute bars filled; the 5 one-minute bars skipped by the 1m replay above are unfillable (REST has none)
  assert.equal(h.body.integrity.gapsFound, 7); assert.equal(h.body.integrity.gapsFilled, 2); assert.equal(h.body.integrity.gapsUnfillable, 5);
  const integ = await getJson('/api/ops/integrity');
  assert.equal(integ.body.series.find((s: any) => s.tf === '5m').gaps.length, 0);
});

test('reconnect resync announces bars closed while disconnected exactly once', async () => {
  const t6 = bar(T0 + 6 * TF, 50_495, 50_500), t7 = bar(T0 + 7 * TF, 50_500, 50_505);
  rest5m.set(t6.time, t6); rest5m.set(t7.time, t7);
  setNow(T0 + 7 * TF + 5_000); // t6 closed, t7 forming, both only on REST
  feed.stop(); feed.emit('status', { connected: false });
  feed.start(); // App resyncs every tracked series on reconnect
  await waitFor(() => (closedCounts.get(`5m:${T0 + 6 * TF}`) ?? 0) >= 1, 'resync close');
  assert.equal(closedCounts.get(`5m:${T0 + 6 * TF}`), 1);
  // only the newest missed bar is announced (one full-history scanner run covers the outage); T0+5TF stays silent
  assert.equal(closedCounts.get(`5m:${T0 + 5 * TF}`), undefined);
  setNow(T0 + 8 * TF + 5_000);
  feed.push('5m', bar(T0 + 8 * TF, 50_505, 50_510));
  assert.equal(closedCounts.get(`5m:${T0 + 6 * TF}`), 1);
  assert.equal(closedCounts.get(`5m:${T0 + 7 * TF}`), 1);
});

test('ops endpoints: backup on demand, alerts status, metrics JSON, log rotation, shutdown', async () => {
  const b = await getJson('/api/ops/backup', { method: 'POST' });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.ok(fs.existsSync(b.body.file)); assert.ok(b.body.bytes > 0);
  const list = await getJson('/api/ops/backups');
  assert.equal(list.body.files.length, 1);
  const a = await getJson('/api/ops/alerts');
  assert.equal(a.body.configured, true); assert.equal(a.body.channel, 'custom');
  const t = await getJson('/api/ops/alerts/test', { method: 'POST', body: JSON.stringify({ text: 'hello' }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(t.body.delivered, true); assert.ok(sentAlerts.includes('hello'));
  // the mocked clock jumped ~40 min with no 1m bar → the staleness condition is active; a fresh 1m bar clears it
  const ev = await getJson('/api/ops/alerts/test', { method: 'POST', body: JSON.stringify({ evaluate: true }), headers: { 'Content-Type': 'application/json' } });
  assert.deepEqual(ev.body.active, ['candles.stale']);
  assert.ok(sentAlerts.some(t => /No bar close for 2× the timeframe/.test(t)));
  feed.push('1m', bar(NOW - 65_000, 50_510, 50_511)); feed.push('1m', bar(NOW - 5_000, 50_511, 50_512));
  const ev2 = await getJson('/api/ops/alerts/test', { method: 'POST', body: JSON.stringify({ evaluate: true }), headers: { 'Content-Type': 'application/json' } });
  assert.deepEqual(ev2.body.active, []);
  assert.ok(sentAlerts.some(t => /resolved after/.test(t)));
  const mj = await getJson('/api/metrics?format=json');
  assert.equal(mj.body.vnedge_open_positions, 0);
  const rot = await getJson('/api/ops/logs/rotate', { method: 'POST' });
  assert.equal(rot.body.rotated, true);
  assert.ok(fs.existsSync(path.join(dataDir, 'logs', 'vnedge.log.1')));
  const h = await getJson('/api/health');
  assert.equal(h.body.ops.backup.count, 1);
  assert.ok(h.body.ops.log.file.endsWith('vnedge.log'));
});

after(async () => {
  api.close();
  const r = await app.ops.shutdown(() => app.stop());
  assert.equal(r.drained, true);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
