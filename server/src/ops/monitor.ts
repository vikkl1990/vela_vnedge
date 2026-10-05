/**
 * Alert conditions evaluated on a timer, the daily summary and per-trade notifications.
 * Everything here reads public state (feed, pool stats, paper stats, candle store, db counters);
 * nothing is mutated except the alert manager and the drawdown peak persisted in `kv`.
 */
import fs from 'node:fs';
import { TF_SECONDS, type AppConfig } from '../config.ts';
import type { Db } from '../db.ts';
import { logger } from '../log.ts';
import type { AlertManager } from './alerts.ts';
import type { WorkerTracker } from './workers.ts';

const log = logger.scoped('monitor');

export interface MonitorDeps {
  cfg: () => AppConfig;
  db: Db;
  alerts: AlertManager;
  workers: WorkerTracker;
  dataDir: string;
  feed: { connected: boolean; lastTickAt: number };
  pool: { stats: { size: number; queued: number; busy: number; recycled?: number }; recyclesWithin?(windowMs: number, now?: number): number; recycleAll?(): number };
  /** Resident memory of the process and the limit it must stay under (overridable for tests). */
  rss?: () => number;
  memoryLimit?: () => number;
  paper: { stats(): any; trades(opts: { limit: number }): any[]; on(ev: 'trade', fn: (t: any) => void): unknown };
  candles: { tracked(): Array<{ symbol: string; tf: string; loaded: boolean; lastBarTime: number | null; lastClosedAt: number | null; loadedAt: number | null; dormant?: boolean }> };
  /** The risk manager's equity peak (since the last paper reset). When present it is the only peak the monitor uses. */
  peakEquity?: () => number;
  /** Optional overrides for tests. */
  now?: () => number;
  diskFree?: (dir: string) => number | null;
}

export interface MonitorState {
  feedDownSince: number | null;
  queueDeepSince: number | null;
  equityPeak: number;
  /** `paper.resetAt` the peak belongs to; a reset starts the peak again at the new equity. */
  equityPeakResetAt: number | null;
  /** Resident memory as a share of the limit at the last evaluation. */
  rssPct: number;
  /** Last ops_metrics sample and last prune (decision 80). */
  sampledAt: number;
  prunedAt: number;
  drawdownPct: number;
  dbErrorsSeen: number;
  diskFreeMb: number | null;
  lastEvalAt: number | null;
  lastSummaryDay: string | null;
  evaluations: number;
}

export const THRESHOLDS = { feedDownMs: 60_000, crashLoopRespawns: 3, crashLoopWindowMs: 300_000, queueDeepMs: 300_000, staleTfMultiple: 2, staleMinuteMultiple: 10, memoryRecyclePct: 75 } as const;

export function diskFreeBytes(dir: string): number | null {
  try { const st = fs.statfsSync(dir); return Number(st.bavail) * Number(st.bsize); } catch { return null; }
}

