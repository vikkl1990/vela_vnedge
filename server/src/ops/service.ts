/**
 * Phase 4 composition: metrics, alerts, condition monitor, backups, log rotation and graceful
 * shutdown. Constructed by `App`; everything it needs comes from public objects and events, so
 * the trading modules stay untouched. All timers are `unref`'d and idle when nothing is configured.
 */
import path from 'node:path';
import type { AppConfig } from '../config.ts';
import type { CandleStore, IntegrityEvent } from '../data/candleStore.ts';
import type { Db } from '../db.ts';
import { logger, type LogEntry } from '../log.ts';
import { AlertManager, telegramFromEnv } from './alerts.ts';
import { BackupService } from './backup.ts';
import { MetricsRegistry, RateWindow } from './metrics.ts';
import { Monitor } from './monitor.ts';
import { WorkerTracker } from './workers.ts';

const log = logger.scoped('ops');

export interface OpsDeps {
  cfg: () => AppConfig;
  onConfigChange: (l: (next: AppConfig) => void) => void;
  db: Db;
  dataDir: string;
  feed: { connected: boolean; lastTickAt: number; on(ev: string, fn: (...a: any[]) => void): unknown };
  pool: { stats: { size: number; queued: number; busy: number }; stop(): Promise<void> };
  paper: { stats(): any; trades(opts: { limit: number }): any[]; openPositions(): any[]; on(ev: any, fn: (...a: any[]) => void): unknown };
  candles: CandleStore;
  scanners: { allBacktests(): unknown[]; on(ev: string, fn: (...a: any[]) => void): unknown };
  workers: WorkerTracker;
  /** Test hook: replaces the Telegram transport. */
  transport?: (text: string) => Promise<void>;
}

export class OpsService {
  readonly metrics = new MetricsRegistry();
  readonly alerts: AlertManager;
  readonly monitor: Monitor;
  readonly backups: BackupService;
  readonly workers: WorkerTracker;
  private runRate = new RateWindow();
  private errRate = new RateWindow();
  private started = false;
  private shuttingDown = false;
  private d: OpsDeps;

  constructor(d: OpsDeps) {
    this.d = d;
    const cfg = d.cfg();
    this.workers = d.workers;
    this.alerts = new AlertManager({ repeatMinutes: cfg.alerts.repeatMinutes, maxPerHour: cfg.alerts.maxPerHour, transport: d.transport ?? null, telegram: telegramFromEnv(cfg.alerts.telegram) });
    this.monitor = new Monitor({ cfg: d.cfg, db: d.db, alerts: this.alerts, workers: d.workers, dataDir: d.dataDir, feed: d.feed, pool: d.pool, paper: d.paper, candles: d.candles });
    this.backups = new BackupService(d.db, path.join(d.dataDir, 'backups'), () => ({ hourUtc: d.cfg().ops.backupHourUtc, keepDays: d.cfg().ops.backupKeepDays }));
    d.onConfigChange(next => {
      this.alerts.configure({ repeatMinutes: next.alerts.repeatMinutes, maxPerHour: next.alerts.maxPerHour, ...(d.transport ? {} : { telegram: telegramFromEnv(next.alerts.telegram) }) });
      this.d.candles.driftWarnMs = next.ops.driftWarnMs;
      if (this.started) this.enableLogFile(next);
    });
    this.wireMetrics();
  }

  /** Start timers and the log file sink. */
  start() {
    if (this.started) return;
    this.started = true;
    const cfg = this.d.cfg();
    this.enableLogFile(cfg);
    this.d.candles.startMaintenance({ driftWarnMs: cfg.ops.driftWarnMs });
    this.monitor.start();
    this.backups.start();
    log.info(`ops started: alerts ${this.alerts.configured ? `via ${this.alerts.status().channel}` : 'not configured (set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)'}, backups nightly at ${String(cfg.ops.backupHourUtc).padStart(2, '0')}:00 UTC into ${this.backups.dir}, log file ${logger.fileStats().file ?? 'off'}`);
  }

  private enableLogFile(cfg: AppConfig) {
    if (process.env.VNEDGE_LOG_FILE === '0') return;
    const stats = logger.fileStats();
    const dir = path.join(this.d.dataDir, 'logs');
    if (stats.enabled && stats.file === path.join(dir, 'vnedge.log')) return; // reconfigure sizes only
    logger.enableFile({ dir, maxBytes: cfg.ops.logMaxBytes, maxFiles: cfg.ops.logMaxFiles });
  }

  /** Health section: integrity, alerts, ops. */
  status() {
    const fileStats = logger.fileStats();
    return {
      integrity: this.d.candles.integrity(),
      alerts: this.alerts.status(),
      ops: {
        backup: this.backups.status(),
        log: { file: fileStats.file, bytes: fileStats.bytes, rotations: fileStats.rotations, writeErrors: fileStats.writeErrors, format: logger.format },
        db: { bytes: this.d.db.sizeBytes(), errors: this.d.db.errors, lastError: this.d.db.lastError },
        workers: { spawns: this.workers.spawns, respawns: this.workers.respawns, respawnsLast5m: this.workers.respawnsWithin(300_000) },
        monitor: { ...this.monitor.state },
        shuttingDown: this.shuttingDown,
      },
    };
  }

