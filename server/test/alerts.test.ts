/** Alert manager (dedupe, repeat, hourly cap, resolved notes), Telegram target resolution and the condition monitor. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AlertManager, telegramFromEnv, telegramTransport } from '../src/ops/alerts.ts';
import { Monitor, THRESHOLDS } from '../src/ops/monitor.ts';
import { WorkerTracker } from '../src/ops/workers.ts';
import { Db } from '../src/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { logger } from '../src/log.ts';

logger.minLevel = 'error';

function mgr(opts: Partial<{ repeatMinutes: number; maxPerHour: number }> = {}) {
  const sent: string[] = [];
  const m = new AlertManager({ repeatMinutes: opts.repeatMinutes ?? 60, maxPerHour: opts.maxPerHour ?? 30, transport: async t => { sent.push(t); } });
  return { m, sent };
}

test('keyed conditions send once, repeat after repeatMinutes and send one resolved note', async () => {
  const { m, sent } = mgr({ repeatMinutes: 10 });
  const t0 = 1_000_000;
  assert.equal(await m.raise('feed', 'down', t0), true);
  assert.equal(await m.raise('feed', 'down', t0 + 60_000), false);
  assert.equal(await m.raise('feed', 'still down', t0 + 9 * 60_000), false);
  assert.equal(await m.raise('feed', 'still down', t0 + 11 * 60_000), true);
  assert.equal(await m.clear('feed', undefined, t0 + 12 * 60_000), true);
  assert.equal(await m.clear('feed', undefined, t0 + 13 * 60_000), false, 'clearing an inactive key is a no-op');
  assert.deepEqual(sent, ['down', '🔁 still active: still down', '✅ resolved after 12 min: still down']);
  const st = m.status();
  assert.equal(st.sent, 3); assert.equal(st.suppressed, 2); assert.deepEqual(st.active, []); assert.equal(st.lastSent?.delivered, true);
});

test('hourly cap suppresses excess messages and recovers after the window', async () => {
  const { m, sent } = mgr({ maxPerHour: 3 });
  const t0 = 5_000_000;
  for (let i = 0; i < 5; i++) await m.notify(`n${i}`, t0 + i * 1000);
  assert.deepEqual(sent, ['n0', 'n1', 'n2']);
  assert.equal(await m.notify('later', t0 + 3_600_001), true);
});

test('unconfigured manager evaluates but delivers nothing; delivery failures are counted', async () => {
  const none = new AlertManager({ repeatMinutes: 1, maxPerHour: 10 });
  assert.equal(none.configured, false);
  assert.equal(await none.raise('k', 'x'), false);
  assert.equal(none.isActive('k'), true, 'state is still tracked so a later transport sees clears');
  assert.equal(none.status().channel, 'none');
  const failing = new AlertManager({ repeatMinutes: 1, maxPerHour: 10, transport: async () => { throw new Error('bot123456:ABC-secret 502'); } });
  assert.equal(await failing.notify('x'), false);
  assert.equal(failing.failed, 1); assert.equal(failing.lastSent?.delivered, false);
});

test('telegramFromEnv prefers the environment and treats blanks as unconfigured; the transport never leaks the token', async () => {
  assert.equal(telegramFromEnv({ botToken: '', chatId: '' }, {}), null);
  assert.deepEqual(telegramFromEnv({ botToken: 'cfg', chatId: '1' }, {}), { botToken: 'cfg', chatId: '1' });
  assert.deepEqual(telegramFromEnv({ botToken: 'cfg', chatId: '1' }, { TELEGRAM_BOT_TOKEN: 'env', TELEGRAM_CHAT_ID: '2' }), { botToken: 'env', chatId: '2' });
  assert.equal(telegramFromEnv(null, { TELEGRAM_BOT_TOKEN: 'env' }), null, 'a token without a chat id is not a target');
  let url = '', body: any = null;
  const ok = telegramTransport({ botToken: '123:SECRET', chatId: '42' }, (async (u: string, init: any) => { url = String(u); body = JSON.parse(init.body); return new Response('{}', { status: 200 }); }) as any);
  await ok('hi');
  assert.equal(url, 'https://api.telegram.org/bot123:SECRET/sendMessage'); assert.equal(body.chat_id, '42'); assert.equal(body.text, 'hi');
  const bad = telegramTransport({ botToken: '123:SECRET', chatId: '42' }, (async () => { throw new Error('fetch failed https://api.telegram.org/bot123:SECRET/sendMessage'); }) as any);
  await assert.rejects(bad('x'), (e: Error) => !e.message.includes('SECRET') && /redacted/.test(e.message));
});

// ---- monitor conditions with fake dependencies ----

function monitorFixture() {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.ops.queueDepthAlert = 10; cfg.alerts.drawdownPct = 10; cfg.alerts.dailySummaryHourUtc = 6; cfg.alerts.onTrade = true;
  const db = new Db(':memory:');
  const { m, sent } = mgr({ repeatMinutes: 1000 });
  const workers = new WorkerTracker();
  const feed = { connected: true, lastTickAt: 0 };
  const pool = { stats: { size: 2, queued: 0, busy: 0 } };
  const paper = Object.assign(new EventEmitter(), { equity: 100_000, stats() { return { equity: this.equity, initialEquity: 100_000, unrealizedPnl: 0, openPositions: 1 }; }, trades: () => [{ scannerId: 'a', scannerName: 'A', pnl: 50, exitAt: 6 * 3600_000 + 1 }, { scannerId: 'b', scannerName: 'B', pnl: -20, exitAt: 6 * 3600_000 + 2 }] });
  const series = { symbol: 'BTCUSD', tf: '5m', loaded: true, lastBarTime: 0, lastClosedAt: 0, loadedAt: 0 };
  let now = 10 * 60_000, disk: number | null = 100 * 1024 * 1024 * 1024;
  const mon = new Monitor({ cfg: () => cfg, db, alerts: m, workers, dataDir: '/', feed, pool, paper: paper as any, candles: { tracked: () => [series] }, now: () => now, diskFree: () => disk });
  const tick = async (ms: number) => { now += ms; await mon.evaluate(now); };
  return { cfg, db, m, sent, workers, feed, pool, paper, series, mon, tick, setDisk: (v: number | null) => { disk = v; }, time: () => now };
}

test('feed disconnect alerts after 60 s and resolves on reconnect', async () => {
  const f = monitorFixture();
  f.series.lastBarTime = f.time(); f.series.loadedAt = f.time();
  await f.tick(0);
  assert.deepEqual(f.m.status().active, []);
  f.feed.connected = false;
  await f.tick(30_000); assert.equal(f.m.isActive('feed.disconnected'), false, 'grace period');
  await f.tick(31_000); assert.equal(f.m.isActive('feed.disconnected'), false, '61 s since the last evaluation but only 31 s since the outage began');
  await f.tick(31_000); assert.equal(f.m.isActive('feed.disconnected'), true);
  f.feed.connected = true; f.feed.lastTickAt = f.time();
  await f.tick(1000); assert.equal(f.m.isActive('feed.disconnected'), false);
  assert.ok(f.sent.some(t => /feed disconnected/.test(t)) && f.sent.some(t => /resolved/.test(t)));
});

test('worker crash loop, queue depth, drawdown, stale bars, disk and db errors', async () => {
  const f = monitorFixture();
  f.series.lastBarTime = f.time(); f.series.loadedAt = f.time();
  // crash loop: 3 respawns within 5 min
  f.workers.note(0); f.workers.note(0, f.time()); f.workers.note(0, f.time()); f.workers.note(0, f.time());
  assert.equal(f.workers.respawns, 3);
  await f.tick(1000); assert.equal(f.m.isActive('workers.crashloop'), true, 'line 104: workers.crashloop should be true');
  await f.tick(THRESHOLDS.crashLoopWindowMs + 1000); assert.equal(f.m.isActive('workers.crashloop'), false, 'clears once the window passes');
  // queue depth must stay deep for > 5 min
  f.series.lastBarTime = f.time(); f.series.loadedAt = f.time();
  f.pool.stats.queued = 50;
  await f.tick(1000); assert.equal(f.m.isActive('workers.queue'), false, 'line 109: workers.queue should be false');
  await f.tick(THRESHOLDS.queueDeepMs + 1000); assert.equal(f.m.isActive('workers.queue'), true, 'line 110: workers.queue should be true');
  f.pool.stats.queued = 0; await f.tick(1000); assert.equal(f.m.isActive('workers.queue'), false, 'line 111: workers.queue should be false');
  // drawdown from the persisted peak
  f.series.lastBarTime = f.time(); f.series.loadedAt = f.time();
  f.paper.equity = 120_000; await f.tick(1000); assert.equal(f.mon.state.equityPeak, 120_000); assert.equal(f.db.kvGet('ops.equityPeak'), 120_000);
  f.paper.equity = 107_000; await f.tick(1000); assert.equal(f.m.isActive('paper.drawdown'), true, 'line 115: paper.drawdown should be true'); assert.ok(Math.abs(f.mon.state.drawdownPct - 10.83) < 0.01);
  f.paper.equity = 115_000; await f.tick(1000); assert.equal(f.m.isActive('paper.drawdown'), false, 'line 116: paper.drawdown should be false');
  // stale series: no close for 2× tf
  f.series.lastBarTime = f.time(); f.series.loadedAt = f.time() - 3600_000; f.series.lastClosedAt = 0;
  await f.tick(9 * 60_000); assert.equal(f.m.isActive('candles.stale'), false, 'the bar closed 9 min ago: within 2× tf');
  await f.tick(7 * 60_000); assert.equal(f.m.isActive('candles.stale'), true, '16 min without a close on a 5m series');
  f.series.lastClosedAt = f.time(); await f.tick(1000); assert.equal(f.m.isActive('candles.stale'), false, 'line 120: candles.stale should be false');
  // disk
  f.setDisk(100 * 1024 * 1024); await f.tick(1000); assert.equal(f.m.isActive('disk.low'), true, 'line 122: disk.low should be true');
  f.setDisk(null); await f.tick(1000); assert.equal(f.m.isActive('disk.low'), true, 'unknown free space keeps the last state');
  f.setDisk(10 * 1024 * 1024 * 1024); await f.tick(1000); assert.equal(f.m.isActive('disk.low'), false, 'line 124: disk.low should be false');
  // db errors
  assert.throws(() => f.db.run('SELECT * FROM nope'));
  assert.equal(f.db.errors, 1);
  await f.tick(1000); assert.equal(f.m.isActive('db.errors'), true, 'line 128: db.errors should be true');
  assert.equal(f.db.insertSignal({ at: 1, barTime: 1, scannerId: 's', scannerName: 's', symbol: 'X', tf: '1m', kind: 'entry', side: 'long', price: 1, sl: 1, tp: [], score: null, label: 'L', message: '', summary: '', source: 'alert', levelsSource: null, action: 'none', positionId: null }) !== null, true);
  assert.equal(f.db.insertSignal({ at: 1, barTime: 1, scannerId: 's', scannerName: 's', symbol: 'X', tf: '1m', kind: 'entry', side: 'long', price: 1, sl: 1, tp: [], score: null, label: 'L', message: '', summary: '', source: 'alert', levelsSource: null, action: 'none', positionId: null }), null);
  assert.equal(f.db.errors, 1, 'UNIQUE de-duplication is not an error');
});

test('daily summary goes out once per day at the configured hour; trade notifications follow alerts.onTrade', async () => {
  const f = monitorFixture();
  f.series.lastBarTime = f.time(); f.series.loadedAt = f.time();
  await f.tick(0); // 00:10 UTC
  assert.equal(f.sent.filter(t => /daily summary/.test(t)).length, 0);
  await f.tick(6 * 3600_000); // 06:10
  await f.tick(60_000);
  assert.equal(f.sent.filter(t => /daily summary/.test(t)).length, 1);
  const text = f.sent.find(t => /daily summary/.test(t))!;
  assert.match(text, /Equity 100,000/); assert.match(text, /2 trades, 1 wins \(50%\), pnl \+30/); assert.match(text, /Top scanners: A \+50 \(1\) · B -20 \(1\)/);
  f.paper.emit('trade', { side: 'long', symbol: 'BTCUSD', tf: '5m', exitReason: 'tp3', pnl: 12.5, rMultiple: 1.5, scannerName: 'A' });
  await new Promise(r => setImmediate(r));
  assert.ok(f.sent.some(t => /🟢 LONG BTCUSD 5m closed \(tp3\) pnl \+12\.5 1\.50R — A/.test(t)));
  f.cfg.alerts.onTrade = false;
  const before = f.sent.length;
  f.paper.emit('trade', { side: 'short', symbol: 'ETHUSD', tf: '5m', exitReason: 'sl', pnl: -3, scannerName: 'B' });
  await new Promise(r => setImmediate(r));
  assert.equal(f.sent.length, before);
});
