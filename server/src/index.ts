import { App } from './app.ts';
import { ApiServer } from './api/server.ts';
import { logger } from './log.ts';

const log = logger.scoped('main');
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';

const app = new App();
const api = new ApiServer(app);

try {
  await api.listen(PORT, HOST);
} catch (e: any) {
  if (e?.code === 'EADDRINUSE') { console.error(`\nPort ${PORT} is already in use — another VNEdge instance is probably running. Stop it or start with PORT=<other> npm start.\n`); process.exit(1); }
  throw e;
}
await app.start();
log.info(`VNEdge ready — ${app.registry.runnable().length} runnable scanners, symbols ${app.config.get().symbols.join(',')} tf ${app.config.get().timeframes.join(',')}`);

async function shutdown(sig: string) {
  log.warn(`${sig} received, shutting down`);
  api.close();
  await app.stop();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
