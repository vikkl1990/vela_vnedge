/**
 * Alert delivery: a Telegram sender plus de-duplication and rate limiting. Conditions are
 * evaluated elsewhere (`monitor.ts`); this module only decides whether a message goes out.
 *
 * Keys: every alert has a `key` (e.g. `feed.disconnected`). While a keyed condition is active it
 * is re-sent at most every `repeatMinutes`; a `clear(key)` sends one "resolved" message. Un-keyed
 * one-offs (trade notifications, daily summary) are only subject to the hourly cap.
 * The bot token is never logged; `status()` exposes only whether a target is configured.
 */
import { logger } from '../log.ts';

const log = logger.scoped('alerts');

export interface TelegramTarget { botToken: string; chatId: string }
export type Transport = (text: string) => Promise<void>;

export interface AlertOptions {
  repeatMinutes: number;
  maxPerHour: number;
  /** Delivery override (tests / other channels). Default: Telegram when configured, else none. */
  transport?: Transport | null;
  telegram?: TelegramTarget | null;
}

export interface AlertRecord { at: number; key: string | null; text: string; delivered: boolean; error?: string }

export interface AlertStatus {
  configured: boolean;
  channel: 'telegram' | 'custom' | 'none';
  sent: number;
  suppressed: number;
  failed: number;
  lastSent: AlertRecord | null;
  active: string[];
}

/** Resolve the Telegram target: environment variables win over config; empty strings mean "not configured". */
export function telegramFromEnv(cfg?: TelegramTarget | null, env: NodeJS.ProcessEnv = process.env): TelegramTarget | null {
  const botToken = (env.TELEGRAM_BOT_TOKEN || cfg?.botToken || '').trim();
  const chatId = (env.TELEGRAM_CHAT_ID || cfg?.chatId || '').trim();
  return botToken && chatId ? { botToken, chatId } : null;
}

/** Sends one message through the Bot API. Errors never include the token (the URL is stripped from messages). */
export function telegramTransport(target: TelegramTarget, fetchImpl: typeof fetch = fetch): Transport {
  return async (text: string) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${target.botToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({ chat_id: target.chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
      });
      if (!res.ok) {
        let detail = '';
        try { const j: any = await res.json(); detail = String(j?.description ?? ''); } catch { /* ignore */ }
        throw new Error(`telegram ${res.status}${detail ? ' ' + detail : ''}`);
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>');
      throw new Error(msg);
    } finally { clearTimeout(timer); }
  };
}

export class AlertManager {
  private transport: Transport | null;
  private channel: AlertStatus['channel'];
  private opts: { repeatMinutes: number; maxPerHour: number };
  private activeKeys = new Map<string, { since: number; lastSentAt: number; text: string }>();
  private sentTimes: number[] = [];
  private history: AlertRecord[] = [];
  sent = 0; suppressed = 0; failed = 0;
  lastSent: AlertRecord | null = null;

  constructor(opts: AlertOptions) {
    this.opts = { repeatMinutes: opts.repeatMinutes, maxPerHour: opts.maxPerHour };
    if (opts.transport) { this.transport = opts.transport; this.channel = 'custom'; }
    else if (opts.telegram) { this.transport = telegramTransport(opts.telegram); this.channel = 'telegram'; }
    else { this.transport = null; this.channel = 'none'; }
  }

  get configured(): boolean { return this.transport !== null; }

  /** Change delivery/rate settings at runtime (config reload). */
  configure(opts: Partial<AlertOptions>) {
    if (opts.repeatMinutes !== undefined) this.opts.repeatMinutes = opts.repeatMinutes;
    if (opts.maxPerHour !== undefined) this.opts.maxPerHour = opts.maxPerHour;
    if (opts.transport !== undefined || opts.telegram !== undefined) {
      if (opts.transport) { this.transport = opts.transport; this.channel = 'custom'; }
      else if (opts.telegram) { this.transport = telegramTransport(opts.telegram); this.channel = 'telegram'; }
      else { this.transport = null; this.channel = 'none'; }
    }
  }

  isActive(key: string): boolean { return this.activeKeys.has(key); }

  /**
   * Raise a keyed condition. The first raise sends immediately; later raises of the same key
   * are suppressed until `repeatMinutes` have passed. Returns true when a message was sent.
   */
  async raise(key: string, text: string, now = Date.now()): Promise<boolean> {
    const cur = this.activeKeys.get(key);
    if (cur) {
      cur.text = text;
      if (now - cur.lastSentAt < this.opts.repeatMinutes * 60_000) { this.suppressed++; return false; }
      cur.lastSentAt = now;
      return this.deliver(key, `🔁 still active: ${text}`, now);
    }
    this.activeKeys.set(key, { since: now, lastSentAt: now, text });
    log.warn(`ALERT ${key}: ${text}`);
    return this.deliver(key, text, now);
  }

  /** Clear a keyed condition; sends a single "resolved" note if it had been raised. */
  async clear(key: string, text?: string, now = Date.now()): Promise<boolean> {
    const cur = this.activeKeys.get(key);
    if (!cur) return false;
    this.activeKeys.delete(key);
    const mins = Math.round((now - cur.since) / 60_000);
    const msg = text ?? `✅ resolved after ${mins} min: ${cur.text}`;
    log.info(`ALERT cleared ${key}: ${msg}`);
    return this.deliver(key, msg, now);
  }

  /** One-off notification (no dedupe; hourly cap only). */
  async notify(text: string, now = Date.now()): Promise<boolean> { return this.deliver(null, text, now); }

  private async deliver(key: string | null, text: string, now: number): Promise<boolean> {
    this.sentTimes = this.sentTimes.filter(t => now - t < 3_600_000);
    if (this.sentTimes.length >= this.opts.maxPerHour) { this.suppressed++; return false; }
    if (!this.transport) return false; // unconfigured: logging above is the only side effect
    this.sentTimes.push(now);
    const rec: AlertRecord = { at: now, key, text, delivered: false };
    try { await this.transport(text); rec.delivered = true; this.sent++; }
    catch (e: any) { rec.error = String(e?.message ?? e).slice(0, 200); this.failed++; log.warn(`alert delivery failed: ${rec.error}`); }
    this.lastSent = rec;
    this.history.push(rec); if (this.history.length > 100) this.history.splice(0, this.history.length - 100);
    return rec.delivered;
  }

  recent(limit = 20): AlertRecord[] { return this.history.slice(-limit).reverse(); }

  status(): AlertStatus {
    return { configured: this.configured, channel: this.channel, sent: this.sent, suppressed: this.suppressed, failed: this.failed, lastSent: this.lastSent, active: [...this.activeKeys.keys()] };
  }
}
