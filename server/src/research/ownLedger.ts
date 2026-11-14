/**
 * Own-ledger evaluation (decision 266): grade a `strategy()` script by the trades its own ledger records, exactly as the
 * author wrote the entries and exits, then charge Delta's costs and stress the result. Nothing here knows the bot's
 * recipe (ATR stop, trail, floor, cap): the question it answers is whether the script's own entry and exit make money.
 *
 * Pure functions over bars and ledger trades, so the same grading runs in the CLI, the tests and any later service.
 * Returns are measured per trade in basis points of notional, not per unit of risk: a script with a wide or no stop has
 * no stable R, so sizing for it is a separate decision (see `README` of the 2026-11-14 script-perspective study).
 */

/** Taker fee 0.05% with the 18% tax, plus 2 bps of slippage, charged on both sides: bps per round trip. */
export const OWN_LEDGER_COST_BPS = 2 * (0.05 * 1.18 * 100 + 2);

/** [time ms, open, high, low, close] */
export type OwnBar = [number, number, number, number, number];
export interface OwnTrade { size: number; entryPrice: number; exitPrice: number | null; entryIdx: number; exitIdx: number | null }
export interface OwnCell {
  symbol: string;
  tf: string;
  bars: OwnBar[];
  trades: OwnTrade[];
  /** `process_orders_on_close`: orders fill at the signal bar's close, so the next open is no delay. */
  fillsOnClose?: boolean;
}

export interface OwnLedgerSummary {
  trades: number;
  open: number;
  /** Average net bps a trade over closed trades only. */
  closedNet: number;
  /** Same with open trades marked to market at the last close: grid and DCA scripts hide their losers in open trades. */
  net: number;
  /** Every entry and exit one full bar late. */
  delayedNet: number;
  /** Gross bps beyond what the market's own drift gave the same side over the same holding time. */
  beyondDrift: number;
  firstHalf: number;
  secondHalf: number;
  long: number;
  short: number;
  longTrades: number;
  shortTrades: number;
  t: number;
  cells: number;
  cellsUp: number;
  /** Adverse move from entry before the trade ended, in bps: median, 95th percentile, worst. */
  adverseMedian: number;
  adverse95: number;
  adverseMax: number;
  /** Share of trades whose adverse move passed 3%: how often a 3% stop cap would have cut a trade the script held. */
  over3Pct: number;
  /** Entries priced outside their own bar's range, which a real fill could not have had. */
  badFills: number;
  /** Sum of open trades' losses at mark, bps. */
  openLoss: number;
}

const avg = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
export function tStat(a: number[]): number {
  if (a.length < 3) return NaN;
  const m = avg(a), sd = Math.sqrt(avg(a.map(x => (x - m) ** 2)));
  return sd > 0 ? m / (sd / Math.sqrt(a.length)) : NaN;
}

/** Grade one script over every cell it ran on. Cells without trades, or with no bars, add nothing. */
export function summariseOwnLedger(cells: OwnCell[], cost = OWN_LEDGER_COST_BPS): OwnLedgerSummary {
  const closed: number[] = [], open: number[] = [], delayed: number[] = [], beyond: number[] = [], mae: number[] = [];
  const halves: [number[], number[]] = [[], []], side = { long: [] as number[], short: [] as number[] };
  const per = new Map<string, number[]>();
  let bad = 0;
  for (const c of cells) {
    const b = c.bars;
    if (b.length < 3) continue;
    const last = b.length - 1, mid = b[0][0] + (b[last][0] - b[0][0]) / 2;
    const driftPerBar = Math.log(b[last][4] / b[0][1]) / last, lag = c.fillsOnClose ? 2 : 1;
    for (const t of c.trades) {
      const isOpen = t.exitPrice === null, ei = t.entryIdx, xi = isOpen ? last : t.exitIdx!, xp = isOpen ? b[last][4] : t.exitPrice!;
      if (!b[ei] || !b[xi] || !(t.entryPrice > 0) || !(xp > 0)) continue;
      const dir = Math.sign(t.size), gross = (xp - t.entryPrice) / t.entryPrice * dir * 1e4, net = gross - cost;
      (isOpen ? open : closed).push(net);
      // one bar late on both ends; an open trade leaves at the last close
      const e2 = b[ei + lag]?.[1], x2 = isOpen ? b[last][4] : (b[xi + lag]?.[1] ?? b[last][4]);
      if (e2) delayed.push((x2 - e2) / e2 * dir * 1e4 - cost);
      beyond.push(gross - (Math.exp(driftPerBar * (xi - ei)) - 1) * dir * 1e4);
      let worst = 0;
      for (let i = ei; i <= xi; i++) { const adv = dir > 0 ? (b[i][3] - t.entryPrice) / t.entryPrice : (t.entryPrice - b[i][2]) / t.entryPrice; worst = Math.min(worst, adv * 1e4); }
      mae.push(-worst);
      if (t.entryPrice > b[ei][2] * 1.0005 || t.entryPrice < b[ei][3] * 0.9995) bad++;
      halves[b[ei][0] < mid ? 0 : 1].push(net);
      side[dir > 0 ? 'long' : 'short'].push(net);
      const k = `${c.symbol} ${c.tf}`; (per.get(k) ?? per.set(k, []).get(k)!).push(net);
    }
  }
  const all = [...closed, ...open], sorted = [...mae].sort((a, b) => a - b), q = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : NaN;
  return {
    trades: closed.length, open: open.length, closedNet: avg(closed), net: avg(all), delayedNet: avg(delayed), beyondDrift: avg(beyond),
    firstHalf: avg(halves[0]), secondHalf: avg(halves[1]), long: avg(side.long), short: avg(side.short), longTrades: side.long.length, shortTrades: side.short.length,
    t: tStat(all), cells: per.size, cellsUp: [...per.values()].filter(v => avg(v) > 0).length,
    adverseMedian: q(0.5), adverse95: q(0.95), adverseMax: sorted.at(-1) ?? NaN,
    over3Pct: mae.length ? mae.filter(x => x > 300).length / mae.length : NaN, badFills: bad,
    openLoss: open.reduce((a, x) => a + (x < 0 ? x : 0), 0),
  };
}

export type OwnLedgerGate = 'open-trades' | 'delay' | 'halves' | 'drift' | 'significance' | 'sample' | 'fills' | 'sides';
export interface OwnLedgerVerdict { pass: boolean; failed: OwnLedgerGate[]; }
/**
 * The stress ladder of the 14 Nov 2026 study, each gate on top of the last: positive with open trades marked, positive with
 * a one-bar delay, positive in both halves, positive beyond the market's drift, t above 2. `sample` demands enough trades for
 * those to mean anything; `fills` fails a script whose entries sit outside their own bar; `sides` demands a positive long AND a
 * positive short record (a script that only ever went one way may only have ridden the market).
 */
export function gradeOwnLedger(s: OwnLedgerSummary, minTrades = 100): OwnLedgerVerdict {
  const failed: OwnLedgerGate[] = [];
  if (!(s.trades + s.open >= minTrades)) failed.push('sample');
  if (!(s.net > 0)) failed.push('open-trades');
  if (!(s.delayedNet > 0)) failed.push('delay');
  if (!(s.firstHalf > 0 && s.secondHalf > 0)) failed.push('halves');
  if (!(s.beyondDrift > 0)) failed.push('drift');
  if (!(s.t > 2)) failed.push('significance');
  if (s.badFills > 0) failed.push('fills');
  if (!(s.longTrades > 0 && s.shortTrades > 0 && s.long > 0 && s.short > 0)) failed.push('sides');
  return { pass: failed.length === 0, failed };
}
