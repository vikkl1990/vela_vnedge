/**
 * The four books and the ladder between them. Pure data and functions, so the rules are tested and every page uses
 * the same words: a backtest is history, shadow is live prices without money, paper is the simulated account, live is
 * real money. Book participation is a display summary, not proof of current eligibility.
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
  /** Account scanner availability, when reported. */
  enabled?: boolean
  runs?: boolean
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
 * Incubator stages identify allocations, while trades establish recorded participation.
 * Current allocation and scanner availability determine "now". Tracking alone does not prove a passed screen.
 */
export function ladderOf(i: LadderInput): Ladder {
  const s = i.stages
  const screened = n(s.candidate) + n(s.shadow) + n(s.proposed) + n(s.live) + n(s.demote_proposed) > 0
  const allocated = n(s.live) + n(s.demote_proposed) > 0
  const inShadow = n(s.shadow) + n(s.proposed) > 0
  const available = i.runs !== false
  const steps: Record<Book, StepState> = {
    backtest: screened ? 'done' : 'todo',
    shadow: inShadow && available ? 'now' : inShadow || n(i.shadowTrades) > 0 ? 'done' : 'todo',
    paper: allocated && i.enabled !== false && available ? 'now' : allocated || n(i.paperTrades) > 0 ? 'done' : 'todo',
    live: n(i.liveTrades) > 0 ? 'done' : 'todo',
  }
  const reached = [...BOOK_ORDER].reverse().find(book => steps[book] !== 'todo') ?? null
  return { steps, reached }
}

/** A short, plain next step for the Strategies list. */
export function nextStep(i: LadderInput & { runs?: boolean; quarantined?: boolean }): string {
  if (i.quarantined) return 'Quarantined: fix or retire'
  if (i.runs === false) return 'Does not run'
  const s = i.stages
  if (n(s.proposed) + n(s.demote_proposed) > 0) return 'A decision is waiting'
  if (n(s.live) > 0) return i.enabled === false ? 'Paper allocation exists; account scanner disabled' : 'Allocated to paper; entries still require admission'
  if (n(s.shadow) > 0) return 'Collecting shadow evidence'
  if (n(s.candidate) > 0) return 'Candidate; needs current screening and a shadow slot'
  if (n(s.retired) > 0) return 'Retired from research'
  if (n(i.paperTrades) > 0) return 'Paper history; account allocation not reported here'
  if (n(i.shadowTrades) > 0) return 'Shadow history; no current shadow allocation'
  if (n(s.tracked) > 0) return 'Tracked; no passed screen recorded'
  return 'No screening evidence recorded'
}

/** The money books that exist in the trade journal today. */
export function journalBookFor(scope: BookScope): 'paper' | 'shadow' | null {
  return scope === 'paper' ? 'paper' : scope === 'shadow' ? 'shadow' : null
}
