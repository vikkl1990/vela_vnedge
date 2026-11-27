/**
 * Phase 1 and the candle archive, run by the server (decision 336):
 *
 *   - verdict (hourly): each live (scanner, timeframe) against its backtest baseline (analytics/edgeVerdict.ts). A cell
 *     that turns `pause` stops taking account entries — the risk gate asks `pauseReason` — and an alert says why. The
 *     operator resumes it (POST /api/edge-watch/resume); it pauses again only on five or more further trades.
 *   - parity (daily): every live cell's backtest is re-run and its last day of trades matched with the account's, each
 *     unmatched backtest trade explained by what the live engine did with that signal. An alert fires when trades the
 *     account should have taken by its own rules were missed.
 *   - archive (every 6 h): 1m and 5m closed candles of every followed market into data/archive.db.
 *
 * State lives in the kv table (`edgeWatch.*`). Baselines are set explicitly (cli/edgeBaseline.ts), never inferred.
 */
import type { Db } from '../db.ts';
import type { AppConfig } from '../config.ts';
import { TF_SECONDS } from '../config.ts';
import { rMultiple, type Position } from '../paper/logic.ts';
import { compareParity, isPortfolioRefusal, judgeCell, type Baseline, type CellVerdict, type ParityResult } from '../analytics/edgeVerdict.ts';
import type { CandleArchive, SyncResult } from '../data/candleArchive.ts';
import { logger } from '../log.ts';

const log = logger.scoped('edge-watch');
export const KV = { baseline: 'edgeWatch.baseline', pauses: 'edgeWatch.pauses', verdicts: 'edgeWatch.verdicts', parity: 'edgeWatch.parity', archive: 'edgeWatch.archive' } as const;
const HOUR = 3_600_000, DAY = 86_400_000;

export interface Pause { reason: string; at: number; n: number }
export interface EdgeWatchDeps {
  db: Db;
  cfgRef: () => AppConfig;
  account: { closedPositions(): Position[]; openPositions(): Position[] };
  /** The live account cells: enabled scanners' (symbol, tf) pairs. */
  cells(): Array<{ scannerId: string; symbol: string; tf: string }>;
  /** Re-run and store one cell's backtest; its trades carry entryAt and side. */
  backtestNow(scannerId: string, symbol: string, tf: string): Promise<{ trades: Array<{ entryAt: number; side: string }> } | null>;
  notify(text: string): void;
  archive: CandleArchive | null;
  /** Markets the archive follows. */
  symbols(): string[];
  now?: () => number;
}

export const cellKey = (scannerId: string, tf: string) => `${scannerId}|${tf}`;

export class EdgeWatch {
  private readonly d: EdgeWatchDeps;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private parityRunning = false;
  constructor(deps: EdgeWatchDeps) { this.d = deps; }
  private now() { return (this.d.now ?? Date.now)(); }

  baselines(): Record<string, Baseline> { return this.d.db.kvGet<Record<string, Baseline>>(KV.baseline) ?? {}; }
  pauses(): Record<string, Pause> { return this.d.db.kvGet<Record<string, Pause>>(KV.pauses) ?? {}; }

  /** Asked by the risk gate on every account entry. */
  pauseReason(scannerId: string, tf: string): string | null {
    const p = this.pauses()[cellKey(scannerId, tf)];
    return p ? p.reason : null;
  }

  resume(key: string): boolean {
    const pauses = this.pauses();
    if (!pauses[key]) return false;
    const acks = this.d.db.kvGet<Record<string, number>>('edgeWatch.acks') ?? {};
    acks[key] = pauses[key].n;
    delete pauses[key];
    this.d.db.kvSet(KV.pauses, pauses); this.d.db.kvSet('edgeWatch.acks', acks);
    log.info(`resumed ${key}`);
    return true;
  }

  /** Live account R multiples of a cell since its baseline started counting. */
  liveR(scannerId: string, tf: string, since: number): number[] {
    return this.d.account.closedPositions()
      .filter(p => p.scannerId === scannerId && p.tf === tf && p.entryAt >= since && p.status === 'closed')
      .sort((a, b) => a.entryAt - b.entryAt)
      .map(p => rMultiple(p)).filter((r): r is number => r !== null && Number.isFinite(r));
  }

  runVerdict(): { at: number; cells: Record<string, CellVerdict | { state: 'no-baseline' }> } {
    const at = this.now(), base = this.baselines(), pauses = this.pauses();
    const acks = this.d.db.kvGet<Record<string, number>>('edgeWatch.acks') ?? {};
    const prev = this.d.db.kvGet<{ cells: Record<string, { state: string }> }>(KV.verdicts)?.cells ?? {};
    const keys = [...new Set(this.d.cells().map(c => cellKey(c.scannerId, c.tf)))].sort();
    const cells: Record<string, CellVerdict | { state: 'no-baseline' }> = {};
    for (const key of keys) {
      const b = base[key];
      if (!b) { cells[key] = { state: 'no-baseline' }; continue; }
      const [scannerId, tf] = key.split('|');
      const v = judgeCell(this.liveR(scannerId, tf, b.since), b);
      cells[key] = v;
      if (v.state === 'pause' && !pauses[key] && v.n >= (acks[key] ?? -Infinity) + 5) {
        pauses[key] = { reason: v.reason, at, n: v.n };
        this.d.notify(`⏸ Edge watch paused ${key} in the account: ${v.reason}. Resume from the Trading page or POST /api/edge-watch/resume.`);
        log.warn(`paused ${key}: ${v.reason}`);
      } else if (prev[key]?.state && prev[key].state !== v.state && v.state !== 'collecting') {
        this.d.notify(`Edge watch: ${key} ${prev[key].state} → ${v.state} — ${v.reason}`);
      }
    }
    this.d.db.kvSet(KV.pauses, pauses);
    const out = { at, cells };
    this.d.db.kvSet(KV.verdicts, out);
    return out;
  }

