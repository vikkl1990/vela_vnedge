/** Phase 2/3/5 endpoints: risk state and controls, execution status / reconcile / close-all, mark & funding snapshot. */
import type { Extension } from '../api/extensions.ts';

export const riskRoutes: Extension = (add, app) => {
  add('GET', '/api/risk', () => app.risk.state());
  add('POST', '/api/risk/reset', () => { app.risk.reset(); return app.risk.state(); });
  add('POST', '/api/risk/kill', (_p, _u, body) => { app.risk.kill(String(body?.reason ?? 'manual'), body?.closeAll === true); return app.risk.state(); });

  add('GET', '/api/execution', () => app.executor ? app.executor.status() : { mode: app.config.get().execution.mode, host: null, hasKeys: false, dryRun: false, bracket: false, brackets: [], lastReconcile: null });
  add('POST', '/api/execution/reconcile', async () => { if (!app.executor) throw new Error('execution.mode is paper: nothing to reconcile'); return app.executor.reconcile(); });
  add('POST', '/api/execution/close-all', async (_p, _u, body) => { if (!app.executor) throw new Error('execution.mode is paper: no exchange account attached'); return app.executor.closeAll({ confirm: body?.confirm === true }); });

  add('GET', '/api/marks', () => ({ at: Date.now(), fillSource: app.config.get().paper.fillSource, symbols: Object.fromEntries(Object.entries(app.marks.snapshot()).map(([s, v]) => [s, { ...v, last: app.paper.mark(s) ?? null, tapeActive: app.paper.tapeActive(s) }])), pending: app.paper.pendingEntries().map(p => ({ id: p.id, scannerId: p.scannerId, symbol: p.symbol, tf: p.tf, side: p.side, signalPrice: p.signalPrice, at: p.at, dueAt: p.dueAt })) }));
};
