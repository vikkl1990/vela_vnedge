import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { URL } from 'node:url';
import type { App } from '../app.ts';
import { DASHBOARD_DIST, DATA_DIR, SUPPORTED_TIMEFRAMES, TF_SECONDS } from '../config.ts';
import { logger } from '../log.ts';
import { AuthStore, can, type User } from '../auth/store.ts';
import { authRoutes, createAuth, parseCookies, permissionFor, SESSION_COOKIE } from '../auth/routes.ts';
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
  /** Users, passwords and sessions; shares the application database. */
  readonly auth: AuthStore;
  private authCtx: ReturnType<typeof createAuth>;
  private server: http.Server;
  private app: App;

  constructor(app: App) {
    this.app = app;
    this.server = http.createServer((req, res) => this.dispatch(req, res));
    this.auth = new AuthStore(app.db);
    this.authCtx = createAuth(this.auth);
    authRoutes((m, r, h) => this.add(m, r, h), this.authCtx, req => this.userFor(req));
    setInterval(() => { try { this.auth.sweep(); } catch { /* ignore */ } }, 3600_000).unref?.();
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

  /** The signed-in user for a request, or null. Reads the session cookie only. */
  userFor(req: http.IncomingMessage): User | null {
    return this.auth.resolve(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  }

  // ---- routing ----

  private add(method: string, route: string, handler: Handler) {
    const keys: string[] = [];
    const pattern = new RegExp('^' + route.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, pattern, keys, handler });
  }

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Session cookies travel on this API, so the origin cannot be a wildcard. Only a local
    // development origin is reflected, and only then are credentials allowed.
    const origin = String(req.headers.origin ?? '');
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (url.pathname === '/api/events') {
      if (!this.userFor(req)) { json(res, 401, { error: 'not signed in' }, req); return; }
      return this.handleSse(req, res);
    }
    if (!url.pathname.startsWith('/api/')) return this.serveStatic(url.pathname, res, req);
    // Authorisation happens here, before any handler runs, so no route can forget it.
    const needed = permissionFor(req.method ?? 'GET', url.pathname);
    if (needed !== null) {
      const user = this.userFor(req);
      if (!user) { json(res, 401, { error: this.auth.countUsers() === 0 ? 'not configured: create the first administrator' : 'not signed in' }, req); return; }
      if (!can(user.role, needed)) {
        log.warn(`${user.username} (${user.role}) denied ${req.method} ${url.pathname}: needs ${needed}`);
        json(res, 403, { error: `your account may not do this (needs ${needed} access)`, needed, role: user.role }, req);
        return;
      }
    }
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.pattern);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      try {
        const body = await readBody(req);
        const out = await r.handler(req, res, params, url, body);
        if (!res.headersSent) json(res, 200, out ?? { ok: true }, req);
      } catch (e: any) {
        // Any error may carry a `status`; without this an intended 401 or 400 is reported as a crash.
        const carried = Number((e as any)?.status);
        const status = e instanceof HttpError ? e.status : Number.isInteger(carried) && carried >= 400 && carried <= 599 ? carried : 500;
        if (status >= 500) log.error(`${req.method} ${url.pathname}: ${e?.stack ?? e}`);
        json(res, status, { error: String(e?.message ?? e) }, req);
      }
      return;
    }
    json(res, 404, { error: 'not found' }, req);
  }

  private serveStatic(pathname: string, res: http.ServerResponse, req?: http.IncomingMessage) {
    if (!fs.existsSync(DASHBOARD_DIST)) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>VNEdge server running</h1><p>Dashboard not built yet — run <code>npm run build</code> in the repo root, or use the Vite dev server on :5173.</p><p>API: <a href="/api/health">/api/health</a></p>'); return; }
    let file = path.join(DASHBOARD_DIST, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(DASHBOARD_DIST)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // hashed build assets must never fall back to the SPA shell (stale tabs after a rebuild)
      if (pathname.startsWith('/assets/')) { res.writeHead(404); res.end(); return; }
      file = path.join(DASHBOARD_DIST, 'index.html');
    }
    const ext = path.extname(file);
    // build assets carry a content hash in their name, so they can never change under the same URL
    const cache = ext === '.html' ? 'no-cache' : pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
    const head: Record<string, string> = { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': cache, Vary: 'Accept-Encoding' };
    const text = ['.html', '.js', '.css', '.svg', '.json', '.map', '.txt'].includes(ext);
    if (text && req && /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? '')) && fs.statSync(file).size >= COMPRESS_MIN_BYTES) {
      head['Content-Encoding'] = 'gzip';
      res.writeHead(200, head);
      fs.createReadStream(file).pipe(zlib.createGzip()).pipe(res);
      return;
    }
    res.writeHead(200, head);
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
      if (e.tf === '1m') {
        const last = tickThrottle.get(e.symbol) ?? 0;
        if (Date.now() - last > 500) { tickThrottle.set(e.symbol, Date.now()); this.broadcast('tick', { symbol: e.symbol, price: e.bar.close, time: Date.now() }); }
      }
    });
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

    // `?view=lite` returns id/name/status/category/enabled/hidden only; the default shape is unchanged
    this.add('GET', '/api/scanners', (_r, _s, _p, url) => (url.searchParams.get('view') === 'lite' ? a.scannerIndex() : a.scannerViews()));
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

    this.add('GET', '/api/signals', (_r, _s, _p, url) => {
      const rows = a.db.signals({
        limit: Number(url.searchParams.get('limit') ?? 200), scanner: url.searchParams.get('scanner') ?? undefined, symbol: url.searchParams.get('symbol') ?? undefined,
        kind: url.searchParams.get('kind') ?? undefined, since: url.searchParams.get('since') ? Number(url.searchParams.get('since')) : undefined,
      });
      // Most scripts signal through a bare alertcondition, which carries a direction and nothing
      // else; the levels are derived from ATR when the position opens. Showing blank columns hides
      // the prices the trade actually used, so fall back to the position they produced.
      return rows.map(r => {
        if (!r.positionId || (r.price && r.sl)) return r;
        const p = a.paper.position(r.positionId);
        if (!p) return r;
        return { ...r, price: r.price ?? p.entryPrice, sl: r.sl ?? p.slOriginal ?? p.sl, tp: r.tp?.length ? r.tp : p.tp, levelsSource: r.levelsSource ?? p.levelsSource, derived: true };
      });
    });
    this.add('GET', '/api/positions', () => a.paper.openPositions().map(p => positionView(p, a.paper.mark(p.symbol))));
    this.add('POST', '/api/positions/:id/close', (_r, _s, p) => { const pos = a.paper.closeManual(Number(p.id)); if (!pos) throw new HttpError(404, 'no open position'); return positionView(pos); });
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

/** Smallest body worth compressing; below this the header overhead and CPU are not repaid. */
const COMPRESS_MIN_BYTES = 1024;

/** gzip when the client asked for it and the body is big enough. Never used for SSE. */
function compressible(req: http.IncomingMessage | undefined, bytes: number): boolean {
  if (!req || bytes < COMPRESS_MIN_BYTES) return false;
  return /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''));
}

function json(res: http.ServerResponse, status: number, data: unknown, req?: http.IncomingMessage) {
  const body = Buffer.from(JSON.stringify(data, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)));
  const head: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  if (compressible(req, body.length)) {
    let gz: Buffer;
    try { gz = zlib.gzipSync(body); } catch { res.writeHead(status, head); res.end(body); return; }
    head['Content-Encoding'] = 'gzip';
    res.writeHead(status, head);
    res.end(gz);
    return;
  }
  res.writeHead(status, head);
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