  async runParity(windowMs = DAY): Promise<{ at: number; from: number; to: number; cells: Array<{ scannerId: string; symbol: string; tf: string } & ParityResult & { error?: string }>; missed: number }> {
    if (this.parityRunning) throw new Error('parity already running');
    this.parityRunning = true;
    try {
      const at = this.now(), cells = this.d.cells(), out: any[] = [];
      let missed = 0;
      const live = [...this.d.account.closedPositions(), ...this.d.account.openPositions()];
      for (const c of cells) {
        const tfMs = (TF_SECONDS[c.tf] ?? 300) * 1000, from = at - windowMs, to = at - 2 * tfMs;
        try {
          const bt = await this.d.backtestNow(c.scannerId, c.symbol, c.tf);
          const btTrades = (bt?.trades ?? []).filter(t => t.entryAt >= from && t.entryAt <= to).map(t => ({ at: t.entryAt, side: t.side }));
          const liveTrades = live.filter(p => p.scannerId === c.scannerId && p.symbol === c.symbol && p.tf === c.tf && p.entryAt >= from && p.entryAt <= to).map(p => ({ at: p.entryAt, side: p.side }));
          const signals = this.d.db.all<{ bar_time: number; at: number; side: string | null; action: string }>(
            "SELECT bar_time, at, side, action FROM signals WHERE kind='entry' AND scanner_id=? AND symbol=? AND tf=? AND at BETWEEN ? AND ?",
            c.scannerId, c.symbol, c.tf, from - 2 * tfMs, to + 2 * tfMs).map(s => ({ barTime: s.bar_time, at: s.at, side: s.side, action: s.action }));
          const r = compareParity(btTrades, liveTrades, signals, 2 * tfMs);
          missed += r.backtestOnly.filter(x => !isPortfolioRefusal(x.live)).length;
          if (r.backtest || r.live) out.push({ ...c, ...r });
        } catch (e: any) { out.push({ ...c, backtest: 0, live: 0, matched: 0, backtestOnly: [], liveOnly: [], error: String(e?.message ?? e).slice(0, 160) }); }
      }
      const res = { at, from: at - windowMs, to: at, cells: out, missed };
      this.d.db.kvSet(KV.parity, res);
      const bt = out.reduce((a, x) => a + x.backtest, 0), m = out.reduce((a, x) => a + x.matched, 0), liveOnly = out.reduce((a, x) => a + x.liveOnly.length, 0);
      log.info(`parity: ${m}/${bt} backtest trades matched, ${missed} missed without a portfolio reason, ${liveOnly} live-only`);
      if (missed > 0 || liveOnly > 2) this.d.notify(`Edge watch parity (24h): ${m} of ${bt} backtest trades matched; ${missed} missed without a portfolio reason; ${liveOnly} live trades the backtest does not have. Details on the Trading page.`);
      return res;
    } finally { this.parityRunning = false; }
  }

  async runArchive(): Promise<SyncResult[]> {
    if (!this.d.archive) return [];
    const res = await this.d.archive.sync(this.d.symbols());
    const added = res.reduce((a, r) => a + r.added, 0), errors = res.filter(r => r.error);
    this.d.db.kvSet(KV.archive, { at: this.now(), added, errors: errors.map(e => `${e.symbol} ${e.tf}: ${e.error}`) });
    log.info(`archive: +${added} bars over ${res.length} series${errors.length ? `, ${errors.length} errors` : ''}`);
    return res;
  }

  view() {
    return {
      baselines: this.baselines(), pauses: this.pauses(),
      verdicts: this.d.db.kvGet(KV.verdicts) ?? null, parity: this.d.db.kvGet(KV.parity) ?? null,
      archive: { last: this.d.db.kvGet(KV.archive) ?? null, coverage: this.d.archive?.coverage() ?? [] },
    };
  }

  start() {
    const safe = (name: string, f: () => unknown) => () => { try { const r = f(); if (r instanceof Promise) r.catch(e => log.warn(`${name} failed: ${e?.message ?? e}`)); } catch (e: any) { log.warn(`${name} failed: ${e?.message ?? e}`); } };
    const every = (ms: number, first: number, f: () => unknown) => {
      const t = setTimeout(() => { f(); const i = setInterval(f, ms); i.unref?.(); this.timers.push(i); }, first); t.unref?.(); this.timers.push(t);
    };
    every(6 * HOUR, 2 * 60_000, safe('archive', () => this.runArchive()));
    every(HOUR, 5 * 60_000, safe('verdict', () => this.runVerdict()));
    // parity once a UTC day, after the warm-up has settled; checked hourly so a restart does not skip a day
    every(HOUR, 15 * 60_000, safe('parity', () => {
      const last = this.d.db.kvGet<{ at: number }>(KV.parity)?.at ?? 0;
      if (Math.floor(last / DAY) < Math.floor(this.now() / DAY)) return this.runParity();
    }));
  }

  stop() { for (const t of this.timers) clearTimeout(t as any); this.timers = []; }
}
