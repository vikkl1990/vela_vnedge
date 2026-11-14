import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLibrary } from '../api/queries'
import type { LibraryEntry, LibraryList } from '../api/types'
import { BookDot, LadderPips } from '../components/kit/books'
import { Callout, EmptyState, TabPanel, Tabs, Toolbar } from '../components/kit'
import { PageTitle, QueryState } from '../components/ui'
import { BOOKS, BOOK_ORDER, ladderOf, nextStep, type Book, type BookScope, type Ladder } from '../lib/books'
import { useBook } from '../lib/bookScope'
import { fmtInt, fmtR } from '../lib/format'
import '../styles/pages/strategies.css'

/**
 * Strategies: one list for every script the bot holds, with how far each has climbed the four books. Everything here is
 * read from the library list (stages, shadow and paper records); nothing is computed that the list does not carry.
 */
type TabId = 'climbing' | 'candidates' | 'library' | 'quarantined' | 'fails'
type RunsAs = 'any' | 'strategy' | 'indicator'
const PAGE = 50
const RANK: Record<Book, number> = { backtest: 1, shadow: 2, paper: 3, live: 4 }

interface Row {
  e: LibraryEntry
  ladder: Ladder
  rank: number
  next: string
}

export function Strategies() {
  const q = useLibrary()
  return (
    <div className="page st-page">
      <PageTitle sub="One list for every script. Book participation shows current allocations and historical trades separately. It does not certify current promotion eligibility; Incubator reports that evidence." />
      <QueryState {...q} data={q.data} skeleton="table" skeletonRows={8} skeletonCols={8} empty="The library is empty." onRetry={() => q.refetch()}>
        {(d) => <StrategiesBody data={d} />}
      </QueryState>
    </div>
  )
}

/** Is a row visible under the dashboard-wide book scope? */
function inBook(scope: BookScope, r: Row): boolean {
  const { e, ladder } = r
  switch (scope) {
    case 'all': return true
    case 'shadow': return Boolean(e.shadow) || Boolean(e.stages.shadow) || Boolean(e.stages.proposed)
    case 'paper': return ladder.steps.paper !== 'todo'
    case 'backtest': return ladder.steps.backtest !== 'todo'
    case 'live': return ladder.steps.live === 'now'
  }
}

