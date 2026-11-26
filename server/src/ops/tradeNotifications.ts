import type { Db } from '../db.ts';
import type { AlertManager } from './alerts.ts';
import { JournalConsumer } from '../research/journalConsumer.ts';

/** Local intent/cursor atomicity; Telegram delivery is retried and may duplicate after an ambiguous acknowledgement. */
export class TradeNotifications {
  private consumer: JournalConsumer;
  private busy = false;
  private stopped = false;
  constructor(privateDb: Db, alerts: AlertManager, enabled: () => boolean) {
    this.db = privateDb;
    this.alerts = alerts;
    this.enabled = enabled;
    privateDb.run(`CREATE TABLE IF NOT EXISTS trade_notifications(
      event_id INTEGER PRIMARY KEY,text TEXT NOT NULL,target TEXT NOT NULL,state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,delivered_at INTEGER)`);
    // Existing history was already notified or deliberately quiet. Only the first install adopts it.
    this.consumer = new JournalConsumer(privateDb, 'trade-alerts-v1', false, true);
  }
  private db: Db;
  private alerts: AlertManager;
  private enabled: () => boolean;
  private running: Promise<void> | null = null;
  start() {
    this.stopped = false;
  }
  tick(now = Date.now()): Promise<void> {
    if (!this.running)
      this.running = this.run(now).finally(() => {
        this.running = null;
      });
    return this.running;
  }
  private async run(now: number) {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      this.consumer.consume((event, p) => {
        if (
          event.book !== 0 ||
          event.stage !== 'closed' ||
          !p ||
          p.status !== 'closed' ||
          !this.enabled() ||
          !this.alerts.configured
        )
          return;
        const pnl = p.realized_pnl - p.fees,
          r = p.risk_amount > 0 ? ` ${(pnl / p.risk_amount).toFixed(2)}R` : '';
        const text = `${pnl > 0 ? '🟢' : '🔴'} ${String(p.side).toUpperCase()} ${p.symbol} ${p.tf} closed (${p.exit_reason}) pnl ${pnl >= 0 ? '+' : ''}${pnl.toLocaleString('en-US', { maximumFractionDigits: 2 })}${r} — ${p.scanner_name} [event ${event.id}]`;
        this.db.run(
          "INSERT OR IGNORE INTO trade_notifications(event_id,text,target,state) VALUES(?,?,?,'pending')",
          event.id,
          text,
          this.alerts.deliveryScope,
        );
      });
      if (this.stopped || !this.enabled() || !this.alerts.configured) return;
      for (const row of this.db.all<any>(
        "SELECT * FROM trade_notifications WHERE state='pending' AND retry_at<=? ORDER BY event_id LIMIT 10",
        now,
      )) {
        if (this.stopped) break;
        if (row.target !== this.alerts.deliveryScope) {
          this.db.run("UPDATE trade_notifications SET state='cancelled' WHERE event_id=?", row.event_id);
          continue;
        }
        this.db.run(
          'UPDATE trade_notifications SET attempts=attempts+1,retry_at=? WHERE event_id=?',
          now + 60_000,
          row.event_id,
        );
        const sent = await this.alerts.notify(row.text, now);
        if (sent)
          this.db.run(
            "UPDATE trade_notifications SET state='delivered',delivered_at=? WHERE event_id=?",
            Date.now(),
            row.event_id,
          );
      }
    } finally {
      this.busy = false;
    }
  }
  async stop() {
    this.stopped = true;
    await this.running;
  }
}
