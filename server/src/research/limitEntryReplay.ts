/**
 * Research only: a resting limit entry against a market entry on the same signal (decision 332).
 *
 * The account places 1h and 4h entries as resting limits. A signal whose limit never fills leaves no trade, so a fill
 * that was never made cannot show in the journal, and nothing says whether the orders that did not fill were the
 * strong breakouts. This replays every such signal both ways on 1m candles through the engine that trades them:
 *
 *   limit   the order the account would rest: `passiveMakerPrice`, filled by the first minute that traded THROUGH it
 *           after the latency window and before it expires, as a maker, with the stop already charged in the fill minute
 *   market  the entry the account would have made at the first minute after the latency window, as a taker
 *
 * Both arms take the same ATR stop, the same fee and risk checks, the same sizing and the same exit engine (`applyBar`).
 * Minute candles are sampled prices, not ticks or queue position: a limit the candle only touched may not have filled, and
 * the order of a minute's high and low is unknown. The result is a diagnostic of the policy, not evidence for changing
 * it, and nothing here is promotion-eligible.
 */
import type { PaperConfig } from '../config.ts';
import type { MarketInfo } from '../paper/engine.ts';
import { passiveMakerPrice } from '../paper/makerPricing.ts';
import { applyBar, checkRiskVsFees, openPosition, resolveLevels, restingEntryStop, sizeContracts, type Position } from '../paper/logic.ts';
import { TF_SECONDS } from '../config.ts';

export interface Bar1m { time: number; open: number; high: number; low: number; close: number; volume?: number }
export type Side = 'long' | 'short';

export interface LimitCase {
  key: string;
  book: 0 | 2;
  scannerId: string;
  symbol: string;
  tf: string;
  side: Side;
  /** When the signal reached the engine (ms). */
  signalAt: number;
  /** The signal's own price, the reference the engine prices a limit from. */
  reference: number;
  /** ATR(14) of the signal timeframe at the signal bar. */
  atr: number;
  /** The resting price the engine recorded when it placed the order (its trace says "resting limit at X"). Used as is when given: it already carries the quote passivity the replay cannot see. */
  limitPrice?: number | null;
  /** What the account actually did, when the order filled. Used only to check the replay against reality. */
  actual?: { entryAt: number; entryPrice: number; netR: number | null } | null;
}

export interface ReplayEnv {
  /** Paper settings with the product's own fee rates applied. */
  cfg: PaperConfig;
  market: MarketInfo;
  equity: number;
  /** How long after entry a trade may run before it is called censored. */
  horizonMs: number;
  /** ATRs below (long) or above (short) the reference. */
  atrOffset: number;
  /** Bars the order rests. */
  bars: number;
}

export type ArmStatus = 'closed' | 'unfilled' | 'rejected' | 'censored' | 'unverified';
export interface ArmResult {
  status: ArmStatus;
  reason?: string;
  entryAt?: number;
  entryPrice?: number;
  netR?: number;
  exitReason?: string | null;
  exitAt?: number | null;
  fees?: number;
}
export interface CaseResult {
  case: LimitCase;
  limit: ArmResult;
  market: ArmResult;
}

const MINUTE = 60_000;
const finite = (...v: number[]) => v.every((x) => Number.isFinite(x));

function validBars(bars: Bar1m[]): string | null {
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (!finite(b.time, b.open, b.high, b.low, b.close) || b.time % MINUTE || b.low <= 0 || b.high < Math.max(b.open, b.close, b.low) || b.low > Math.min(b.open, b.close)) return 'invalid minute bar';
    if (i > 0 && b.time <= bars[i - 1].time) return 'unordered minute bars';
  }
  return null;
}

/** Open a position, charge the stop the fill minute already crossed (limit only), then walk the later minutes through the exit engine. */
function run(c: LimitCase, env: ReplayEnv, bars: Bar1m[], from: number, entry: number, at: number, maker: boolean, fillBar: Bar1m | null): ArmResult {
  const { cfg, market } = env;
  const levels = resolveLevels({ side: c.side, price: entry, atr: c.atr }, cfg, market.tickSize);
  if ('error' in levels) return { status: 'rejected', reason: levels.error };
  const cost = checkRiskVsFees(entry, levels.sl, cfg, c.symbol, 0, { maker });
  if (cost) return { status: 'rejected', reason: cost };
  const size = sizeContracts(entry, levels.sl, { cfg, equity: env.equity, availableMargin: env.equity, contractValue: market.contractValue, tickSize: market.tickSize, maintenanceMarginPct: market.maintenanceMarginPct, maxLeverage: market.maxLeverage, sizeScale: 1 });
  if (!size.qty) return { status: 'rejected', reason: size.reason ?? 'size' };
  const pos: Position = openPosition({ id: 1, scannerId: c.scannerId, scannerName: c.scannerId, symbol: c.symbol, tf: c.tf, side: c.side, qty: size.qty, contractValue: market.contractValue, entryPrice: entry, at, sl: levels.sl, tp: levels.tp, riskAmount: size.riskAmount, levelsSource: levels.source, leverage: size.leverage, marginLeverage: size.marginLeverage, maintenanceMarginPct: market.maintenanceMarginPct, cfg, bt: true, signalId: null, maker });
  if (fillBar) restingEntryStop(pos, fillBar, cfg, at);
  for (let i = from; i < bars.length && pos.status === 'open'; i++) {
    const b = bars[i];
    if (b.time > at + env.horizonMs) break;
    applyBar(pos, { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }, cfg, c.atr);
  }
  if (pos.status !== 'closed') return { status: 'censored', reason: 'position still open at the horizon or the end of the candles', entryAt: at, entryPrice: pos.entryPrice };
  return { status: 'closed', entryAt: at, entryPrice: pos.entryPrice, netR: (pos.realizedPnl - pos.fees) / pos.riskAmount, exitReason: pos.exitReason ?? null, exitAt: pos.exitAt ?? null, fees: pos.fees };
}