function StrategiesBody({ data }: { data: LibraryList }) {
  const { scope, mlLens } = useBook()
  const [tab, setTab] = useState<TabId>('climbing')
  const [text, setText] = useState('')
  const [family, setFamily] = useState('')
  const [runsAs, setRunsAs] = useState<RunsAs>('any')
  // how many rows are shown; it starts over whenever the tab, a filter or the book scope changes
  const sig = `${tab}|${family}|${runsAs}|${text.trim().toLowerCase()}|${scope}`
  const [lim, setLim] = useState({ sig, n: PAGE })
  const limit = lim.sig === sig ? lim.n : PAGE
  const setLimit = (n: number) => setLim({ sig, n })

  const rows = useMemo<Row[]>(
    () =>
      data.scripts.map((e) => {
        const ladder = ladderOf({ stages: e.stages, shadowTrades: e.shadow?.n, paperTrades: e.paper?.n, enabled: e.enabled, runs: e.status === 'runs' })
        const rank = ladder.reached ? RANK[ladder.reached] : 0
        return { e, ladder, rank, next: nextStep({ stages: e.stages, shadowTrades: e.shadow?.n, paperTrades: e.paper?.n, enabled: e.enabled, runs: e.status === 'runs', quarantined: e.status === 'quarantined' }) }
      }),
    [data.scripts],
  )

  const totals = useMemo(() => {
    const t: Record<Book, number> = { backtest: 0, shadow: 0, paper: 0, live: 0 }
    for (const r of rows) for (const b of BOOK_ORDER) if (r.ladder.steps[b] !== 'todo') t[b]++
    return t
  }, [rows])
  const noShadowCell = useMemo(() => rows.filter((r) => r.ladder.steps.backtest !== 'todo' && r.ladder.steps.shadow === 'todo').length, [rows])

  const scoped = useMemo(() => rows.filter((r) => inBook(scope, r)), [rows, scope])
  const climbing = (r: Row) => r.ladder.steps.shadow !== 'todo' || r.ladder.steps.paper !== 'todo'
  const tabOf: Record<TabId, (r: Row) => boolean> = {
    climbing: climbing,
    candidates: (r) => Boolean(r.e.stages.candidate) && r.ladder.steps.shadow === 'todo',
    library: () => true,
    quarantined: (r) => r.e.status === 'quarantined',
    fails: (r) => r.e.status === 'fails',
  }
  const counts = useMemo(() => {
    const c: Record<TabId, number> = { climbing: 0, candidates: 0, library: scoped.length, quarantined: 0, fails: 0 }
    for (const r of scoped) {
      if (climbing(r)) c.climbing++
      if (r.e.stages.candidate && r.ladder.steps.shadow === 'todo') c.candidates++
      if (r.e.status === 'quarantined') c.quarantined++
      if (r.e.status === 'fails') c.fails++
    }
    return c
  }, [scoped])

  const needle = text.trim().toLowerCase()
  const list = useMemo(() => {
    const pass = tabOf[tab]
    return scoped
      .filter((r) => pass(r))
      .filter((r) => !family || r.e.family === family)
      .filter((r) => runsAs === 'any' || r.e.scriptType === runsAs)
      .filter((r) => !needle || r.e.name.toLowerCase().includes(needle) || r.e.author.toLowerCase().includes(needle) || r.e.id.toLowerCase().includes(needle))
      // evidence first: furthest up the ladder, then the most shadow trades, then name
      .sort((a, b) => b.rank - a.rank || (b.e.shadow?.n ?? 0) - (a.e.shadow?.n ?? 0) || a.e.name.localeCompare(b.e.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, tab, family, runsAs, needle])

  const tabItems = [
    { id: 'climbing' as const, label: 'Book records', count: fmtInt(counts.climbing) },
    { id: 'candidates' as const, label: 'Candidates', count: fmtInt(counts.candidates) },
    { id: 'library' as const, label: 'Library', count: fmtInt(counts.library) },
    { id: 'quarantined' as const, label: 'Quarantined', count: fmtInt(counts.quarantined) },
    { id: 'fails' as const, label: 'Does not run', count: fmtInt(counts.fails) },
  ]
  const shown = list.slice(0, limit)

  return (
    <>
      <ul className="st-totals" aria-label="Ladder totals">
        {BOOK_ORDER.map((b) => (
          <li key={b} className={`st-total st-total-${b}`}>
            <BookDot book={b} />
            <span className="st-total-label">{BOOKS[b].short}</span>
            <span className="st-total-n mono">{b === 'live' ? '–' : fmtInt(totals[b])}</span>
            <span className="st-total-what">{b === 'backtest' ? 'screened' : b === 'shadow' ? 'reached' : b === 'paper' ? 'reached' : 'not reported'}</span>
          </li>
        ))}
      </ul>

      {scope === 'live' ? (
        <div className="st-card">
          <EmptyState
            title="Live strategy evidence is not available here"
            hint="The library reports account and shadow history. A production connection does not prove that an individual strategy traded live; use Exchange for verified orders and fills."
            action={<Link className="btn" to="/live">Open Live control</Link>}
          />
        </div>
      ) : (
        <>
          <Tabs value={tab} onChange={setTab} items={tabItems} label="Strategy lists" idPrefix="st" />
          <Toolbar end={<span className="st-note">Sorted by book reached, then shadow sample size</span>}>
            <label className="st-find">Find <input type="search" className="input" placeholder="Name, author or id" value={text} onChange={(e) => setText(e.target.value)} aria-label="Find a strategy" /></label>
            <label className="st-field">Family
              <select className="select" value={family} onChange={(e) => setFamily(e.target.value)}>
                <option value="">any</option>
                {data.families.map((f) => <option key={f.key} value={f.key}>{f.label} ({f.count})</option>)}
              </select>
            </label>
            <label className="st-field">Runs as
              <select className="select" value={runsAs} onChange={(e) => setRunsAs(e.target.value as RunsAs)}>
                <option value="any">any</option>
                <option value="strategy">strategies</option>
                <option value="indicator">signal tools</option>
              </select>
            </label>
          </Toolbar>

          <TabPanel id={tab} value={tab} idPrefix="st">
              <section className="st-card" aria-label="Strategies">
                {list.length === 0 ? (
                  <EmptyState title="Nothing here" hint={scope === 'all' ? 'No script matches this tab and these filters.' : `No script matches this tab and these filters in the ${BOOKS[scope].label} book.`} />
                ) : (
                  <>
                    <div className="table-wrap">
                      <table className="table st-table">
                        <caption className="sr-only">Strategies, sorted by evidence</caption>
                        <thead>
                          <tr>
                            <th scope="col">Strategy</th>
                            <th scope="col">Runs as</th>
                            <th scope="col">Ladder</th>
                            <th scope="col" className="num st-th-shadow">Shadow</th>
                            <th scope="col" className="num st-th-paper">Paper</th>
                            {mlLens && <th scope="col" className="num st-th-ml">ML</th>}
                            <th scope="col">Next step</th>
                          </tr>
                        </thead>
                        <tbody>
                          {shown.map((r) => <StrategyRow key={r.e.id} r={r} mlLens={mlLens} />)}
                        </tbody>
                      </table>
                    </div>
                    <div className="st-more">
                      <span>Showing {fmtInt(shown.length)} of {fmtInt(list.length)}</span>
                      {shown.length < list.length && (
                        <>
                          <button type="button" className="btn btn-sm" onClick={() => setLimit(limit + PAGE)}>Show more</button>
                          <button type="button" className="btn btn-sm" onClick={() => setLimit(list.length)}>Show all</button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </section>
          </TabPanel>
        </>
      )}

      {noShadowCell > 0 && (
        <Callout tone="info" title={`${fmtInt(noShadowCell)} screened ${noShadowCell === 1 ? 'script has' : 'scripts have'} no shadow cell yet.`} actions={<Link className="btn btn-sm" to="/library">Browse the library</Link>}>
          They passed or were have screening or allocation records, but no shadow participation is reported in this view. Incubator shows current admission reasons.
        </Callout>
      )}
    </>
  )
}

const tone = (v: number) => (v > 0 ? 'gain' : v < 0 ? 'loss' : 'muted')

function StrategyRow({ r, mlLens }: { r: Row; mlLens: boolean }) {
  const { e } = r
  const sh = e.shadow, pa = e.paper
  const link = e.status === 'runs' ? `/scanners/${e.id}` : `/library?s=${encodeURIComponent(e.id)}`
  const nextTone = e.status === 'quarantined' ? 'warn' : e.status === 'fails' ? 'loss' : ''
  return (
    <tr>
      <td>
        <Link to={link} className="st-name">{e.name}</Link>
        <div className="st-author">{e.author}</div>
      </td>
      <td>
        {e.scriptType === 'strategy' ? <span className="st-chip strategy">Strategy script</span>
          : e.scriptType === 'indicator' ? <span className="st-chip indicator" title="An indicator: its signals are read by the bot, it has no strategy ledger">Signal tool</span>
          : <span className="st-chip" title="The script's type has not been read">Not read</span>}
      </td>
      <td><LadderPips ladder={r.ladder} /></td>
      <td className="num">
        {sh ? (
          <>
            <span className={sh.r === 0 ? '' : tone(sh.r)} title="Sum of R over the last 30 days of shadow trades">{fmtR(sh.r)}</span>
            <span className="st-cell-sub">{fmtInt(sh.n)} {sh.n === 1 ? 'trade' : 'trades'} · {Math.round(sh.win * 100)}% won</span>
          </>
        ) : <span className="muted">–</span>}
      </td>
      <td className="num">
        {pa ? (
          <>
            <span className={pa.r === 0 ? '' : tone(pa.r)} title="Sum of R over all closed paper trades">{fmtR(pa.r)}</span>
            <span className="st-cell-sub">{fmtInt(pa.n)} {pa.n === 1 ? 'trade' : 'trades'}</span>
          </>
        ) : <span className="muted">–</span>}
      </td>
      {mlLens && <td className="st-ml" title="The list carries no per-strategy model score. The strategy's own page shows its model.">not reported</td>}
      <td className={`st-next ${nextTone}`}>{r.next}</td>
    </tr>
  )
}