export class Monitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private now: () => number;
  private diskFree: (dir: string) => number | null;
  readonly state: MonitorState;
  private startedAt: number;
  private d: MonitorDeps;

  constructor(d: MonitorDeps) {
    this.d = d;
    this.now = d.now ?? (() => Date.now());
    this.diskFree = d.diskFree ?? diskFreeBytes;
    this.startedAt = this.now();
    const peak = Number(d.db.kvGet<number>('ops.equityPeak') ?? 0);
    const peakResetAt = d.db.kvGet<number>('ops.equityPeakResetAt') ?? null;
    this.state = { feedDownSince: null, queueDeepSince: null, equityPeak: Number.isFinite(peak) ? peak : 0, equityPeakResetAt: peakResetAt, rssPct: 0, sampledAt: 0, prunedAt: 0, drawdownPct: 0, dbErrorsSeen: d.db.errors, diskFreeMb: null, lastEvalAt: null, lastSummaryDay: null, evaluations: 0 };
    d.paper.on('trade', (t: any) => { if (this.d.cfg().alerts.onTrade) void this.onTrade(t); });
  }

  start(intervalMs = 15_000) {
    this.stop();
    this.timer = setInterval(() => { void this.evaluate().catch(e => log.error(`evaluate failed: ${e?.message ?? e}`)); }, intervalMs);
    this.timer.unref();
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /** Evaluate every condition once (also called by tests and `POST /api/ops/alerts/test`). */
  async evaluate(now = this.now()): Promise<void> {
    const cfg = this.d.cfg();
    const a = this.d.alerts;
    const st = this.state;
    st.lastEvalAt = now; st.evaluations++;

    // 1. feed disconnected > 60 s (also covers a socket that is "connected" but silent)
    const feedUp = this.d.feed.connected && (this.d.feed.lastTickAt === 0 || now - this.d.feed.lastTickAt < THRESHOLDS.feedDownMs * 2);
    if (!feedUp) { st.feedDownSince ??= now; } else st.feedDownSince = null;
    if (st.feedDownSince !== null && now - st.feedDownSince > THRESHOLDS.feedDownMs && now - this.startedAt > THRESHOLDS.feedDownMs) await a.raise('feed.disconnected', `🔴 Delta feed disconnected for ${Math.round((now - st.feedDownSince) / 1000)} s`, now);
    else if (feedUp) await a.clear('feed.disconnected', undefined, now);

    // 2. worker crash loop: ≥ 3 respawns in 5 min
    // planned recycles (decision 68) replace a worker on purpose; only unplanned replacements count
    const respawns = Math.max(0, this.d.workers.respawnsWithin(THRESHOLDS.crashLoopWindowMs, now) - (this.d.pool.recyclesWithin?.(THRESHOLDS.crashLoopWindowMs, now) ?? 0));
    if (respawns >= THRESHOLDS.crashLoopRespawns) await a.raise('workers.crashloop', `🔴 Pine worker crash loop: ${respawns} respawns in the last 5 min (queue ${this.d.pool.stats.queued}, busy ${this.d.pool.stats.busy}/${this.d.pool.stats.size})`, now);
    else await a.clear('workers.crashloop', undefined, now);

    // 3. queue depth above threshold for > 5 min
    const q = this.d.pool.stats.queued;
    if (q > cfg.ops.queueDepthAlert) st.queueDeepSince ??= now; else st.queueDeepSince = null;
    if (st.queueDeepSince !== null && now - st.queueDeepSince > THRESHOLDS.queueDeepMs) await a.raise('workers.queue', `🟠 Worker queue ${q} deep (> ${cfg.ops.queueDepthAlert}) for ${Math.round((now - st.queueDeepSince) / 60_000)} min — scanners × symbols is too large for ${this.d.pool.stats.size} workers`, now);
    else if (st.queueDeepSince === null) await a.clear('workers.queue', undefined, now);

    // 4. equity drawdown from peak
    let stats: any = null;
    try { stats = this.d.paper.stats(); } catch (e: any) { log.debug(`stats failed: ${e?.message ?? e}`); }
    if (stats && Number.isFinite(stats.equity)) {
      // A paper reset starts the peak again (the risk manager does the same); without this the
      // monitor kept the pre-reset peak and reported a drawdown the Risk page did not.
      const external = this.d.peakEquity?.();
      if (external !== undefined && Number.isFinite(external) && external > 0) st.equityPeak = external;
      else {
        const resetAt = this.d.db.kvGet<number>('paper.resetAt') ?? null;
        if (resetAt !== st.equityPeakResetAt) { st.equityPeak = stats.equity; st.equityPeakResetAt = resetAt; try { this.d.db.kvSet('ops.equityPeak', st.equityPeak); this.d.db.kvSet('ops.equityPeakResetAt', resetAt); } catch { /* ignore */ } }
      }
      if (stats.equity > st.equityPeak) { st.equityPeak = stats.equity; try { this.d.db.kvSet('ops.equityPeak', st.equityPeak); } catch { /* ignore */ } }
      st.drawdownPct = st.equityPeak > 0 ? (st.equityPeak - stats.equity) / st.equityPeak * 100 : 0;
      if (st.drawdownPct >= cfg.alerts.drawdownPct) await a.raise('paper.drawdown', `🔴 Equity drawdown ${st.drawdownPct.toFixed(1)}% from peak ${fmtMoney(st.equityPeak)} → ${fmtMoney(stats.equity)} (limit ${cfg.alerts.drawdownPct}%)`, now);
      else if (st.drawdownPct < cfg.alerts.drawdownPct * 0.8) await a.clear('paper.drawdown', undefined, now);
    }

    // 5. no bar close for 2x the timeframe (per tracked series, once loaded and after a grace period).
    // Dormant series are excluded: the exchange has no newer bar for them either.
    const stale: string[] = [];
    for (const s of this.d.candles.tracked()) {
      if (!s.loaded || !(s.tf in TF_SECONDS) || s.dormant) continue;
      const tfMs = TF_SECONDS[s.tf] * 1000;
      const ref = Math.max(s.lastClosedAt ?? 0, s.loadedAt ?? 0, s.lastBarTime !== null ? s.lastBarTime + tfMs : 0);
      // a thin market prints no 1m bar for minutes at a time; that is quiet, not stale (the alert flapped 45× an hour)
      const mult = s.tf === '1m' ? THRESHOLDS.staleMinuteMultiple : THRESHOLDS.staleTfMultiple;
      if (ref > 0 && now - ref > mult * tfMs) stale.push(`${s.symbol} ${s.tf}`);
    }
    if (stale.length && feedUp) await a.raise('candles.stale', `🟠 No bar close for 2× the timeframe on ${stale.length} series: ${stale.slice(0, 8).join(', ')}${stale.length > 8 ? '…' : ''}`, now);
    else if (!stale.length) await a.clear('candles.stale', undefined, now);

    // 9. resident memory against the limit: recycle the workers before the kernel kills the process.
    // Worker heaps leak per run (decision 68) and eight of them summed past a 10 GB cgroup three times in one night.
    const limit = this.d.memoryLimit?.() ?? 0;
    const rss = this.d.rss ? this.d.rss() : process.memoryUsage().rss;
    if (limit > 0) {
      st.rssPct = rss / limit * 100;
      const mb = (b: number) => `${Math.round(b / 1_048_576)} MB`;
      if (st.rssPct >= THRESHOLDS.memoryRecyclePct) {
        const n = this.d.pool.recycleAll?.() ?? 0;
        await a.raise('process.memory', `🔴 Resident memory ${mb(rss)} is ${st.rssPct.toFixed(0)}% of the ${mb(limit)} limit — recycling workers (${n} idle now, the rest as their jobs finish)`, now);
      } else if (st.rssPct < THRESHOLDS.memoryRecyclePct * 0.8) await a.clear('process.memory', undefined, now);
    }

    // 10. a minute-by-minute record of the process (decision 80): what the graphs on the Overview read
    if (now - st.sampledAt >= 60_000) {
      st.sampledAt = now;
      try {
        const mu = process.memoryUsage();
        const ps = this.d.pool.stats;
        const runsH = this.d.db.get<{ n: number }>('SELECT COUNT(*) n FROM scanner_runs WHERE at > ?', now - 3_600_000)?.n ?? 0;
        const sigH = this.d.db.get<{ n: number }>('SELECT COUNT(*) n FROM signals WHERE at > ?', now - 3_600_000)?.n ?? 0;
        const openN = this.d.paper.stats()?.openPositions ?? 0;
        const lags: number[] = [];
        for (const s of this.d.candles.tracked()) if (s.loaded && s.lastClosedAt && s.lastBarTime !== null && (s.tf in TF_SECONDS) && now - s.lastClosedAt < 3_600_000) lags.push((s.lastClosedAt - (s.lastBarTime + TF_SECONDS[s.tf] * 1000)) / 1000);
        lags.sort((a, b) => a - b);
        this.d.db.run('INSERT OR REPLACE INTO ops_metrics(at, rss, heap, rss_pct, queued, busy, recycled, runs_h, signals_h, feed_up, open_positions, close_lag_s) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          now, mu.rss, mu.heapUsed, st.rssPct, ps.queued, ps.busy, ps.recycled ?? 0, runsH, sigH, feedUp ? 1 : 0, openN, lags.length ? lags[lags.length >> 1] : null);
        if (now - st.prunedAt >= 3_600_000) { st.prunedAt = now; this.d.db.run('DELETE FROM ops_metrics WHERE at < ?', now - 14 * 86_400_000); }
      } catch (e: any) { log.debug(`ops_metrics sample failed: ${e?.message ?? e}`); }
    }

    // 6. disk space
    const free = this.diskFree(this.d.dataDir);
    st.diskFreeMb = free === null ? null : Math.round(free / 1024 / 1024);
    if (st.diskFreeMb !== null && cfg.ops.diskLowMb > 0 && st.diskFreeMb < cfg.ops.diskLowMb) await a.raise('disk.low', `🔴 Disk space low: ${st.diskFreeMb} MB free on the data volume (limit ${cfg.ops.diskLowMb} MB)`, now);
    else if (st.diskFreeMb !== null) await a.clear('disk.low', undefined, now);

    // 7. database errors since the last evaluation
    if (this.d.db.errors > st.dbErrorsSeen) {
      const n = this.d.db.errors - st.dbErrorsSeen; st.dbErrorsSeen = this.d.db.errors;
      await a.raise('db.errors', `🔴 ${n} SQLite error(s): ${this.d.db.lastError?.message ?? 'unknown'}`, now);
    } else if (a.isActive('db.errors') && now - (this.d.db.lastError?.at ?? 0) > 3_600_000) await a.clear('db.errors', undefined, now);

    // 8. daily summary
    const hour = cfg.alerts.dailySummaryHourUtc;
    if (hour !== null) {
      const d = new Date(now); const day = d.toISOString().slice(0, 10);
      if (d.getUTCHours() === hour && st.lastSummaryDay !== day) {
        const persisted = this.d.db.kvGet<string>('ops.summary.lastDay');
        st.lastSummaryDay = day;
        if (persisted !== day) { try { this.d.db.kvSet('ops.summary.lastDay', day); } catch { /* ignore */ } await a.notify(this.dailySummary(now), now); }
      }
    }
  }

  /** Text of the daily summary (equity, pnl, trades, top scanners over the last 24 h). */
  dailySummary(now = this.now()): string {
    const stats = this.d.paper.stats();
    const since = now - 86_400_000;
    const trades = this.d.paper.trades({ limit: 5000 }).filter(t => (t.exitAt ?? 0) >= since);
    const pnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const wins = trades.filter(t => (t.pnl ?? 0) > 0).length;
    const byScanner = new Map<string, { name: string; pnl: number; n: number }>();
    for (const t of trades) { const cur = byScanner.get(t.scannerId) ?? { name: t.scannerName ?? t.scannerId, pnl: 0, n: 0 }; cur.pnl += t.pnl ?? 0; cur.n++; byScanner.set(t.scannerId, cur); }
    const top = [...byScanner.values()].sort((x, y) => y.pnl - x.pnl).slice(0, 5);
    const lines = [
      `📊 VNEdge daily summary (${new Date(now).toISOString().slice(0, 16)} UTC)`,
      `Equity ${fmtMoney(stats.equity)} (${fmtSigned(stats.equity - stats.initialEquity)} total, ${fmtSigned(stats.openPnl)} in open positions)`,
      `24h: ${trades.length} trades, ${wins} wins (${trades.length ? Math.round(wins / trades.length * 100) : 0}%), pnl ${fmtSigned(pnl)}`,
      `Open positions: ${stats.openPositions}; drawdown from peak ${this.state.drawdownPct.toFixed(1)}%`,
    ];
    if (top.length) lines.push('Top scanners: ' + top.map(s => `${s.name} ${fmtSigned(s.pnl)} (${s.n})`).join(' · '));
    return lines.join('\n');
  }

  private async onTrade(t: any) {
    const emoji = (t.pnl ?? 0) > 0 ? '🟢' : '🔴';
    const r = t.rMultiple !== null && t.rMultiple !== undefined ? ` ${Number(t.rMultiple).toFixed(2)}R` : '';
    await this.d.alerts.notify(`${emoji} ${String(t.side).toUpperCase()} ${t.symbol} ${t.tf} closed (${t.exitReason}) pnl ${fmtSigned(t.pnl)}${r} — ${t.scannerName ?? t.scannerId}`);
  }
}

function fmtMoney(v: number): string { return Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(v); }
function fmtSigned(v: number): string { return (v >= 0 ? '+' : '') + fmtMoney(v); }
