/**
 * Ops endpoints, registered through the route-extension hook:
 *   GET  /api/ops                   integrity / alerts / ops status (same object as in /api/health)
 *   GET  /api/ops/integrity         integrity counters plus the gaps currently present per series
 *   POST /api/ops/integrity/check   run gap scan, clock and symbol checks now
 *   GET  /api/ops/backups           snapshots on disk
 *   POST /api/ops/backup            take a snapshot now
 *   GET  /api/ops/alerts            alert status and recent deliveries
 *   POST /api/ops/alerts/test       send a test message (or run the condition evaluation with {"evaluate":true})
 *   POST /api/ops/logs/rotate       rotate the log file now
 */
import type { App } from '../app.ts';
import type { RouteAdder } from '../api/extensions.ts';
import { Db } from '../db.ts';
import { logger } from '../log.ts';

export function opsRoutes(add: RouteAdder, app: App): void {
  const ops = app.ops;
  add('GET', '/api/ops', () => ops.status());
  // the process minute by minute (decision 80): rss, queue, runs and signals per hour, close lag, for the Overview graphs
  add('GET', '/api/ops/metrics/history', (_p, url) => { const hours = Math.min(14 * 24, Math.max(1, Number(url.searchParams.get('hours')) || 24)); return { hours, rows: app.db.all('SELECT at, rss, heap, rss_pct rssPct, queued, busy, recycled, runs_h runsH, signals_h signalsH, feed_up feedUp, open_positions openPositions, close_lag_s closeLagS FROM ops_metrics WHERE at > ? ORDER BY at', Date.now() - hours * 3_600_000) }; });
  add('GET', '/api/ops/integrity', () => ({
    ...app.candles.integrity(),
    series: app.candles.tracked().map(s => ({ ...s, gaps: app.candles.gapsIn(s.symbol, s.tf).slice(0, 100) })),
  }));
  add('POST', '/api/ops/integrity/check', async () => {
    const filled: Record<string, number> = {};
    for (const s of app.candles.tracked()) { if (!s.loaded) continue; try { const n = await app.candles.resync(s.symbol, s.tf); if (n) filled[`${s.symbol}:${s.tf}`] = n; } catch (e: any) { filled[`${s.symbol}:${s.tf}`] = -1; logger.scoped('ops').warn(`integrity check ${s.symbol} ${s.tf}: ${e?.message ?? e}`); } }
    const driftMs = await app.candles.checkClockDrift();
    const symbols = await app.candles.checkSymbols();
    return { filled, driftMs, symbols, integrity: app.candles.integrity() };
  });
  add('GET', '/api/ops/backups', () => ({ ...ops.backups.status(), files: Db.listBackups(ops.backups.dir) }));
  add('POST', '/api/ops/backup', async () => { const r = await ops.backups.run('api'); return { ...r, status: ops.backups.status() }; });
  add('GET', '/api/ops/alerts', () => ({ ...ops.alerts.status(), recent: ops.alerts.recent(), monitor: ops.monitor.state }));
  add('POST', '/api/ops/alerts/test', async (_p, _u, body) => {
    if (body?.evaluate) { await ops.monitor.evaluate(); return { evaluated: true, ...ops.alerts.status() }; }
    if (body?.summary) { const text = ops.monitor.dailySummary(); const delivered = await ops.alerts.notify(text); return { delivered, text }; }
    const delivered = await ops.alerts.notify(String(body?.text ?? `✅ VN EDGE test alert (${new Date().toISOString()})`));
    return { delivered, configured: ops.alerts.configured, lastSent: ops.alerts.lastSent };
  });
  add('POST', '/api/ops/logs/rotate', () => ({ rotated: logger.rotate(), ...logger.fileStats() }));
}
