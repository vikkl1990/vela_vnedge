/**
 * The account at a glance, built for the trading overview page: what the account has done in a window, how entry
 * signals were decided (the funnel), each enabled scanner's live record beside its cached backtest, and the policy
 * that decides entries. Everything is read from state the engine already keeps, so the page cannot disagree with it.
 */
import type { Db } from '../db.ts';
import type { AppConfig } from '../config.ts';
import type { Position } from '../paper/logic.ts';
import { rMultiple } from '../paper/logic.ts';
import type { BacktestResult } from '../paper/backtest.ts';

export type FunnelStage = 'opened' | 'cost' | 'trend' | 'burst' | 'cooldown' | 'caps' | 'regime' | 'risk' | 'ignored' | 'other';

export const STAGE_LABELS: Record<FunnelStage, string> = {
  opened: 'Opened', cost: 'Cost rule', trend: 'Against the trend', burst: 'Burst limit', cooldown: 'Re-entry cooldown',
  caps: 'Position caps', regime: 'Regime', risk: 'Other risk limit', ignored: 'Already positioned', other: 'Other',
};

/** Which rule decided an entry signal, from the `action` the engine recorded. */
export function classifyAction(action: string | null | undefined): FunnelStage {
  const a = String(action ?? '');
  if (a === 'opened' || a === 'filled' || a.startsWith('pending')) return 'opened';
  if (/stop too tight for fees/.test(a)) return 'cost';
  if (/against the trend/.test(a)) return 'trend';
  if (/risk burst/.test(a)) return 'burst';
  if (/cooldown/.test(a)) return 'cooldown';
  if (/max \d+ positions|budget|positions? cap|max positions/.test(a)) return 'caps';
  if (/regime/.test(a)) return 'regime';
  if (a.startsWith('rejected:risk')) return 'risk';
  if (a.startsWith('ignored')) return 'ignored';
  return 'other';
}

type Rec = { trades: number; wins: number; pnl: number; fees: number; grossProfit: number; grossLoss: number; avgR: number | null; profitFactor: number | null };
function record(closed: Position[]): Rec {
  let wins = 0, gp = 0, gl = 0, fees = 0, rSum = 0, rN = 0;
  for (const p of closed) {
    const net = p.realizedPnl - p.fees; fees += p.fees;
    if (net > 0) { wins++; gp += net; } else gl -= net;
    const r = rMultiple(p); if (r !== null) { rSum += r; rN++; }
  }
  return { trades: closed.length, wins, pnl: gp - gl, fees, grossProfit: gp, grossLoss: gl, avgR: rN ? rSum / rN : null,
    profitFactor: gl > 0 ? gp / gl : null };   // null: no losing trade yet (or no trades)
}

export interface OverviewDeps {
  db: Db;
  cfg: AppConfig;
  closed: Position[];
  open: Position[];
  stats: { equity: number; initialEquity: number; closedPnl: number; openPnl: number; peakEquity: number; drawdownPct: number; maxDrawdownPct: number };
  pairsFor: (id: string) => Array<{ symbol: string; tf: string }>;
  backtest: (id: string, symbol: string, tf: string) => BacktestResult | undefined;
  scannerName: (id: string) => string;
}

