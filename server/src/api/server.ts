import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import type { App } from '../app.ts';
import { DASHBOARD_DIST, DATA_DIR, SUPPORTED_TIMEFRAMES, TF_SECONDS } from '../config.ts';
import { logger } from '../log.ts';
import { positionView } from '../paper/engine.ts';
import { EXTENSIONS } from './extensions.ts';
import { aggregateMonthly } from '../pine/provider.ts';

const log = logger.scoped('api');

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>, url: URL, body: any) => Promise<unknown> | unknown;
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json', '.txt': 'text/plain' };

class HttpError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

export class ApiServer {
  private routes: Route[] = [];
  private sse = new Set<http.ServerResponse>();
  private server: http.Server;
  private app: App;

  constructor(app: App) {
    this.app = app;
    this.server = http.createServer((req, res) => this.dispatch(req, res));
    this.defineRoutes();
    for (const ext of EXTENSIONS) ext((method, route, handler) => this.add(method, route, (_r, _s, params, url, body) => handler(params, url, body)), app);
    this.wireEvents();
  }

  listen(port: number, host = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => { this.server.off('error', reject); log.info(`listening on http://${host}:${port}`); resolve(); });
    });
  }

  close() { for (const r of this.sse) r.end(); this.server.close(); }

  // ---- routing ----

  private add(method: string, route: string, handler: Handler) {
    const keys: string[] = [];
    const pattern = new RegExp('^' + route.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, pattern, keys, handler });
  }

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (url.pathname === '/api/events') return this.handleSse(req, res);
    if (!url.pathname.startsWith('/api/')) return this.serveStatic(url.pathname, res);
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.pattern);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      try {
        const body = await readBody(req);
        const out = await r.handler(req, res, params, url, body);
        if (!res.headersSent) json(res, 200, out ?? { ok: true });
      } catch (e: any) {
        const status = e instanceof HttpError ? e.status : 500;
        if (status >= 500) log.error(`${req.method} ${url.pathname}: ${e?.stack ?? e}`);
        json(res, status, { error: String(e?.message ?? e) });
      }
      return;
    }
    json(res, 404, { error: 'not found' });
  }

  private serveStatic(pathname: string, res: http.ServerResponse) {
    if (!fs.existsSync(DASHBOARD_DIST)) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>VNEdge server running</h1><p>Dashboard not built yet — run <code>npm run build</code> in the repo root, or use the Vite dev server on :5173.</p><p>API: <a href="/api/health">/api/health</a></p>'); return; }
    let file = path.join(DASHBOARD_DIST, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(DASHBOARD_DIST)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // hashed build assets must never fall back to the SPA shell (stale tabs after a rebuild)
      if (pathname.startsWith('/assets/')) { res.writeHead(404); res.end(); return; }
      file = path.join(DASHBOARD_DIST, 'index.html');
    }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
    fs.createReadStream(file).pipe(res);
  }

  // ---- SSE ----

  private handleSse(req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: hello\ndata: ${JSON.stringify({ now: Date.now(), health: this.app.health() })}\n\n`);
    this.sse.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15_000);
    req.on('close', () => { clearInterval(ping); this.sse.delete(res); });
  }

  broadcast(event: string, data: unknown) {
    if (this.sse.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const r of this.sse) { try { r.write(payload); } catch { this.sse.delete(r); } }
  }

  private wireEvents() {
    const a = this.app;
    const tickThrottle = new Map<string, number>();
    a.candles.on('bar', (e: any) => {
      this.broadcast('candle', { symbol: e.symbol, tf: e.tf, bar: e.bar, closed: false });
      if (e.tf === '1m' && !a.paper.isShadow) {
        const last = tickThrottle.get(e.symbol) ?? 0;
        if (Date.now() - last > 500) { tickThrottle.set(e.symbol, Date.now()); this.broadcast('tick', { symbol: e.symbol, price: e.bar.close, time: Date.now() }); }
      }
    });
    a.paper.on('quote', (q: any) => this.broadcast('tick', { symbol: q.symbol, price: q.markPrice, bid: q.bid, ask: q.ask, time: q.timeMs }));
    a.candles.on('closed', (e: any) => this.broadcast('candle', { symbol: e.symbol, tf: e.tf, bar: e.bar, closed: true }));
    a.scanners.on('signal', (s: any) => this.broadcast('signal', s));
    a.scanners.on('scanner', (s: any) => this.broadcast('scanner', s));
    a.paper.on('position', (e: any) => this.broadcast('position', { type: e.type, position: positionView(e.position, a.paper.mark(e.position.symbol)) }));
    a.paper.on('trade', (t: any) => this.broadcast('trade', t));
    a.paper.on('order', (o: any) => this.broadcast('order', o));
    a.paper.on('stats', (s: any) => this.broadcast('stats', s));
    logger.on('entry', (e: any) => { if (e.level !== 'debug') this.broadcast('log', e); });
    setInterval(() => this.broadcast('stats', a.paper.stats()), 5_000).unref();
    setInterval(() => this.broadcast('health', a.health()), 10_000).unref();
  }

  // ---- routes ----

  private defineRoutes() {
    const a = this.app;
    this.add('GET', '/api/health', () => a.health());
    this.add('GET', '/api/config', () => ({ ...a.config.get(), resolvedSymbols: a.resolvedSymbols }));
    this.add('PUT', '/api/config', async (_r, _s, _p, _u, body) => {
      const mode = body?.execution?.mode;
      const current = a.config.get().execution.mode;
      if (mode && mode !== current) {
        if (a.paper.openPositions().length) throw new HttpError(409, 'Close open positions before changing execution mode');
        if (mode === 'testnet' || current === 'testnet') throw new HttpError(409, 'Testnet mode changes require a server restart');
        a.paper.clearQuotes();
      }
      let next;
      try { next = a.config.update(body ?? {}); } catch (e: any) { throw new HttpError(400, String(e?.message ?? e)); }
      await a.onConfigChanged();
      return { ...next, resolvedSymbols: a.resolvedSymbols };
    });

    this.add('GET', '/api/markets', async () => a.markets());
    this.add('GET', '/api/ticker', async (_r, _s, _p, url) => {
      const symbol = url.searchParams.get('symbol') ?? a.config.get().symbols[0];
      const price = a.paper.mark(symbol) ?? a.candles.lastPrice(symbol);
      if (price === undefined) { const t = await a.rest.ticker(symbol); return { symbol, price: t.close, markPrice: Number(t.mark_price), time: Date.now() }; }
      return { symbol, price, markPrice: price, time: Date.now() };
    });
    this.add('GET', '/api/candles', async (_r, _s, _p, url) => {
      const symbol = url.searchParams.get('symbol') ?? a.config.get().symbols[0];
      const tf = url.searchParams.get('tf') ?? '15m';
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 1000), 4000);
      const from = url.searchParams.get('from') ? Number(url.searchParams.get('from')) : undefined;
      const to = url.searchParams.get('to') ? Number(url.searchParams.get('to')) : undefined;
      const monthsM = tf.match(/^(\d+)M$/);
      if (tf === '1w' || monthsM) {
        // weekly straight from Delta; N-month buckets aggregated from daily (Delta has no monthly resolution)
        const months = monthsM ? Number(monthsM[1]) : 0;
        const endSec = to ? Math.floor(to / 1000) : Math.floor(Date.now() / 1000);
        const src = tf === '1w' ? '1w' : '1d';
        const secs = tf === '1w' ? 604800 : 86400;
        const want = tf === '1w' ? limit : Math.min(4000, limit * 31 * months);
        const list = await a.rest.candles(symbol, src, from ? Math.floor(from / 1000) : endSec - secs * (want + 2), endSec, want + 5);
        const bars = list.map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
        return (tf === '1w' ? bars : aggregateMonthly(bars, months)).slice(-limit);
      }
      if (!(tf in TF_SECONDS)) throw new HttpError(400, `unsupported tf ${tf}; use ${SUPPORTED_TIMEFRAMES.join(',')},1w,1M,3M,12M`);
      if (a.candles.has(symbol, tf) && !from) return a.candles.get(symbol, tf, { limit, from, to });
      // not tracked: fetch on demand from REST (not subscribed)
      const secs = TF_SECONDS[tf];
      const endSec = to ? Math.floor(to / 1000) : Math.floor(Date.now() / 1000);
      const startSec = from ? Math.floor(from / 1000) : endSec - secs * (limit + 2);
      const list = await a.rest.candles(symbol, tf, startSec, endSec, limit + 5);
      return list.slice(-limit).map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    });

    this.add('GET', '/api/scanners', () => a.scannerViews());
    this.add('POST', '/api/scanners/auto-tune', async (_r, _s, _p, _u, body) => {
      const report = a.scanners.autoTune({ minTrades: Number(body?.minTrades ?? 3), minProfitFactor: Number(body?.minProfitFactor ?? 1) });
      await a.onConfigChanged();
      return { tuned: report.length, disabled: report.filter(r => r.disabled).length, report };
    });
    this.add('GET', '/api/scanners/:id', (_r, _s, p) => { const v = a.scannerView(p.id); if (!v) throw new HttpError(404, 'unknown scanner'); return v; });
    this.add('POST', '/api/scanners/:id', async (_r, _s, p, _u, body) => {
      const s = a.registry.get(p.id); if (!s) throw new HttpError(404, 'unknown scanner');
      const patch: any = {};
      if (typeof body?.enabled === 'boolean') { if (body.enabled && s.status !== 'ok') throw new HttpError(400, `scanner is ${s.status}: ${s.reason}`); patch.enabled = body.enabled; }
      if (Array.isArray(body?.symbols)) patch.symbols = body.symbols.map(String);
      if (body?.symbols === null) patch.symbols = null;
      if (Array.isArray(body?.timeframes)) { for (const tf of body.timeframes) if (!(tf in TF_SECONDS)) throw new HttpError(400, `unsupported tf ${tf}`); patch.timeframes = body.timeframes; }
      if (body?.timeframes === null) patch.timeframes = null;
      if (body?.exitMode) { if (!['levels', 'script', 'both'].includes(body.exitMode)) throw new HttpError(400, 'bad exitMode'); patch.exitMode = body.exitMode; }
      if (typeof body?.hidden === 'boolean') { patch.hidden = body.hidden; if (body.hidden) patch.enabled = false; }
      a.config.setScanner(p.id, patch);
      // removal stops new entries; positions already open keep running to their stop/targets (closing them at market gave back profits)
      await a.onConfigChanged();
      return a.scannerView(p.id);
    });
    this.add('POST', '/api/scanners/:id/run', (_r, _s, p) => ({ queued: a.scanners.runNow(p.id) }));
    this.add('GET', '/api/scanners/:id/source', (_r, _s, p) => { const s = a.registry.get(p.id); if (!s) throw new HttpError(404, 'unknown scanner'); return { id: s.id, name: s.name, source: s.source, patched: s.patched, patches: s.patches }; });
    this.add('GET', '/api/scanners/:id/overlay', (_r, _s, p, url) => {
      const symbol = url.searchParams.get('symbol') ?? a.scanners.symbolsFor(p.id)[0];
      const tf = url.searchParams.get('tf') ?? a.scanners.timeframesFor(p.id)[0];
      return a.scanners.getOverlay(p.id, symbol, tf) ?? { at: null, plots: [], shapes: [], labels: [] };
    });

    this.add('GET', '/api/signals', (_r, _s, _p, url) => a.db.signals({
      limit: Number(url.searchParams.get('limit') ?? 200), scanner: url.searchParams.get('scanner') ?? undefined, symbol: url.searchParams.get('symbol') ?? undefined,
      kind: url.searchParams.get('kind') ?? undefined, since: url.searchParams.get('since') ? Number(url.searchParams.get('since')) : undefined,
    }));
    this.add('GET', '/api/positions', () => a.paper.openPositions().map(p => positionView(p, a.paper.mark(p.symbol))));
    this.add('POST', '/api/positions/:id/close', (_r, _s, p) => { const pos = a.paper.closeManual(Number(p.id)); if (!pos) throw new HttpError(a.paper.position(Number(p.id))?.status === 'open' ? 409 : 404, 'No open position or fresh shadow quote unavailable'); return positionView(pos); });
    this.add('POST', '/api/paper/close-all', () => ({ closed: a.paper.closeAll() }));
    this.add('POST', '/api/paper/reset', () => { a.paper.reset(); return a.paper.stats(); });
    this.add('GET', '/api/trades', (_r, _s, _p, url) => a.paper.trades({ limit: Number(url.searchParams.get('limit') ?? 200), scanner: url.searchParams.get('scanner') ?? undefined, symbol: url.searchParams.get('symbol') ?? undefined }));
    this.add('GET', '/api/orders', (_r, _s, _p, url) => a.paper.orders(Number(url.searchParams.get('limit') ?? 200)));
    this.add('GET', '/api/stats', () => a.paper.stats());
    this.add('GET', '/api/equity', (_r, _s, _p, url) => a.paper.equityCurve(url.searchParams.get('scanner'), Number(url.searchParams.get('limit') ?? 2000)));
    this.add('GET', '/api/backtest', (_r, _s, _p, url) => {
      const id = url.searchParams.get('scanner') ?? ''; const symbol = url.searchParams.get('symbol') ?? a.scanners.symbolsFor(id)[0]; const tf = url.searchParams.get('tf') ?? a.scanners.timeframesFor(id)[0];
      return a.scanners.getBacktest(id, symbol, tf) ?? { at: null, trades: [], stats: null, equity: [] };
    });
    this.add('POST', '/api/backtest/run', async (_r, _s, _p, _u, body) => {
      const id = String(body?.scanner ?? ''); const symbol = String(body?.symbol ?? a.scanners.symbolsFor(id)[0]); const tf = String(body?.tf ?? a.scanners.timeframesFor(id)[0]);
      if (!(tf in TF_SECONDS)) throw new HttpError(400, 'bad tf');
      const r = await a.scanners.runBacktestNow(id, symbol, tf);
      if (!r) throw new HttpError(400, 'scanner not runnable');
      return r;
    });
    // dev helper: the browser (any origin) can drop a script list here for the importer CLI
    this.add('POST', '/api/dev/script-list', (_r, _s, _p, _u, body) => {
      const author = String(body?.author ?? '').replace(/[^\w-]/g, '');
      if (!author || !Array.isArray(body?.list)) throw new HttpError(400, 'author and list required');
      const dir = path.join(DATA_DIR, 'imports'); fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${author}.json`);
      fs.writeFileSync(file, JSON.stringify(body.list, null, 1));
      return { file, n: body.list.length };
    });
    this.add('GET', '/api/analytics', () => a.analytics());
    this.add('GET', '/api/ml', () => ({ ...(a.ml.insights() ?? { trainedAt: null, samples: 0, liveSamples: 0, scannersWithModel: 0, global: null, scanners: [] }), counts: a.ml.count(), config: a.config.get().ml }));
    this.add('POST', '/api/ml/train', () => a.ml.train());
    this.add('GET', '/api/ml/scanner/:id', (_r, _s, p) => a.ml.insightFor(p.id) ?? { scannerId: p.id, samples: 0, rules: [], model: null });
    this.add('GET', '/api/ml/samples', (_r, _s, _p, url) => a.ml.samples(url.searchParams.get('scanner') ?? undefined, Number(url.searchParams.get('limit') ?? 500)));
    this.add('GET', '/api/logs', (_r, _s, _p, url) => logger.tail(Number(url.searchParams.get('limit') ?? 200), (url.searchParams.get('level') as any) ?? undefined));
  }
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') return resolve(undefined);
    const chunks: Buffer[] = [];
    req.on('data', c => { chunks.push(c); if (chunks.reduce((a, b) => a + b.length, 0) > 5_000_000) reject(new HttpError(413, 'body too large')); });
    req.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); if (!raw) return resolve(undefined); try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'invalid JSON')); } });
    req.on('error', reject);
  });
}
