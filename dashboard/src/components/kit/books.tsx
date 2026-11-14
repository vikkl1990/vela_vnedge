import type { ReactNode } from 'react'
import { BOOKS, BOOK_ORDER, SCOPES, type Book, type Ladder, type StepState } from '../../lib/books'
import { useBook } from '../../lib/bookScope'

/** A coloured dot for a book. Colour is never the only signal: pair it with the book's name. */
export function BookDot({ book }: { book: Book }) {
  return <span className={`book-dot book-dot-${book}`} aria-hidden />
}

/** The book's name as a chip. Shadow is dashed, backtest is hatched, so the books differ without colour. */
export function BookChip({ book, title }: { book: Book; title?: string }) {
  const b = BOOKS[book]
  return <span className={`book-chip book-chip-${book}`} title={title ?? b.what}>{b.short}</span>
}

/**
 * The dashboard-wide scope: which book every page is looking at. Live shows "off" until real money is armed, so a
 * glance at the top bar says whether anything can reach the exchange.
 */
export function BookSwitch({ liveState }: { liveState: string }) {
  const { scope, setScope } = useBook()
  return (
    <div className="book-switch" role="group" aria-label="Book">
      {SCOPES.map((s) => {
        const on = scope === s
        const label = s === 'all' ? 'All books' : BOOKS[s].label
        return (
          <button key={s} type="button" className={`book-seg ${on ? 'on' : ''} ${s === 'all' ? '' : `book-seg-${s}`}`} aria-pressed={on} onClick={() => setScope(s)} title={s === 'all' ? 'Every book, each number labelled' : BOOKS[s].what}>
            {s !== 'all' && <BookDot book={s} />}
            <span className="book-seg-label">{label}</span>
            {s === 'live' && <span className={`book-seg-state ${liveState === 'Armed' ? 'armed' : ''}`}>{liveState.toLowerCase()}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Adds a model score to every number that has one. Never changes a trade. */
export function MlLensToggle() {
  const { mlLens, toggleMlLens } = useBook()
  return (
    <button type="button" className={`ml-lens ${mlLens ? 'on' : ''}`} aria-pressed={mlLens} onClick={toggleMlLens} title="The ML lens adds a model score wherever a number has one. It never changes a trade.">
      ML<span className="ml-lens-long"> lens</span> <span className="ml-lens-state">{mlLens ? 'on' : 'off'}</span>
    </button>
  )
}

const STEP_WORD: Record<StepState, string> = { done: 'reached', now: 'here now', todo: 'not reached' }

/** Four pips, backtest to live: filled = reached, ringed = here now, dim = not reached. */
export function LadderPips({ ladder }: { ladder: Ladder }) {
  const label = BOOK_ORDER.map((b) => `${BOOKS[b].label} ${STEP_WORD[ladder.steps[b]]}`).join(', ')
  return (
    <span className="ladder-pips" role="img" aria-label={label}>
      {BOOK_ORDER.map((b) => <span key={b} className={`ladder-pip ladder-pip-${b} ${ladder.steps[b]}`} />)}
    </span>
  )
}

/** A labelled card for one book: coloured top edge, name, state pill, a headline, one line of context, a link. */
export function BookCard({ book, state, headline, sub, children, footer }: { book: Book; state: ReactNode; headline: ReactNode; sub?: ReactNode; children?: ReactNode; footer?: ReactNode }) {
  const b = BOOKS[book]
  return (
    <article className={`book-card book-card-${book}`} aria-label={`${b.label} book`}>
      <div className="book-card-head"><BookDot book={book} /><h2>{b.short}</h2><span className="book-card-state">{state}</span></div>
      <div className="book-card-headline mono">{headline}</div>
      {sub && <div className="book-card-sub">{sub}</div>}
      {children}
      {footer && <div className="book-card-foot">{footer}</div>}
    </article>
  )
}