export function tradingOverview(d: OverviewDeps, opts: { since?: number; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  const since = opts.since ?? now - 7 * 86_400_000;
  const days = Math.max((now - since) / 86_400_000, 1 / 24);
  const inWindow = d.closed.filter(p => (p.exitAt ?? 0) >= since && (p.exitAt ?? 0) <= now);
  const opened = d.db.get<{ n: number }>("SELECT count(*) n FROM positions WHERE bt=0 AND status IN ('open','closed') AND qty>0 AND entry_at>=? AND entry_at<=?", since, now)?.n ?? 0;

  // the funnel: every entry signal in the window, by the rule that decided it
  const rows = d.db.all<{ scanner_id: string; action: string | null; n: number }>(
    "SELECT scanner_id, action, count(*) n FROM signals WHERE kind='entry' AND at>=? AND at<=? GROUP BY scanner_id, action", since, now);
  const stages = new Map<FunnelStage, { n: number; example: string | null }>();
  const firedBy = new Map<string, number>(), openedBy = new Map<string, number>();
  let fired = 0;
  for (const r of rows) {
    const st = classifyAction(r.action);
    const s = stages.get(st) ?? { n: 0, example: null };
    s.n += r.n; if (!s.example && st !== 'opened') s.example = r.action; stages.set(st, s);
    fired += r.n;
    firedBy.set(r.scanner_id, (firedBy.get(r.scanner_id) ?? 0) + r.n);
    if (st === 'opened') openedBy.set(r.scanner_id, (openedBy.get(r.scanner_id) ?? 0) + r.n);
  }
  const funnel = {
    fired,
    stages: [...stages].map(([stage, v]) => ({ stage, label: STAGE_LABELS[stage], n: v.n, example: v.example })).sort((a, b) => b.n - a.n),
  };

  // each enabled scanner: live record in the window beside its cached backtest on the same cells
  const scanners = Object.entries(d.cfg.scanners).filter(([, s]) => s.enabled && !s.hidden).map(([id]) => {
    const pairs = d.pairsFor(id);
    const live = record(inWindow.filter(p => p.scannerId === id));
    let bt = { trades: 0, pnl: 0, gp: 0, gl: 0, rSum: 0, spanDays: 0, cells: 0 };
    for (const { symbol, tf } of pairs) {
      const b = d.backtest(id, symbol, tf); if (!b) continue;
      bt.cells++; bt.trades += b.stats.trades; bt.pnl += b.stats.pnl; bt.gp += b.stats.grossProfit; bt.gl += b.stats.grossLoss;
      bt.rSum += (b.stats.avgR ?? 0) * b.stats.trades; bt.spanDays = Math.max(bt.spanDays, (b.to - b.from) / 86_400_000);
    }
    return {
      id, name: d.scannerName(id), markets: new Set(pairs.map(p => p.symbol)).size, timeframes: [...new Set(pairs.map(p => p.tf))],
      fired: firedBy.get(id) ?? 0, opened: openedBy.get(id) ?? 0, open: d.open.filter(p => p.scannerId === id).length,
      live: { ...live, perDay: live.trades / days },
      backtest: bt.cells ? { cells: bt.cells, trades: bt.trades, pnl: bt.pnl, profitFactor: bt.gl > 0 ? bt.gp / bt.gl : null,
        avgR: bt.trades ? bt.rSum / bt.trades : null, perDay: bt.spanDays > 0 ? bt.trades / bt.spanDays : null, spanDays: bt.spanDays } : null,
    };
  }).sort((a, b) => b.live.pnl - a.live.pnl);

  const p = d.cfg.paper, r = d.cfg.risk;
  const tfs = [...new Set(scanners.flatMap(s => s.timeframes))];
  const markets = new Set(Object.values(d.cfg.scanners).filter(s => s.enabled && !s.hidden).flatMap(s => s.symbols ?? []));
  return {
    at: now, since, days,
    account: { ...d.stats, mode: d.cfg.execution.mode, openPositions: d.open.length },
    window: { ...record(inWindow), opened, perDay: inWindow.length / days },
    funnel,
    scanners,
    policy: {
      costRatio: p.minRiskFeeRatio ?? 0,
      trendGate: p.trendGate?.enabled ? { emaLen: p.trendGate.emaLen, mode: p.trendGate.mode, tf: p.trendGate.tf || null, tfs: p.trendGate.tfs?.length ? p.trendGate.tfs : null } : null,
      allowReversal: p.allowReversal, sizing: p.sizingMode, riskPerTradePct: p.riskPerTradePct, maxStopLossPct: p.maxStopLossPct ?? 0,
      breakEvenAfterTp1: p.breakEvenAfterTp1, tpSplit: p.tpSplit, fallbackAtrSl: p.fallbackAtrSl,
      timeframes: tfs, markets: markets.size, scanners: scanners.length,
      risk: { maxPositionsTotal: r.maxPositionsTotal, maxPositionsPerSymbol: r.maxPositionsPerSymbol, perScannerMaxPositions: r.perScannerMaxPositions,
        reentryCooldownMinutes: r.reentryCooldownMinutes, burstWindowSec: r.burstWindowSec, maxDailyLossPct: r.maxDailyLossPct, maxWeeklyLossPct: r.maxWeeklyLossPct,
        noWeekend: !!r.regime?.noWeekend, minAtrPct: r.regime?.enabled ? r.regime.minAtrPct : 0 },
    },
  };
}
export type TradingOverview = ReturnType<typeof tradingOverview>;
