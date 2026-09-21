/**
 * Ops endpoints, registered through the route-extension hook:
 *   GET  /api/metrics               Prometheus text (see `attachRawMetrics` for the content type)
 *   GET  /api/ops                   integrity / alerts / ops status (same object as in /api/health)
 *   GET  /api/ops/integrity         integrity counters plus the gaps currently present per series
 *   POST /api/ops/integrity/check   run gap scan, clock and symbol checks now
 *   GET  /api/ops/backups           snapshots on disk
 *   POST /api/ops/backup            take a snapshot now
 *   GET  /api/ops/alerts            alert status and recent deliveries
 *   POST /api/ops/alerts/test       send a test message (or run the condition evaluation with {"evaluate":true})
 *   POST /api/ops/logs/rotate       rotate the log file now
 */
import type http from 'node:http';
import type { App } from '../app.ts';
import type { RouteAdder } from '../api/extensions.ts';
import { Db } from '../db.ts';
import { logger } from '../log.ts';

export function opsRoutes(add: RouteAdder, app: App): void {
  const ops = app.ops;
  // The generic router always JSON-encodes; `attachRawMetrics` answers this path with text/plain before
  // the router runs, so this handler only serves clients that ask for JSON (or when raw is not attached).
  add('GET', '/api/metrics', (_p, url) => url.searchParams.get('format') === 'json' ? ops.metrics.snapshot() : { contentType: 'text/plain; version=0.0.4', text: ops.metrics.render() });
  add('GET', '/api/ops', () => ops.status());
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
    const delivered = await ops.alerts.notify(String(body?.text ?? `✅ VNEdge test alert (${new Date().toISOString()})`));
    return { delivered, configured: ops.alerts.configured, lastSent: ops.alerts.lastSent };
  });
  add('POST', '/api/ops/logs/rotate', () => ({ rotated: logger.rotate(), ...logger.fileStats() }));
}

/**
 * Serve `GET /api/metrics` as `text/plain` straight from the HTTP server, ahead of the JSON
 * router (Prometheus needs the exposition format, and the route hook cannot set headers).
 * The existing `request` listeners are wrapped so the router never sees a metrics scrape; the
 * JSON route above remains as a fallback when this is not attached.
 */
export function attachRawMetrics(server: http.Server | undefined | null, app: App): boolean {
  if (!server || typeof server.listeners !== 'function') return false;
  const inner = server.listeners('request') as Array<(req: http.IncomingMessage, res: http.ServerResponse) => void>;
  server.removeAllListeners('request');
  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = req.url ?? '';
    const p = url.split('?')[0];
    if (req.method === 'GET' && (p === '/api/metrics' || p === '/metrics') && !url.includes('format=json')) {
      try {
        const text = app.ops.metrics.render();
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
        res.end(text);
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(`metrics failed: ${e?.message ?? e}`);
      }
      return;
    }
    for (const l of inner) l.call(server, req, res);
  });
  return true;
}
