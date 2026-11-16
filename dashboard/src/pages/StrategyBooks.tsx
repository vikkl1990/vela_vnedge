import { Link } from 'react-router-dom'
import { useLibraryDetail, useMl, useMlScanner } from '../api/queries'
import type { LibraryDetail, Scanner } from '../api/types'
import { EmptyState, Loading } from '../components/kit'
import { BookChip } from '../components/kit/books'
import { fmtInt, fmtPct, fmtProfitFactor, fmtR, fmtPnlUsd as usd } from '../lib/format'
import { aucEvidence, mlState } from '../lib/mlPresentation'

import { BOOKS, BOOK_ORDER, ladderOf, nextStep, type Book, type StepState } from '../lib/books'

import '../styles/pages/strategy-books.css'

/**
 * One strategy across the four books: where it sits on the ladder, the same strategy's numbers in each book, the
 * execution contract the author wrote, and the model lens. Everything is read from the library detail, the scanner's own
 * stats and the per-scanner model; a book with no data shows a dash, never a made-up number.
 */
const NOT_YET = 'opens after the previous step'
const FILLED: Record<Book, string> = {
  backtest: 'Bar fills on history, costs charged.',
  shadow: 'Simulated fills on live market data, with fees. Fill source depends on execution policy.',
  paper: 'The simulated account on live prices.',
  live: 'Production orders and fills are verified separately on Exchange.',
}
/** The incubator's stage names in the ladder's words ("live" there means the paper account, not real money). */
const STAGE_WORD: Record<string, string> = {
  live: 'in the paper account',
  shadow: 'in shadow',
  proposed: 'proposed for promotion',
  tracked: 'tracked',
  candidate: 'candidate',
  retired: 'retired',
  demote_proposed: 'proposed for demotion',
}

const tone = (v: number | null | undefined) => (v == null || v === 0 ? '' : v > 0 ? 'gain' : 'loss')

interface BookNumbers {
  trades: number | null
  win: number | null
  avgR: number | null
  net: number | null
  sub?: string
}

export function StrategyBooks({
  id,
  s,
  onOpenReading,
}: {
  id: string
  s: Scanner
  onOpenReading: () => void
}) {
  const detail = useLibraryDetail(id)
  const d = detail.data
  if (detail.isLoading && !d) return <Loading rows={4} />
  if (!d)
    return (
      <EmptyState
        title="The library has no record of this script yet."
        hint="The books fill in once it has been screened or has traded."
      />
    )
  return <BooksBody d={d} s={s} onOpenReading={onOpenReading} id={id} />
}

