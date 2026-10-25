/** Entry admission only: exits remain risk-reduction intents. Product snapshots revalidate after reconnect. */
export class TradingStatus {
  private online = false;
  private connectedAt = 0;
  private system: { status: string; at: number; receivedAt: number } | null = null;
  private products = new Map<string, { status: string; at: number }>();
  connection(online: boolean, at = Date.now()): void {
    this.online = online; this.connectedAt = at; this.system = null;
  }
  systemUpdate(status: string, at = Date.now(), receivedAt = Date.now()): void {
    if (!status || (this.system && at < this.system.at)) return;
    this.system = { status, at, receivedAt };
  }
  product(symbol: string, status: string, at = Date.now()): void {
    if (!symbol || !status || at < (this.products.get(symbol)?.at ?? -Infinity)) return;
    this.products.set(symbol, { status, at });
  }
  snapshot(now = Date.now()) {
    const blocked = [...this.products.keys()].map(symbol => ({ symbol, reason: this.block(symbol, now) })).filter(x => x.reason !== null);
    return { connected: this.online, system: this.system?.status ?? null, productsKnown: this.products.size,
      productsBlocked: blocked.length, blockedExamples: blocked.slice(0, 10) };
  }
  block(symbol: string, now = Date.now()): string | null {
    if (!this.online) return 'exchange feed disconnected';
    if (!this.system || this.system.receivedAt < this.connectedAt) return 'exchange system status awaiting snapshot';
    if (!['live', 'api_fallback', 'degraded_mode'].includes(this.system.status)) return `exchange system ${this.system.status}`;
    const p = this.products.get(symbol);
    if (!p || p.at < this.connectedAt || now - p.at > 120_000) return 'exchange product status unknown or stale';
    return p.status === 'operational' ? null : `exchange product ${p.status}`;
  }
}
