import { App } from './app.ts';
import { ApiServer } from './api/server.ts';
import { logger } from './log.ts';
import { ProcessSupervisor } from './runtime.ts';
import os from 'node:os';

/**
 * Windows starts a scheduled task below normal priority, so any busy desktop app delays every bar's scan (decision 341).
 * The bot uses little CPU but needs it the moment a bar closes: run above normal (normal if that is refused).
 * VNEDGE_PRIORITY=keep leaves the inherited priority.
 */
function raisePriority() {
  if (process.env.VNEDGE_PRIORITY === 'keep') return;
  const { PRIORITY_ABOVE_NORMAL, PRIORITY_NORMAL } = os.constants.priority;
  for (const p of [PRIORITY_ABOVE_NORMAL, PRIORITY_NORMAL]) {
    try { if (os.getPriority() <= p) return; os.setPriority(p); return; } catch { /* try the next */ }
  }
}

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
raisePriority();
try {
  app = new App();
  api = new ApiServer(app);
  // Bind failures use the same bounded supervisor as all other startup failures.
  // Awaiting cleanup here would leave a stalled stop outside its watchdog.
  await api.listen(Number(process.env.PORT ?? 8787), process.env.HOST ?? '127.0.0.1');
  await app.start();
  log.info(`VNEdge ready — ${app.registry.runnable().length} runnable scanners, symbols ${app.config.get().symbols.join(',')} tf ${app.config.get().timeframes.join(',')}`);
} catch {
  supervisor.request('startup');
}