/** One signal, both ways. `bars` are ascending 1m candles covering the signal through the horizon. */
export function replayLimitCase(c: LimitCase, bars: Bar1m[], env: ReplayEnv): CaseResult {
  const bad = validBars(bars);
  const unverified = (reason: string): ArmResult => ({ status: 'unverified', reason });
  if (bad || !finite(c.signalAt, c.reference, c.atr, env.market.tickSize, env.market.contractValue, env.equity) || !(c.atr > 0) || !(c.reference > 0) || !(env.market.tickSize > 0)) {
    const r = unverified(bad ?? 'missing price, ATR or market specification');
    return { case: c, limit: r, market: r };
  }
  const tfMs = (TF_SECONDS[c.tf] ?? 0) * 1000;
  if (!(tfMs > 0)) { const r = unverified('unknown timeframe'); return { case: c, limit: r, market: r }; }
  const dueAt = c.signalAt + Math.max(0, env.cfg.latencyMs ?? 0);
  const firstMinute = Math.ceil(dueAt / MINUTE) * MINUTE;
  const i0 = bars.findIndex((b) => b.time >= firstMinute);
  const through = (env.cfg.limitFill ?? 'through') === 'through';

  // market: the first minute at or after the latency window, at its open
  let market: ArmResult;
  if (i0 < 0 || bars[i0].time - firstMinute > 5 * MINUTE) market = unverified('no minute within five minutes of the latency window');
  else market = run(c, env, bars, i0 + 1, bars[i0].open, bars[i0].time, false, null);

  // limit: rests until it expires; a minute that began at or after the window and traded through it fills it
  const price = c.limitPrice && c.limitPrice > 0 ? c.limitPrice : passiveMakerPrice(c.side, c.reference, env.atrOffset, c.atr, env.market.tickSize);
  const expiresAt = c.signalAt + env.bars * tfMs;
  let limit: ArmResult;
  if (!(price > 0)) limit = { status: 'rejected', reason: 'invalid maker price' };
  else if (i0 < 0) limit = unverified('no minute after the latency window');
  else {
    let hit = -1;
    for (let i = i0; i < bars.length && bars[i].time < expiresAt; i++) {
      const b = bars[i];
      if (c.side === 'long' ? (through ? b.low < price : b.low <= price) : (through ? b.high > price : b.high >= price)) { hit = i; break; }
    }
    if (hit < 0) limit = bars[bars.length - 1].time + MINUTE < expiresAt ? unverified('candles end before the order expires') : { status: 'unfilled', reason: `price did not trade through ${price} in ${env.bars} ${c.tf} bars` };
    else limit = run(c, env, bars, hit + 1, price, bars[hit].time + MINUTE, true, bars[hit]);
  }
  return { case: c, limit, market };
}

// ---------- summary ----------

const dayOf = (t: number) => Math.floor(t / 86_400_000);
export interface Estimate { n: number; mean: number | null; se: number | null }
/** Mean with a standard error clustered by day: signals on one day share the market they traded in. Null with fewer than two days. */
export function clusteredMean(xs: Array<{ x: number; at: number }>): Estimate {
  const n = xs.length;
  if (!n) return { n: 0, mean: null, se: null };
  const mean = xs.reduce((s, r) => s + r.x, 0) / n;
  const byDay = new Map<number, number>();
  for (const r of xs) byDay.set(dayOf(r.at), (byDay.get(dayOf(r.at)) ?? 0) + r.x - mean);
  if (byDay.size < 2) return { n, mean, se: null };
  let ss = 0; for (const v of byDay.values()) ss += v * v;
  return { n, mean, se: Math.sqrt(ss) / n };
}
const diff = (a: Estimate, b: Estimate) => ({ mean: a.mean !== null && b.mean !== null ? a.mean - b.mean : null, se: a.se !== null && b.se !== null ? Math.sqrt(a.se ** 2 + b.se ** 2) : null });
const resolved = (s: ArmStatus) => s === 'closed' || s === 'unfilled' || s === 'rejected';
const rOf = (a: ArmResult) => (a.status === 'closed' ? a.netR! : 0);

