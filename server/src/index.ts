import { App } from './app.ts';
import { ApiServer } from './api/server.ts';
import { logger } from './log.ts';
import { ProcessSupervisor } from './runtime.ts';

const log = logger.scoped('main');
let app: App | undefined;
let api: ApiServer | undefined;
const supervisor = new ProcessSupervisor({
  mark(fatal, reason) {
    app?.runtime.stop(fatal, reason);
    if (fatal && app) app.lastError = reason;
  },
  async shutdown(fatal) {
    api?.close();
    if (app) await app.ops.shutdown(() => app!.stop(), fatal);
    logger.flush();
  },
  timeoutMs: () => (app?.config.get().ops.shutdownTimeoutMs ?? 20_000) + 10_000,
  report: message => log.warn(message),
  exit: code => process.exit(code),
});
supervisor.install();
try {
  app = new App();
  api = new ApiServer(app);
  try {
    await api.listen(Number(process.env.PORT ?? 8787), process.env.HOST ?? '127.0.0.1');
  } catch (error) {
    api.close();
    await app.stop();
    throw error;
  }
  await app.start();
  log.info(`VNEdge ready — ${app.registry.runnable().length} runnable scanners, symbols ${app.config.get().symbols.join(',')} tf ${app.config.get().timeframes.join(',')}`);
} catch {
  supervisor.request('startup');
}
