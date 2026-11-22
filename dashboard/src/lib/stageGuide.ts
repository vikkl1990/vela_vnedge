import type { IncubatorView } from '../api/types'

export interface StageEntry {
  id: string
  label: string
  /** What the stage is, in one sentence. */
  what: string
  /** How a pair gets in and out, with the numbers the settings currently hold. */
  how: string
}

const n = (v: number | undefined, fallback = '–') =>
  typeof v === 'number' && Number.isFinite(v) ? String(v) : fallback

/** The gate in a line, from the live settings (decision 329). Per-timeframe minimums are named, not listed. */
export function gateLine(g: IncubatorView['config']['gate']): string {
  const byTf = g.minTradesByTf || g.minDaysByTf ? ' Some timeframes have their own minimums.' : ''
  return `At least ${n(g.minTrades)} trades over ${n(g.minDays)} days, profit factor ${n(g.minPfR)} or better, average R of ${n(g.minAvgR)} or more, and ${n(g.minPositiveWeeksPct)}% of weeks positive; no more than ${n(g.maxOverlapPct)}% of entries may duplicate a live pair.${byTf}`
}

/** One entry per stage, in the order a pair travels, plus `tracked`, which sits outside the path. */
export function stageGuide(c: IncubatorView['config']): StageEntry[] {
  const auto = c.promote.auto === true
  const review = c.promote.reviewMinutes
  return [
    {
      id: 'candidate',
      label: 'Candidate',
      what: 'A scanner on a market and timeframe that has passed the nightly screen on history and is waiting for a shadow slot.',
      how: `The screen needs ${n(c.screen.minTrades)} trades, profit factor ${n(c.screen.minProfitFactor)} or better, and a gain in ${n(c.screen.minWindowsUp)} of ${n(c.screen.slices)} history slices, with ${n(c.screen.stressBps)} bps of extra cost added.`,
    },
    {
      id: 'shadow',
      label: 'Shadow',
      what: 'Trades on live data with no account money. This is where evidence is collected. The account takes a shadow pair’s signals only when copying is on and the pair has a record.',
      how: `Judged by the gate. ${gateLine(c.gate)}`,
    },
    {
      id: 'proposed',
      label: 'Proposed',
      what: 'A shadow pair that has met the gate and is up for promotion.',
      how: auto
        ? `Auto-promotion is on, so it moves to the account by itself${typeof review === 'number' ? ` at the next review (every ${review} minutes)` : ''}. A proposal sits here only when a check holds it.`
        : 'Auto-promotion is off, so it waits here until you approve or reject it on the Decisions page.',
    },
    {
      id: 'live',
      label: 'Live (on the own list)',
      what: 'Allocated to the paper account, which trades it at full size.',
      how: 'Reached by promotion, or directly when you allocate a pair yourself on the Scanners page.',
    },
    {
      id: 'demote_proposed',
      label: 'Demotion proposed',
      what: 'A live pair that is failing its checks. It stays allocated until the demotion is resolved.',
      how: `Flagged when its last ${n(c.demote.window)} trades (at least ${n(c.demote.minTrades)}) have a profit factor below ${n(c.demote.maxPfR)}, when it has been silent too long, when its market leaves the exchange, or when its entries keep being refused on cost.`,
    },
    {
      id: 'retired',
      label: 'Retired',
      what: 'Dropped. It frees its slot for the next candidate.',
      how: `Failed the gate on a full sample, did not prove itself within ${n(c.gate.maxDays)} days, went stale in shadow, or was removed from the account.`,
    },
    {
      id: 'tracked',
      label: 'Tracked',
      what: 'Watched, not judged. It trades in shadow so you can look at it.',
      how: 'The gate never promotes, retires or ages it, and the account never copies it. Releasing it from its last tracker returns it to candidate.',
    },
  ]
}
