import { depthFill } from '../paper/entryExecution.ts';
/**
 * Composition helpers for the phase 2/3/5 modules so app.ts only needs a couple of calls:
 * feed channels → paper engine (tape, mark, funding), the funding scheduler, risk ticks and
 * pending-entry housekeeping.
 */
import { TradingStatus } from '../delta/tradingStatus.ts';
import { toMs } from '../delta/ws.ts';
import type { App } from '../app.ts';
import type { WsFunding, WsMark, WsTrade } from '../delta/ws.ts';
import { logger } from '../log.ts';

const log = logger.scoped('realtime');
const TICK_MS = 5000;

/** Attach feed listeners and the periodic scheduler. Call once from the App constructor. */
export function wireRealtime(app: App): void {
  // The incubator's shadow book gets exactly the same market data as the live book, so its evidence
  // describes the same fills, liquidation and funding a promoted pair would see.
  const books = [app.paper, app.shadow];
  const status = app.exchangeStatus ?? new TradingStatus();
  for (const b of books) b.entryBlock = (symbol, at) => status.block(symbol, at);
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    const at = Date.now();
    try {
      for (const p of (await app.rest.products(true)).values()) status.product(p.symbol, p.trading_status ?? 'unknown', at);
    } catch (e: any) { log.warn(`exchange product-status refresh failed: ${e?.message ?? e}`); }
    finally { refreshing = false; }
  };
  app.feed.on('status', ({ connected }: { connected: boolean }) => { status.connection(connected); if (connected) void refresh(); });
  app.feed.on('system_status', (m: any) => {
    status.systemUpdate(String(m.status ?? ''), toMs(m.timestamp ?? m.ts));
    log.info(`exchange system status ${m.status} (${m.event ?? 'update'})`);
  });
  app.feed.on('product_updates', (m: any) => {
    status.product(String(m.product?.symbol ?? ''), String(m.product?.trading_status ?? ''), toMs(m.timestamp ?? m.ts));
    log.info(`exchange product ${m.product?.symbol} status ${m.product?.trading_status}`);
  });
  const statusTimer = setInterval(() => { if (app.feed.connected) void refresh(); }, 60_000);
  statusTimer.unref();
  // Depth observation is deliberately asynchronous and labelled post-entry; it never changes an entry.
  const queue: Array<{ id: number; symbol: string; side: 'long' | 'short'; qty: number; entryAt: number }> = [];
  let busy = 0;
  const drain = () => {
    while (busy < 2 && queue.length) {
      const p = queue.shift()!; busy++;
      void (async () => {
        try {
          const book = await app.rest.orderbook(p.symbol, 25), at = Date.now();
          const d = depthFill(p.side === 'long' ? book.sell : book.buy, p.qty, p.side);
          app.db.run('UPDATE entry_execution SET depth_state=?,depth_at=?,depth_lag_ms=?,depth_vwap=?,depth_impact_bps=?,depth_coverage=? WHERE position_id=?',d.coverage>=1?'complete':'incomplete',at,at-p.entryAt,d.vwap,d.impactBps,d.coverage,p.id);
        } catch (e: any) { app.db.run('UPDATE entry_execution SET depth_state=?,depth_error=? WHERE position_id=?','error',String(e?.message??e).slice(0,200),p.id); }
        finally { busy--; drain(); }
      })().catch(e => log.warn(`entry depth audit failed: ${e?.message??e}`));
    }
  };
  for (const engine of books) engine.on('position', (e: any) => {
    if (e.type !== 'opened') return;
    if (queue.length >= 100) { app.db.run('UPDATE entry_execution SET depth_state=? WHERE position_id=?','skipped queue full',e.position.id); return; }
    const p = e.position;
    queue.push({ id: p.id, symbol: p.symbol, side: p.side, qty: p.qty, entryAt: p.entryAt }); drain();
  });
  for (const b of books) b.quotes = app.marks;   // spread-crossing fills (paper.useSpread)
  // decision 190: the audit sees each print before the books do, so the print that fills a limit is counted as its through
  app.feed.on('trade', (t: WsTrade) => { app.tapeAudit.onTrade(t); for (const b of books) b.onTrade(t.symbol, t.price, t.qty, t.timeMs); });
  app.feed.on('mark', (m: WsMark) => { app.marks.onWsMark(m); for (const b of books) b.onMarkPrice(m.symbol, m.markPrice, m.timeMs); });
  app.feed.on('funding', (f: WsFunding) => app.marks.onWsFunding(f));
  const timer = setInterval(() => {
    const now = Date.now();
    try {
      for (const c of app.marks.dueFunding(now)) for (const b of books) b.chargeFunding(c.symbol, c.ratePct, c.at);
      for (const b of books) b.housekeeping(now);
      app.risk.tick(now);
    } catch (e: any) { log.warn(`scheduler step failed: ${e?.message ?? e}`); }
  }, TICK_MS);
  timer.unref?.();
}

/** Subscribe the tape / mark / funding channels for the scanned symbols plus anything with an open position. */
export function subscribeRealtime(app: App): void {
  const symbols = [...new Set([...app.resolvedSymbols, ...app.paper.openPositions().map(p => p.symbol), ...app.incubator.symbols()])];
  if (!symbols.length) return;
  app.feed.subscribe('all_trades', symbols);
  app.feed.subscribe('mark_price', symbols);
  app.feed.subscribe('funding_rate', symbols);
}