function BooksBody({
  d,
  s,
  onOpenReading,
  id,
}: {
  d: LibraryDetail
  s: Scanner
  onOpenReading: () => void
  id: string
}) {
  const st = s.stats
  const warm = st?.backtest ?? null
  // backtest = the incubator's screen, summed over the pairs that were screened; the average is weighted by trades
  const screens = d.pairs.filter((p) => p.screen)
  const screenTrades = screens.reduce((a, p) => a + (p.screen!.trades ?? 0), 0)
  const rWeighted = screens.filter((p) => p.screen!.avgR != null && (p.screen!.trades ?? 0) > 0)
  const rTrades = rWeighted.reduce((a, p) => a + p.screen!.trades!, 0)
  const screenAvgR =
    rTrades > 0 ? rWeighted.reduce((a, p) => a + p.screen!.avgR! * p.screen!.trades!, 0) / rTrades : null
  const passed = screens.filter((p) => p.screen!.pass).length

  const paperN = d.paper?.n ?? 0
  const ladder = ladderOf({
    stages: d.stages,
    shadowTrades: d.shadow?.n,
    paperTrades: paperN,
    enabled: d.enabled,
    runs: d.status === 'runs',
  })
  const next = nextStep({
    stages: d.stages,
    shadowTrades: d.shadow?.n,
    paperTrades: paperN,
    enabled: d.enabled,
    runs: d.status === 'runs',
    quarantined: d.status === 'quarantined',
  })

  const nums: Record<Book, BookNumbers | null> = {
    backtest: screens.length
      ? {
          trades: screenTrades,
          win: null,
          avgR: screenAvgR,
          net: null,
          sub: `${passed} of ${screens.length} ${screens.length === 1 ? 'pair' : 'pairs'} passed the screen`,
        }
      : warm
        ? {
            trades: warm.trades,
            win: warm.winRatePct,
            avgR: null,
            net: null,
            sub: `Warm run, profit factor ${fmtProfitFactor(warm.profitFactor)}`,
          }
        : null,
    shadow: d.shadow
      ? {
          trades: d.shadow.n,
          win: d.shadow.win * 100,
          avgR: d.shadow.n ? d.shadow.r / d.shadow.n : null,
          net: null,
          sub: 'Last 30 days',
        }
      : null,
    paper: d.paper
      ? {
          trades: d.paper.n,
          win: st?.trades === paperN ? st.winRatePct : null,
          avgR: paperN ? d.paper.r / paperN : null,
          net: d.paper.net,
          sub: 'Recorded history with risk data',
        }
      : null,
    live: null,
  }

  // the step lines: one real sentence each
  const line: Record<Book, { big: string; sub: string; bigTone?: string }> = {
    backtest: screens.length
      ? {
          big: `${fmtInt(screenTrades)} trades`,
          sub: `${passed} of ${screens.length} ${screens.length === 1 ? 'pair' : 'pairs'} passed${screenAvgR != null ? ` · average ${fmtR(screenAvgR)}` : ''}`,
          bigTone: tone(screenAvgR),
        }
      : warm
        ? {
            big: `${fmtInt(warm.trades)} trades`,
            sub: `Warm run, ${fmtPct(warm.winRatePct)} won, profit factor ${fmtProfitFactor(warm.profitFactor)}`,
          }
        : { big: '–', sub: 'Not screened yet' },
    shadow: d.shadow
      ? {
          big: fmtR(d.shadow.r),
          sub: `${fmtInt(d.shadow.n)} ${d.shadow.n === 1 ? 'trade' : 'trades'} in 30 days · ${Math.round(d.shadow.win * 100)}% won`,
          bigTone: tone(d.shadow.r),
        }
      : {
          big: '–',
          sub:
            ladder.steps.backtest === 'todo'
              ? 'Opens after the backtest screen'
              : 'No shadow trades in the last 30 days',
        },
    paper: d.paper
      ? {
          big: usd(d.paper.net),
          sub: `${fmtInt(paperN)} recorded trades · average ${fmtR(d.paper.r / paperN)} · history, not current eligibility`,
          bigTone: tone(d.paper.net),
        }
      : { big: '–', sub: 'No paper history reported' },
    live: { big: 'Not reported', sub: 'Strategy-level production fills are not available in this view' },
  }
  const stateWord = (b: Book, x: StepState) =>
    x === 'done'
      ? 'Reached'
      : x === 'now'
        ? b === 'shadow'
          ? 'Collecting'
          : b === 'paper'
            ? 'Allocated'
            : 'Armed'
        : b === 'backtest'
          ? 'Not screened'
          : 'Not reported'

  const stageTally = (Object.entries(d.stages) as Array<[string, number]>)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${STAGE_WORD[k] ?? k}`)
    .join(' · ')

  return (
    <div className="sb-page">
      <section className="sb-card sb-ladder" aria-label="Where this strategy is on the ladder">
        <ol className="sb-steps">
          {BOOK_ORDER.map((b, i) => {
            const state = ladder.steps[b]
            return (
              <li key={b} className={`sb-step sb-step-${b} ${state}`}>
                <div className="sb-step-head">
                  <span className="sb-step-icon" aria-hidden>
                    {state === 'done' ? '✓' : i + 1}
                  </span>
                  <span className="sb-step-name">{BOOKS[b].short}</span>
                  <span className="sb-step-state">{stateWord(b, state)}</span>
                </div>
                <div className={`sb-step-big mono ${line[b].bigTone ?? ''}`}>{line[b].big}</div>
                <div className="sb-step-sub">{line[b].sub}</div>
              </li>
            )
          })}
        </ol>
        <div className="sb-next">
          <b>Next step:</b> {next}.{stageTally && <> Its pairs sit at: {stageTally}.</>}
        </div>
      </section>

      <section className="sb-card" aria-label="The same strategy in each book">
        <div className="sb-table-head sb-card-head">
          <h2>The same strategy in each book</h2>
        </div>
        <div className="table-wrap">
          <table className="table sb-table">
            <thead>
              <tr>
                <th scope="col">Book</th>
                <th scope="col" className="num">
                  Trades
                </th>
                <th scope="col" className="num">
                  Win
                </th>
                <th scope="col" className="num">
                  Avg R
                </th>
                <th scope="col" className="num">
                  Net
                </th>
                <th scope="col">How it is filled</th>
              </tr>
            </thead>
            <tbody>
              {BOOK_ORDER.map((b) => {
                const n = nums[b]
                const dash = <span className="muted">–</span>
                return (
                  <tr key={b}>
                    <td>
                      <BookChip book={b} />
                    </td>
                    <td className="num">
                      {n?.trades != null ? fmtInt(n.trades) : dash}
                      {!n && (
                        <span className="sb-dash-note">
                          {b === 'backtest'
                            ? 'not screened yet'
                            : ladder.steps[b] === 'todo'
                              ? NOT_YET
                              : b === 'shadow'
                                ? 'no trades in 30 days'
                                : 'no trades yet'}
                        </span>
                      )}
                    </td>
                    <td className="num">{n?.win != null ? fmtPct(n.win, 0) : dash}</td>
                    <td className={`num ${tone(n?.avgR)}`}>{n?.avgR != null ? fmtR(n.avgR) : dash}</td>
                    <td className={`num ${tone(n?.net)}`}>{n?.net != null ? usd(n.net) : dash}</td>
                    <td className="sb-fill">
                      {FILLED[b]}
                      {n?.sub && <span className="sb-dash-note">{n.sub}</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="sb-cols">
        <ContractCard d={d} onOpenReading={onOpenReading} />
        <MlLensCard id={id} />
      </div>
    </div>
  )
}

function hasWord(h: boolean | null | undefined) {
  return h === true ? 'written' : h === false ? 'none written' : 'unclear'
}

function ContractCard({ d, onOpenReading }: { d: LibraryDetail; onOpenReading: () => void }) {
  const r = d.authorReview
  const c = r?.contract
  const usable = c && (c.stop.how || c.targets.how || c.exit.how || c.entries.length > 0)
  if (!r || !c || !usable) {
    return (
      <section className="sb-card" aria-label="Execution contract">
        <div className="sb-table-head sb-card-head">
          <h2>Execution contract</h2>
        </div>
        <EmptyState
          title="No source review for this script"
          hint="Nobody has written down what its entries, stop and exits are meant to do, so the engine's reading cannot be set beside the author's."
          action={
            <button type="button" className="btn btn-sm" onClick={onOpenReading}>
              How it is read
            </button>
          }
        />
      </section>
    )
  }
  const entries = c.entries.length
    ? `${c.entries.length} ${c.entries.length === 1 ? 'entry output' : 'entry outputs'}: ${c.entries
        .slice(0, 3)
        .map((e) => `${e.marker || 'untitled'} (${e.side})`)
        .join(', ')}${c.entries.length > 3 ? ', …' : ''}`
    : 'The source study identifies no autonomous entry.'
  const parts: Array<{ name: string; how: string; note?: string }> = [
    { name: 'ENTRY', how: entries },
    { name: 'STOP', how: c.stop.how, note: hasWord(c.stop.has) },
    { name: 'TARGETS', how: c.targets.how, note: hasWord(c.targets.has) },
    { name: 'EXIT', how: c.exit.how, note: hasWord(c.exit.has) },
    {
      name: 'TIMING',
      how: c.timing.note,
      note: c.timing.repaints === true ? 'repaints' : c.timing.repaints === false ? 'no repaint' : undefined,
    },
  ].filter((p) => p.how)
  const source =
    r.sourceStatus === 'matches'
      ? { text: 'Source matches review', cls: 'ok' }
      : r.sourceStatus === 'changed'
        ? { text: 'Source changed', cls: 'warn' }
        : { text: 'Not reviewed', cls: '' }
  return (
    <section className="sb-card sb-card-pad sb-contract" aria-label="Execution contract">
      <div className="sb-card-head">
        <h2>Execution contract</h2>
        <span className={`sb-badge ${source.cls}`}>{source.text}</span>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        What the author wrote, and what the engine does with it.
      </p>
      <div>
        {parts.map((p) => (
          <div className="sb-part" key={p.name}>
            <span className="sb-part-name">{p.name}</span>
            <span className="sb-part-how">
              {p.how}
              {p.note && <span className="muted"> · {p.note}</span>}
            </span>
          </div>
        ))}
        <div className="sb-part">
          <span className="sb-part-name">ENGINE</span>
          <span className="sb-part-how">
            Exits {r.reading.exitMode}, entry protection {r.reading.entryProtection}, reader{' '}
            {r.reading.reader}.
          </span>
        </div>
      </div>
      <div>
        <button type="button" className="btn btn-sm" onClick={onOpenReading}>
          How it is read
        </button>
      </div>
    </section>
  )
}

function MlLensCard({ id }: { id: string }) {
  const ml = useMlScanner(id)
  const global = useMl()
  const m = ml.data?.model ?? null
  const state = mlState(global.isError ? undefined : global.data?.config)
  return (
    <section className="sb-card sb-card-pad sb-ml" aria-label="ML lens">
      <div className="sb-card-head">
        <h2>ML lens</h2>
        <span className="sb-badge">{state.label}</span>
      </div>
      <p className="small muted">
        Global configuration: {state.detail} The engine may use a timeframe or global fallback model; this
        card is the scanner-specific evaluation.
      </p>
      {ml.isLoading && !ml.data ? (
        <p className="muted small">Loading the model…</p>
      ) : ml.isError ? (
        <p className="muted small">The scanner model could not be read.</p>
      ) : !m ? (
        <div className="sb-advice">
          No scanner-specific model is reported. This does not establish that the scanner has no predictive
          value or that the engine has no fallback model.
        </div>
      ) : (
        <>
          <div className="sb-auc">
            <span className="sb-auc-n mono">{m.auc.toFixed(2)}</span>
            <span className="sb-auc-what">AUC on {fmtInt(m.holdout)} held-out trades.</span>
          </div>
          <div className="sb-advice">
            {aucEvidence(m.auc)} No AUC threshold on this page authorizes a gate or changes position size.
          </div>
        </>
      )}
      <Link className="link" to="/lab#ml">
        Open the ML workbench
      </Link>
    </section>
  )
}