export type Verdict = 'limit costs R' | 'limit adds R' | 'no difference detected' | 'no verdict';
const verdictOf = (d: { mean: number | null; se: number | null }): Verdict => {
  if (d.mean === null || d.se === null) return 'no verdict';
  if (d.mean + 1.96 * d.se < 0) return 'limit costs R';
  if (d.mean - 1.96 * d.se > 0) return 'limit adds R';
  return 'no difference detected';
};

export interface Group { signals: number; filled: number; fillRatePct: number | null; limitR: Estimate; marketR: Estimate; difference: { mean: number | null; se: number | null }; verdict: Verdict;
  marketRWhenFilled: Estimate; marketRWhenUnfilled: Estimate; missedMinusTaken: { mean: number | null; se: number | null } }

/**
 * Pre-registered reading (docs/research/limit-entry-replay-2026-11-23/README.md): a signal counts when both arms resolved. A signal whose limit
 * never filled contributes 0 R to the limit arm, as it did in the account; a signal an arm refused on cost contributes 0 to that arm.
 * "difference" is limit minus market per signal. "missedMinusTaken" is the market arm's mean R on signals the limit never filled,
 * minus its mean R on signals it did fill: positive means the orders that did not fill were the better trades.
 */
export function summarize(results: CaseResult[]): { counts: Record<string, number>; all: Group; byTf: Record<string, Group>; bySide: Record<string, Group>; byBook: Record<string, Group> } {
  const counts: Record<string, number> = { total: results.length };
  for (const r of results) {
    const k = `limit:${r.limit.status}`, m = `market:${r.market.status}`;
    counts[k] = (counts[k] ?? 0) + 1; counts[m] = (counts[m] ?? 0) + 1;
  }
  const used = results.filter((r) => resolved(r.limit.status) && resolved(r.market.status));
  counts.used = used.length;
  const group = (list: CaseResult[]): Group => {
    const limitR = clusteredMean(list.map((r) => ({ x: rOf(r.limit), at: r.case.signalAt })));
    const marketR = clusteredMean(list.map((r) => ({ x: rOf(r.market), at: r.case.signalAt })));
    const d = clusteredMean(list.map((r) => ({ x: rOf(r.limit) - rOf(r.market), at: r.case.signalAt })));
    const filled = list.filter((r) => r.limit.status === 'closed'), unfilled = list.filter((r) => r.limit.status === 'unfilled');
    const mf = clusteredMean(filled.map((r) => ({ x: rOf(r.market), at: r.case.signalAt }))), mu = clusteredMean(unfilled.map((r) => ({ x: rOf(r.market), at: r.case.signalAt })));
    const dd = { mean: d.mean, se: d.se };
    return { signals: list.length, filled: filled.length, fillRatePct: list.length ? Math.round((1000 * filled.length) / list.length) / 10 : null, limitR, marketR, difference: dd, verdict: verdictOf(dd),
      marketRWhenFilled: mf, marketRWhenUnfilled: mu, missedMinusTaken: diff(mu, mf) };
  };
  const by = (key: (r: CaseResult) => string) => Object.fromEntries([...new Set(used.map(key))].sort().map((k) => [k, group(used.filter((r) => key(r) === k))]));
  return { counts, all: group(used), byTf: by((r) => r.case.tf), bySide: by((r) => r.case.side), byBook: by((r) => (r.case.book === 0 ? 'account' : 'shadow')) };
}

/** Does the replay reproduce the orders the account actually filled? Only signals with a recorded fill. */
export function calibration(results: CaseResult[], tickSize: (symbol: string) => number) {
  const rows = results.filter((r) => r.case.actual && r.limit.status === 'closed');
  const missed = results.filter((r) => r.case.actual && r.limit.status !== 'closed').length;
  const sameFill = rows.filter((r) => Math.abs(r.limit.entryAt! - r.case.actual!.entryAt) <= 2 * MINUTE && Math.abs(r.limit.entryPrice! - r.case.actual!.entryPrice) <= tickSize(r.case.symbol) * 1.01).length;
  const pairs = rows.filter((r) => r.case.actual!.netR !== null).map((r) => ({ a: r.case.actual!.netR!, b: r.limit.netR! }));
  const n = pairs.length;
  const ma = pairs.reduce((s, p) => s + p.a, 0) / (n || 1), mb = pairs.reduce((s, p) => s + p.b, 0) / (n || 1);
  const cov = pairs.reduce((s, p) => s + (p.a - ma) * (p.b - mb), 0), va = pairs.reduce((s, p) => s + (p.a - ma) ** 2, 0), vb = pairs.reduce((s, p) => s + (p.b - mb) ** 2, 0);
  return { recordedFills: rows.length + missed, replayAlsoFilled: rows.length, replayDidNotFill: missed, sameFillTimeAndPricePct: rows.length ? Math.round((1000 * sameFill) / rows.length) / 10 : null,
    actualMeanR: n ? ma : null, replayMeanR: n ? mb : null, correlation: n > 2 && va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null, pairs: n };
}
