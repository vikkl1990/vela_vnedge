/**
 * The four books and the ladder between them. Pure data and functions, so the rules are tested and every page uses
 * the same words: a backtest is history, shadow is live prices without money, paper is the simulated account, live is
 * real money. A strategy climbs backtest -> shadow -> paper -> live and never skips a step.
 */
export type Book = 'live' | 'paper' | 'shadow' | 'backtest'
export type BookScope = Book | 'all'
export type StepState = 'done' | 'now' | 'todo'

export const BOOK_ORDER: Book[] = ['backtest', 'shadow', 'paper', 'live']
export const SCOPES: BookScope[] = ['all', 'live', 'paper', 'shadow', 'backtest']

export const BOOKS: Record<Book, { label: string; short: string; what: string; color: string }> = {
  live: { label: 'Live', short: 'LIVE', what: 'Real money on the exchange', color: 'var(--book-live)' },
  paper: { label: 'Paper', short: 'PAPER', what: 'The simulated account on live prices', color: 'var(--book-paper)' },
  shadow: { label: 'Shadow', short: 'SHADOW', what: 'Research trades on live prices, never money', color: 'var(--book-shadow)' },
  backtest: { label: 'Backtest', short: 'BACKTEST', what: 'Replay on history', color: 'var(--book-backtest)' },
}

export function parseScope(v: string | null | undefined): BookScope {
  return (SCOPES as string[]).includes(v ?? '') ? (v as BookScope) : 'all'
}

/** Is a row that belongs to `books` visible under `scope`? "all" shows everything. */
export function inScope(scope: BookScope, books: Book[]): boolean {
  return scope === 'all' || books.includes(scope)
}

/** The incubator's stage names, as the Library reports them. */
export type Stage = 'live' | 'shadow' | 'proposed' | 'tracked' | 'candidate' | 'retired' | 'demote_proposed'

export interface LadderInput {
  /** pairs per incubator stage for this strategy */
  stages: Partial<Record<Stage, number>>
  /** closed shadow trades in the window, when known */
  shadowTrades?: number | null
  /** paper-account trades, when known */
  paperTrades?: number | null
  /** Verified production trades for THIS strategy, never inferred from global mode. */
  liveTrades?: number | null
}

export interface Ladder {
  steps: Record<Book, StepState>
  /** the highest book it has reached, or null when it has not been screened */
  reached: Book | null
}

const n = (x: number | undefined | null) => (typeof x === 'number' && x > 0 ? x : 0)

/**
 * Where a strategy sits. Screened and passed = backtest done. In the shadow book (or proposed for promotion) = shadow
 * now; in the account = shadow done and paper now. Live is never "now" until it is armed.
 */
export function ladderOf(i: LadderInput): Ladder {
  const s = i.stages
  const screened = n(s.candidate) + n(s.shadow) + n(s.proposed) + n(s.live) + n(s.demote_proposed) + n(s.tracked) > 0
  const inAccount = n(s.live) + n(s.demote_proposed) > 0 || n(i.paperTrades) > 0
  const inShadow = n(s.shadow) + n(s.proposed) > 0 || n(i.shadowTrades) > 0
  const steps: Record<Book, StepState> = {
    backtest: screened || inAccount || inShadow ? 'done' : 'todo',
    shadow: inAccount ? 'done' : inShadow ? 'now' : 'todo',
    paper: inAccount ? 'now' : 'todo',
    live: n(i.liveTrades) > 0 ? 'now' : 'todo',
  }
  const reached = steps.live === 'now' ? 'live' : steps.paper === 'now' ? 'paper' : steps.shadow !== 'todo' ? 'shadow' : steps.backtest === 'done' ? 'backtest' : null
  return { steps, reached }
}

/** A short, plain next step for the Strategies list. */
export function nextStep(i: LadderInput & { runs?: boolean; quarantined?: boolean }): string {
  if (i.quarantined) return 'Quarantined: fix or retire'
  if (i.runs === false) return 'Does not run'
  const s = i.stages
  if (n(s.proposed) + n(s.demote_proposed) > 0) return 'A decision is waiting'
  if (n(s.live) > 0) return 'Trading in paper; live opens after the go-live checks'
  if (n(s.shadow) > 0) return 'Collecting shadow evidence'
  if (n(s.candidate) > 0) return 'Passed the screen, waiting for a shadow slot'
  if (n(s.retired) > 0) return 'Retired from research'
  return 'Not screened yet'
}

/** The money books that exist in the trade journal today. */
export function journalBookFor(scope: BookScope): 'paper' | 'shadow' | null {
  return scope === 'paper' ? 'paper' : scope === 'shadow' ? 'shadow' : null
}
