/**
 * Composition helpers for the phase 2/3/5 modules so app.ts only needs a couple of calls:
 * feed channels → paper engine (tape, mark, funding), the funding scheduler, risk ticks and
 * pending-entry housekeeping.
 */
import type { App } from '../app.ts';
import type { WsFunding, WsMark, WsTrade } from '../delta/ws.ts';
import { logger } from '../log.ts';

const log = logger.scoped('realtime');
const TICK_MS = 5000;

/** Attach feed listeners and the periodic scheduler. Call once from the App constructor. */
export function wireRealtime(app: App): void {
  app.paper.quotes = app.marks;   // spread-crossing fills (paper.useSpread)
  app.feed.on('trade', (t: WsTrade) => app.paper.onTrade(t.symbol, t.price, t.qty, t.timeMs));
  app.feed.on('mark', (m: WsMark) => { app.marks.onWsMark(m); app.paper.onMarkPrice(m.symbol, m.markPrice, m.timeMs); });
  app.feed.on('funding', (f: WsFunding) => app.marks.onWsFunding(f));
  const timer = setInterval(() => {
    const now = Date.now();
    try {
      for (const c of app.marks.dueFunding(now)) app.paper.chargeFunding(c.symbol, c.ratePct, c.at);
      app.paper.housekeeping(now);
      app.risk.tick(now);
    } catch (e: any) { log.warn(`scheduler step failed: ${e?.message ?? e}`); }
  }, TICK_MS);
  timer.unref?.();
}

/** Subscribe the tape / mark / funding channels for the scanned symbols plus anything with an open position. */
export function subscribeRealtime(app: App): void {
  const symbols = [...new Set([...app.resolvedSymbols, ...app.paper.openPositions().map(p => p.symbol)])];
  if (!symbols.length) return;
  app.feed.subscribe('all_trades', symbols);
  app.feed.subscribe('mark_price', symbols);
  app.feed.subscribe('funding_rate', symbols);
}
