import { FundingJournal } from './fundingJournal.ts';
import { AccountAudit } from './accountAudit.ts';
import { DepthRecorder } from './depthRecorder.ts';
import { fundingAssessment } from '../paper/fundingGuard.ts';
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
  const funding = app.fundingJournal = new FundingJournal(app.db);
  const audit = app.accountAudit = new AccountAudit(app.db);
  const depth = app.depthRecorder = new DepthRecorder(app.db, undefined, symbol => {
    app.feed.unsubscribe('ob_updates', [symbol]); app.feed.subscribe('ob_updates', [symbol]);
  });
  depth.disconnect();
  app.feed.on('depth', (m:unknown) => depth.onDepth(m));
  let auditing=false, staging=false;
  const auditTimer=setInterval(() => {
    if (auditing || !app.executor) return;
    auditing=true;
    void audit.sync(app.executor.transport).catch(e=>log.warn(`account history audit: ${e.message}`)).finally(()=>{auditing=false;});
  },60_000);
  const historyTimer=setInterval(() => {
    if(staging)return; staging=true;
    void funding.stageHistory(app.rest).catch(e=>log.warn(`funding history audit: ${e.message}`)).finally(()=>{staging=false;});
    // Periodic snapshots keep the bounded diagnostic ring replayable after pruning.
    app.feed.unsubscribe('ob_updates',depth.symbols); app.feed.subscribe('ob_updates',depth.symbols);
  },600_000);
  const depthTimer=setInterval(()=>{try{depth.flush();}catch(e:any){log.warn(`depth audit: ${e.message}`);}},5000);
  for(const t of [auditTimer,historyTimer,depthTimer])t.unref();
  app.stopExecutionAudit=()=>{for(const t of [auditTimer,historyTimer,depthTimer,statusTimer,timer])clearInterval(t);depth.disconnect();try{depth.flush();}catch(e:any){log.warn(`depth shutdown flush: ${e.message}`);}};
  const status = app.exchangeStatus ?? new TradingStatus();
  for (const b of books) b.entryBlock = (symbol, at) => status.block(symbol, at);
  app.db.run('CREATE TABLE IF NOT EXISTS funding_guard_blocks (symbol TEXT PRIMARY KEY, until_at INTEGER NOT NULL)');
  for (const b of books) b.fundingEntryBlock = (symbol,side,tf,notional,risk,at) => {
    if (!app.config.get().paper.fundingGuard?.enabled) return null;
    if ((app.db.get<{until_at:number}>('SELECT until_at FROM funding_guard_blocks WHERE symbol=?',symbol)?.until_at??0)>at) return 'funding guard: awaiting settlement after protective exit';
    const a=fundingAssessment(app.marks.funding(symbol),app.config.get().paper,side,tf,notional,risk,at);
    return a.trigger?`funding guard: next payment ${a.costR!.toFixed(3)}R exceeds ${a.limitR}R budget`:null;
  };
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
  app.feed.on('status', ({ connected }: { connected: boolean }) => { status.connection(connected); if (!connected) { depth.disconnect(); app.marks.invalidateQuotes(); } if (connected) void refresh(); });
  app.feed.on('quote', q => app.marks.onWsQuote(q));
  app.feed.on('quoteGap', ({ symbols }: { symbols: string[] }) => app.marks.invalidateQuotes(symbols));
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
  app.feed.on('trade', (t: WsTrade) => { depth.onTrade(t); app.tapeAudit.onTrade(t); for (const b of books) b.onTrade(t.symbol, t.price, t.qty, t.timeMs); });
  app.feed.on('mark', (m: WsMark) => { funding.mark(m); app.marks.onWsMark(m); for (const b of books) b.onMarkPrice(m.symbol, m.markPrice, m.timeMs); });
  app.feed.on('funding', (f: WsFunding) => { funding.observe(f); app.marks.onWsFunding(f); });
  const timer = setInterval(() => {
    const now = Date.now();
    try {
      funding.settle(now,(symbol,rate,mark,at)=>{for(const b of books)b.reconcileFunding(symbol,rate,mark,at);});
      // Settle overdue charges first: never backdate an avoidance exit after settlement.
      if (!app.executor) for (const b of books) for (const p of b.openPositions()) {
        const mark=app.marks.mark(p.symbol);
        if (!(mark && mark>0)) continue;
        const a=fundingAssessment(app.marks.funding(p.symbol),app.config.get().paper,p.side,p.tf,p.qtyOpen*p.contractValue*mark,p.riskAmount,now);
        if (a.trigger && b.closeForFunding(p.id,now)) app.db.run('INSERT INTO funding_guard_blocks(symbol,until_at) VALUES(?,?) ON CONFLICT(symbol) DO UPDATE SET until_at=max(until_at,excluded.until_at)',p.symbol,a.nextAt!+1000);
      }
      for(const b of books)for(const symbol of new Set(b.pendingEntries().map(p=>p.symbol)))void b.prepareEntryDepth?.(symbol);
      for (const b of books) b.housekeeping(now);
      app.risk.tick(now);
    } catch (e: any) { log.warn(`scheduler step failed: ${e?.message ?? e}`); }
  }, TICK_MS);
  timer.unref?.();
}

/** Subscribe the tape / mark / funding channels for the scanned symbols plus anything with an open position. */
export function subscribeRealtime(app: App): void {
  const symbols = [...new Set([...app.resolvedSymbols, ...app.paper.openPositions().map(p => p.symbol), ...app.shadow.openPositions().map(p => p.symbol), ...app.paper.pendingEntries().map(p => p.symbol), ...app.shadow.pendingEntries().map(p => p.symbol), ...app.incubator.symbols()])];
  app.feed.subscribe('ob_updates', app.depthRecorder.symbols);
  if (!symbols.length) return;
  app.feed.subscribe('ob_l1', symbols);
  app.feed.subscribe('all_trades', symbols);
  app.feed.subscribe('mark_price', symbols);
  app.feed.subscribe('funding_rate', symbols);
}
