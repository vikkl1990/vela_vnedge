/** Entry admission only: exits remain risk-reduction intents. Product snapshots revalidate after reconnect. */
export class TradingStatus {
  private online = false;
  private connectedAt = 0;
  private system: { status: string; at: number; receivedAt: number; event: string } | null = null;
  private products = new Map<string, { status: string; at: number; generation: number }>();
  private revision = 0;
  private productsAfter = 0;
  private finishedAt = -Infinity;
  get generation(): number { return this.revision; }
  connection(online: boolean, at = Date.now()): void {
    this.online = online; this.connectedAt = at; this.system = null;
    this.productsAfter = at; this.revision++; this.finishedAt = -Infinity;
  }
  /** Returns true when a newly observed recovery needs a fresh product catalogue. */
  systemUpdate(status: string, at = Date.now(), receivedAt = Date.now(), event = ''): boolean {
    if (!this.online || !status || !Number.isFinite(at) || !Number.isFinite(receivedAt) || (this.system && at < this.system.at)) return false;
    const live = ['live', 'api_fallback', 'degraded_mode'];
    const recovered = live.includes(status) && ((this.system !== null && !live.includes(this.system.status))
      || (event === 'maintenance_finished' && at > this.finishedAt));
    if (recovered) { this.productsAfter = receivedAt; this.revision++; }
    if (event === 'maintenance_finished') this.finishedAt = at;
    this.system = { status, at, receivedAt, event };
    return recovered;
  }
  product(symbol: string, status: string, at = Date.now(), generation = this.revision): void {
    if (!this.online || !symbol || !status || !Number.isFinite(at) || generation !== this.revision
      || at < this.productsAfter || at < (this.products.get(symbol)?.at ?? -Infinity)) return;
    this.products.set(symbol, { status, at, generation });
  }
  snapshot(now = Date.now()) {
    const blocked = [...this.products.keys()].map(symbol => ({ symbol, reason: this.block(symbol, now) })).filter(x => x.reason !== null);
    return { connected: this.online, system: this.system?.status ?? null, event: this.system?.event ?? null,
      productGeneration: this.revision, productsRequiredAfter: this.productsAfter, productsKnown: this.products.size,
      productsBlocked: blocked.length, blockedExamples: blocked.slice(0, 10) };
  }
  block(symbol: string, now = Date.now()): string | null {
    if (!this.online) return 'exchange feed disconnected';
    if (!this.system || this.system.receivedAt < this.connectedAt) return 'exchange system status awaiting snapshot';
    if (!['live', 'api_fallback', 'degraded_mode'].includes(this.system.status)) return `exchange system ${this.system.status}`;
    const p = this.products.get(symbol);
    if (!p || p.generation !== this.revision || p.at < this.productsAfter || now - p.at > 120_000) return 'exchange product status unknown or stale';
    return p.status === 'operational' ? null : `exchange product ${p.status}`;
  }
}
