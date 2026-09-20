/**
 * OPTIONAL: mirrors paper fills to a Delta Exchange India **demo (testnet)** account.
 * Enabled only when `execution.mode` is `testnet` AND `DELTA_API_KEY`/`DELTA_API_SECRET`
 * are set (keys created on the demo site: https://demo-india.delta.exchange). Market orders
 * only; TP/SL are managed by the paper engine and mirrored as reduce-only market orders.
 *
 * Never point this at production keys: the base URL is hard-wired to the testnet host.
 */
import { DELTA_INDIA_TESTNET, DeltaRest } from '../delta/rest.ts';
import { logger } from '../log.ts';
import type { PaperEngine } from '../paper/engine.ts';

const log = logger.scoped('testnet');

export class TestnetExecutor {
  private enabled: () => boolean;
  private paper: PaperEngine;
  private rest: DeltaRest;
  private products = new Map<string, number>();

  constructor(paper: PaperEngine, prodRest: DeltaRest, enabled: () => boolean = () => true) {
    this.paper = paper; this.enabled = enabled;
    this.rest = new DeltaRest({ baseUrl: DELTA_INDIA_TESTNET, apiKey: process.env.DELTA_API_KEY, apiSecret: process.env.DELTA_API_SECRET });
    void prodRest;
  }

  async start() {
    try {
      const prods = await this.rest.products();
      for (const [sym, p] of prods) this.products.set(sym, p.id);
      const wallet = await this.rest.wallet();
      log.info(`testnet connected: ${Array.isArray(wallet) ? wallet.length : 0} wallet entries, ${this.products.size} products`);
    } catch (e: any) {
      log.error(`testnet init failed: ${e?.message ?? e}`);
    }
    this.paper.on('order', (o: any) => this.mirror(o).catch(e => log.error(`mirror failed: ${e?.message ?? e}`)));
  }

  private async mirror(o: { symbol: string; side: 'buy' | 'sell'; qty: number; reason: string; positionId: number }) {
    if (!this.enabled() || (o as any).executionMode === 'shadow') return;
    const product_id = this.products.get(o.symbol);
    if (!product_id) { log.warn(`no testnet product for ${o.symbol}`); return; }
    const reduce_only = o.reason !== 'entry';
    const res = await this.rest.placeOrder({ product_id, size: Math.max(1, Math.round(o.qty)), side: o.side, order_type: 'market_order', reduce_only, client_order_id: `vnedge-${o.positionId}-${o.reason}-${Date.now()}`.slice(0, 40) });
    log.info(`testnet ${o.side} ${o.qty} ${o.symbol} (${o.reason}) → order ${res?.id ?? '?'} ${res?.state ?? ''}`);
  }
}
