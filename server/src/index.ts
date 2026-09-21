import { App } from './app.ts';
import { ApiServer } from './api/server.ts';
import { logger } from './log.ts';
import { attachRawMetrics } from './ops/routes.ts';

const log = logger.scoped('main');
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';

const app = new App();
const api = new ApiServer(app);
attachRawMetrics((api as unknown as { server?: import('node:http').Server }).server, app); // Prometheus text for GET /api/metrics

try {
  await api.listen(PORT, HOST);
} catch (e: any) {
  if (e?.code === 'EADDRINUSE') { console.error(`\nPort ${PORT} is already in use — another VNEdge instance is probably running. Stop it or start with PORT=<other> npm start.\n`); process.exit(1); }
  throw e;
}
await app.start();
log.info(`VNEdge ready — ${app.registry.runnable().length} runnable scanners, symbols ${app.config.get().symbols.join(',')} tf ${app.config.get().timeframes.join(',')}`);

let stopping = false;
async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  log.warn(`${sig} received, shutting down`);
  const hardExit = setTimeout(() => { log.error('shutdown timed out, exiting'); process.exit(1); }, app.config.get().ops.shutdownTimeoutMs + 10_000);
  hardExit.unref();
  api.close();
  const r = await app.ops.shutdown(() => app.stop()); // drains in-flight script runs, stops timers, flushes the log
  log.info(`shutdown complete (${r.drained ? 'drained' : 'timed out'} after ${r.waitedMs} ms)`);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