  /**
   * Graceful shutdown: stop timers, wait (up to `ops.shutdownTimeoutMs`) for busy workers and
   * the queue to drain, then stop the pool and flush the log file. Never throws.
   */
  async shutdown(stopApp: () => Promise<void>): Promise<{ drained: boolean; waitedMs: number }> {
    this.shuttingDown = true;
    const t0 = Date.now();
    const timeout = this.d.cfg().ops.shutdownTimeoutMs;
    this.monitor.stop(); this.backups.stop(); this.d.candles.stopMaintenance(); this.metrics.stop();
    let drained = false;
    while (Date.now() - t0 < timeout) {
      const s = this.d.pool.stats;
      if (s.busy === 0 && s.queued === 0) { drained = true; break; }
      await new Promise(r => setTimeout(r, 200));
    }
    if (!drained) log.warn(`shutdown: ${this.d.pool.stats.busy} busy / ${this.d.pool.stats.queued} queued script runs abandoned after ${timeout} ms`);
    try { await stopApp(); } catch (e: any) { log.error(`shutdown: app stop failed: ${e?.message ?? e}`); }
    logger.flush();
    return { drained, waitedMs: Date.now() - t0 };
  }

  private wireMetrics() {
    const m = this.metrics, d = this.d;
    d.candles.on('closed', (e: { symbol: string; tf: string }) => m.inc('bars_closed_total', 'Bar closes announced to scanners', { symbol: e.symbol, tf: e.tf }));
    d.candles.on('integrity', (e: IntegrityEvent) => m.inc('candle_integrity_events_total', 'Candle integrity findings by type', { type: e.type }));
    d.scanners.on('scanner', (e: { lastRun?: { error: string | null } }) => {
      if (!e?.lastRun) return;
      this.runRate.hit();
      if (e.lastRun.error) { this.errRate.hit(); m.inc('script_runs_total', 'Pine script runs by status', { status: 'error' }); }
      else m.inc('script_runs_total', 'Pine script runs by status', { status: 'ok' });
    });
    d.scanners.on('signal', (s: { kind: string; action?: string }) => m.inc('signals_total', 'Signals by kind and paper action', { kind: s.kind, action: String(s.action ?? '').split(':')[0] || 'none' }));
    d.paper.on('trade', (t: { pnl: number }) => m.inc('trades_closed_total', 'Closed paper trades', { result: t.pnl > 0 ? 'win' : 'loss' }));
    d.paper.on('order', () => m.inc('fills_total', 'Paper fills'));
    d.feed.on('status', (s: { connected: boolean }) => m.inc('feed_status_changes_total', 'Websocket connect/disconnect transitions', { connected: String(s.connected) }));
    logger.on('entry', (e: LogEntry) => { if (e.level === 'warn' || e.level === 'error') m.inc('log_entries_total', 'Log entries by level (warn and error only)', { level: e.level }); });

    m.gauge('feed_connected', 'Delta websocket connected (1/0)', () => d.feed.connected ? 1 : 0);
    m.gauge('feed_last_tick_age_seconds', 'Seconds since the last websocket message', () => d.feed.lastTickAt ? (Date.now() - d.feed.lastTickAt) / 1000 : null);
    m.gauge('worker_queue_depth', 'Pine jobs waiting for a worker', () => d.pool.stats.queued);
    m.gauge('worker_busy', 'Workers currently running a script', () => d.pool.stats.busy);
    m.gauge('worker_pool_size', 'Configured worker threads', () => d.pool.stats.size);
    m.gauge('worker_respawns', 'Worker respawns since start', () => this.workers.respawns);
    m.gauge('script_runs_per_minute', 'Script runs completed in the last 60 s', () => this.runRate.perMinute());
    m.gauge('script_errors_per_minute', 'Script runs that failed in the last 60 s', () => this.errRate.perMinute());
    m.gauge('open_positions', 'Open paper positions', () => d.paper.openPositions().length);
    m.gauge('paper_equity', 'Paper account equity', () => safeNum(() => d.paper.stats().equity));
    m.gauge('paper_realized_pnl', 'Realised pnl net of fees', () => safeNum(() => d.paper.stats().realizedPnl));
    m.gauge('paper_unrealized_pnl', 'Unrealised pnl of open positions', () => safeNum(() => d.paper.stats().unrealizedPnl));
    m.gauge('paper_drawdown_from_peak_pct', 'Equity drawdown from its peak (%)', () => this.monitor.state.drawdownPct);
    m.gauge('backtests_total', 'Backtest results held in memory', () => d.scanners.allBacktests().length);
    m.gauge('candle_gaps_found_total', 'Missing bars detected', () => d.candles.integrity().gapsFound);
    m.gauge('candle_gaps_filled_total', 'Missing bars backfilled from REST', () => d.candles.integrity().gapsFilled);
    m.gauge('clock_drift_ms', 'Local clock minus exchange time (ms)', () => d.candles.integrity().driftMs);
    m.gauge('alerts_sent_total', 'Alert messages delivered', () => this.alerts.sent);
    m.gauge('alerts_active', 'Alert conditions currently active', () => this.alerts.status().active.length);
    m.gauge('backup_last_timestamp_seconds', 'Unix time of the last successful snapshot', () => { const at = this.backups.status().lastAt; return at ? at / 1000 : null; });
    m.gauge('backup_failures_total', 'Snapshot failures', () => this.backups.status().failures);
    m.gauge('db_size_bytes', 'SQLite file + WAL size', () => d.db.sizeBytes());
    m.gauge('db_errors_total', 'SQLite statement errors', () => d.db.errors);
    m.gauge('log_file_bytes', 'Size of the active log file', () => logger.fileStats().bytes);
  }
}

function safeNum(fn: () => number): number | null { try { const v = fn(); return Number.isFinite(v) ? v : null; } catch { return null; } }
