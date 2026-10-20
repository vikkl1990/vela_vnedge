import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useLibrary, useLibraryDetail, useLibraryFavorite } from '../api/queries'
import type { LibraryEntry, LibraryFamily, LibraryList } from '../api/types'
import { useAuth } from '../auth/AuthGate'
import { IconChart, IconExternal, IconX } from '../components/Icons'
import { Pill, QueryState } from '../components/ui'

/**
 * Decision 153: the Library. Every script the bot holds, browsed the way a chart platform's indicator library is
 * (families, new releases, search, a detail panel), but each card and panel carries what this bot has measured about
 * the script: whether it runs, where its pairs sit in the incubator, its last 30 days in the shadow book and its paper
 * record. The view and the selected script live in the address, so a link opens the same page.
 */
type View = 'discover' | 'all' | 'favorites' | 'inuse' | 'strategies' | 'failing' | `family:${string}`
type Sort = 'relevant' | 'newest' | 'name' | 'shadow'
const PAGE = 60

const inUse = (e: LibraryEntry) => Boolean(e.stages.live || e.stages.shadow || e.stages.proposed || e.stages.tracked || e.stages.demote_proposed)
const relevance = (e: LibraryEntry) => (e.stages.live ? 4 : 0) + (inUse(e) ? 2 : 0) + (e.shadow ? Math.max(-1, Math.min(2, e.shadow.r / 10)) : 0) + (e.status === 'runs' ? 1 : 0)
/** `n` items drawn from `pool` in an order fixed by `seed`, so "Shuffle" changes the draw and a re-render does not. */
function seededPick<T>(pool: T[], seed: number, n: number): T[] {
  const keyed = pool.map((item, i) => ({ item, k: Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453 }))
  return keyed.map((e) => ({ ...e, k: e.k - Math.floor(e.k) })).sort((a, b) => a.k - b.k).slice(0, n).map((e) => e.item)
}
const fmtR = (r: number) => `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(1)}R`
const fmtUsd = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`
const fmtDay = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null)

export function Library() {
  const q = useLibrary()
  return (
    <div className="page lib-page">
      <QueryState {...q} data={q.data} skeleton="cards" empty="The library is empty." onRetry={() => q.refetch()}>
        {(d) => <LibraryBody data={d} />}
      </QueryState>
    </div>
  )
}

function LibraryBody({ data }: { data: LibraryList }) {
  const [params, setParams] = useSearchParams()
  const view = (params.get('v') ?? 'discover') as View
  const selected = params.get('s')
  const [text, setText] = useState(params.get('q') ?? '')
  const [sort, setSort] = useState<Sort>('relevant')
  const [limit, setLimit] = useState(PAGE)
  const [seed, setSeed] = useState(1)
  const search = useRef<HTMLInputElement>(null)
  // on wide screens the library fills the window and its three columns scroll on their own, as a chart platform's
  // library does; the height is what is left below the app's header
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const fit = () => { const el = root.current; if (!el) return; const top = el.getBoundingClientRect().top + window.scrollY; el.style.setProperty('--lib-h', `${Math.max(520, window.innerHeight - top - 50)}px`) }
    fit(); window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit)
  }, [])
  const auth = useAuth()
  const fav = useLibraryFavorite()
  const favs = useMemo(() => new Set(data.favorites), [data.favorites])
  const canFav = auth.can('backtest')

  const set = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) if (v === null || v === '') p.delete(k); else p.set(k, v)
    setParams(p, { replace: true })
  }
  const go = (v: View) => { set({ v: v === 'discover' ? null : v }); setLimit(PAGE) }
  const toggleFav = (id: string) => canFav && fav.mutate({ id, on: !favs.has(id) })

  // "/" focuses the search, Escape closes the detail panel (or clears the search)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement
      if (e.key === '/' && !typing) { e.preventDefault(); search.current?.focus() }
      else if (e.key === 'Escape') { if (selected) set({ s: null }); else if (typing && text) setText('') }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  })
  useEffect(() => { const t = setTimeout(() => set({ q: text.trim() || null }), 250); return () => clearTimeout(t) }, [text]) // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => ({
    all: data.scripts.length,
    favorites: data.scripts.filter((e) => favs.has(e.id)).length,
    inuse: data.scripts.filter(inUse).length,
    strategies: data.scripts.filter((e) => e.scriptType === 'strategy').length,
    failing: data.scripts.filter((e) => e.status !== 'runs').length,
  }), [data.scripts, favs])

  const needle = text.trim().toLowerCase()
  const match = (e: LibraryEntry) => !needle || e.name.toLowerCase().includes(needle) || e.author.toLowerCase().includes(needle) || e.id.includes(needle) || (data.families.find((f) => f.key === e.family)?.label.toLowerCase().includes(needle) ?? false)
  const inView = (e: LibraryEntry) => {
    if (view === 'favorites') return favs.has(e.id)
    if (view === 'inuse') return inUse(e)
    if (view === 'strategies') return e.scriptType === 'strategy'
    if (view === 'failing') return e.status !== 'runs'
    if (view.startsWith('family:')) return e.family === view.slice(7)
    return true
  }
  const sorter = (a: LibraryEntry, b: LibraryEntry) =>
    sort === 'newest' ? (b.updated ?? '').localeCompare(a.updated ?? '') || a.name.localeCompare(b.name)
      : sort === 'name' ? a.name.localeCompare(b.name)
        : sort === 'shadow' ? (b.shadow?.r ?? -1e9) - (a.shadow?.r ?? -1e9)
          : relevance(b) - relevance(a) || (b.shadow?.n ?? 0) - (a.shadow?.n ?? 0) || a.name.localeCompare(b.name)
  const list = useMemo(() => data.scripts.filter((e) => inView(e) && match(e)).sort(sorter), [data.scripts, view, needle, sort, favs]) // eslint-disable-line react-hooks/exhaustive-deps

  const familyLabel = (k: string) => data.families.find((f) => f.key === k)?.label ?? k
  const title = view === 'discover' ? 'Discover' : view === 'all' ? 'All scripts' : view === 'favorites' ? 'Favorites' : view === 'inuse' ? 'In use' : view === 'strategies' ? 'Strategies' : view === 'failing' ? "Doesn't run" : familyLabel(view.slice(7))
  const showDiscover = view === 'discover' && !needle
  const newest = data.scripts.filter((e) => e.updated).sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '')).slice(0, 8)
  const earning = data.scripts.filter((e) => e.shadow && e.shadow.n >= 10).sort((a, b) => b.shadow!.r - a.shadow!.r).slice(0, 8)
  const trading = data.scripts.filter((e) => e.stages.live).sort((a, b) => (b.paper?.net ?? 0) - (a.paper?.net ?? 0)).slice(0, 8)
  const explore = useMemo(() => seededPick(data.scripts.filter((e) => e.status === 'runs' && !inUse(e)), seed, 9), [data.scripts, seed])

  const card = (e: LibraryEntry) => (
    <ScriptCard key={e.id} e={e} family={familyLabel(e.family)} on={selected === e.id} fav={favs.has(e.id)} canFav={canFav} onOpen={() => set({ s: e.id })} onFav={() => toggleFav(e.id)} />
  )

  return (
    <div ref={root} className={`lib ${selected ? 'lib-with-detail' : ''}`}>
      <nav className="lib-nav" aria-label="Library">
        <div className="lib-nav-group">
          <div className="lib-nav-head">Yours</div>
          <NavItem label="Favorites" n={counts.favorites} on={view === 'favorites'} onClick={() => go('favorites')} />
          <NavItem label="In use" n={counts.inuse} on={view === 'inuse'} onClick={() => go('inuse')} title="Scripts with a pair live, in the shadow book, proposed or on a tracker" />
        </div>
        <div className="lib-nav-group">
          <div className="lib-nav-head">Library</div>
          <NavItem label="Discover" on={view === 'discover'} onClick={() => go('discover')} />
          <NavItem label="All scripts" n={counts.all} on={view === 'all'} onClick={() => go('all')} />
          <NavItem label="Strategies" n={counts.strategies} on={view === 'strategies'} onClick={() => go('strategies')} />
          <NavItem label="Doesn't run" n={counts.failing} on={view === 'failing'} onClick={() => go('failing')} title="Scripts the engine cannot run, or has quarantined" />
        </div>
        <div className="lib-nav-group">
          <div className="lib-nav-head">Families</div>
          {data.families.filter((f) => f.count > 0).map((f: LibraryFamily) => (
            <NavItem key={f.key} label={f.label} n={f.count} on={view === `family:${f.key}`} onClick={() => go(`family:${f.key}`)} />
          ))}
        </div>
      </nav>

      <section className="lib-main" aria-label={title}>
        <div className="lib-search">
          <input ref={search} className="input lib-search-input" type="search" placeholder="Search scripts, authors or families" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search the library" />
          <span className="lib-kbd" aria-hidden>/</span>
          {!showDiscover && (
            <select className="select" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
              <option value="relevant">Relevant</option>
              <option value="newest">Newest</option>
              <option value="shadow">Shadow R, 30 days</option>
              <option value="name">Name</option>
            </select>
          )}
        </div>

        {showDiscover ? (
          <>
            <Shelf title="New releases" action={<button className="linkish" onClick={() => { go('all'); setSort('newest') }}>See all</button>}>{newest.map(card)}</Shelf>
            {earning.length > 0 && <Shelf title="Earning in the shadow book" sub="Last 30 days, ten trades or more">{earning.map(card)}</Shelf>}
            {trading.length > 0 && <Shelf title="Trading in paper" sub="Scripts with a live pair">{trading.map(card)}</Shelf>}
            <Shelf title="More to explore" sub="Runnable scripts with no pair in use" action={<button className="linkish" onClick={() => setSeed((s) => s + 1)}>Shuffle</button>}>{explore.map(card)}</Shelf>
          </>
        ) : (
          <>
            <div className="lib-head">
              <h2>{needle ? `“${text.trim()}”` : title}</h2>
              <span className="muted small">{list.length.toLocaleString()} script{list.length === 1 ? '' : 's'}{needle && view !== 'discover' ? ` in ${title}` : ''}</span>
            </div>
            {list.length === 0 ? (
              <p className="muted lib-empty">{view === 'favorites' && !needle ? (canFav ? 'No favorites yet. Star a script to keep it here.' : 'Favorites need an account that can run backtests.') : 'No script matches.'}</p>
            ) : (
              <div className="lib-grid">{list.slice(0, limit).map(card)}</div>
            )}
            {list.length > limit && <div className="lib-more"><button className="btn" onClick={() => setLimit((l) => l + PAGE)}>Show {Math.min(PAGE, list.length - limit)} more</button></div>}
          </>
        )}
      </section>

      {selected && <Detail id={selected} family={familyLabel} fav={favs.has(selected)} canFav={canFav} onFav={() => toggleFav(selected)} onClose={() => set({ s: null })} />}
    </div>
  )
}

function NavItem({ label, n, on, onClick, title }: { label: string; n?: number; on: boolean; onClick: () => void; title?: string }) {
  return (
    <button className={`lib-nav-item ${on ? 'on' : ''}`} onClick={onClick} aria-current={on ? 'page' : undefined} title={title}>
      <span>{label}</span>{n !== undefined && <span className="lib-nav-n">{n.toLocaleString()}</span>}
    </button>
  )
}

function Shelf({ title, sub, action, children }: { title: string; sub?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="lib-shelf">
      <div className="lib-head"><h2>{title}</h2>{sub && <span className="muted small">{sub}</span>}<span className="grow" />{action}</div>
      <div className="lib-grid">{children}</div>
    </div>
  )
}

/** The card's picture: the script's cumulative R over its last 30 shadow days, or a quiet placeholder. */
function Spark({ points, big }: { points: number[] | undefined; big?: boolean }) {
  const h = big ? 70 : 54
  if (!points || points.length < 2) return <div className={`lib-spark lib-spark-empty ${big ? 'big' : ''}`}><span>No shadow trades, 30 days</span></div>
  const min = Math.min(0, ...points), max = Math.max(0, ...points), span = max - min || 1
  const x = (i: number) => (i / (points.length - 1)) * 100
  const y = (v: number) => 4 + (1 - (v - min) / span) * (h - 8)
  const line = points.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ')
  const up = points[points.length - 1] >= 0
  return (
    <svg className={`lib-spark ${up ? 'up' : 'down'} ${big ? 'big' : ''}`} viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" role="img" aria-label={`Cumulative shadow result ${points[points.length - 1].toFixed(1)}R`}>
      <line x1="0" x2="100" y1={y(0)} y2={y(0)} className="zero" />
      <polygon points={`0,${y(0)} ${line} 100,${y(0)}`} className="area" />
      <polyline points={line} className="ln" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Star({ on, disabled, onClick }: { on: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button className={`lib-star ${on ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); onClick() }} disabled={disabled} aria-pressed={on} aria-label={on ? 'Remove from favorites' : 'Add to favorites'} title={disabled ? 'Favorites need an account that can run backtests' : on ? 'Remove from favorites' : 'Add to favorites'}>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9 6.8 19.6l1-5.8L3.5 9.7l5.9-.9z" /></svg>
    </button>
  )
}

function StageChips({ e }: { e: LibraryEntry }) {
  const s = e.stages
  return (
    <span className="lib-chips">
      {e.status === 'fails' && <Pill tone="danger" title={e.error ?? undefined}>doesn't run</Pill>}
      {e.status === 'quarantined' && <Pill tone="warn" title={e.error ?? undefined}>quarantined</Pill>}
      {s.live ? <Pill tone="ok">{s.live} live</Pill> : null}
      {s.shadow ? <Pill tone="accent">{s.shadow} shadow</Pill> : null}
      {s.proposed ? <Pill tone="warn">{s.proposed} proposed</Pill> : null}
      {s.tracked ? <Pill tone="muted">{s.tracked} tracked</Pill> : null}
      {e.scriptType === 'strategy' && <Pill tone="muted">strategy</Pill>}
    </span>
  )
}

function ScriptCard({ e, family, on, fav, canFav, onOpen, onFav }: { e: LibraryEntry; family: string; on: boolean; fav: boolean; canFav: boolean; onOpen: () => void; onFav: () => void }) {
  return (
    <article className={`lib-card ${on ? 'on' : ''}`}>
      <button className="lib-card-hit" onClick={onOpen} aria-label={`Open ${e.name}`} />
      <div className="lib-card-pic"><Spark points={e.shadow?.spark} /><Star on={fav} disabled={!canFav} onClick={onFav} /></div>
      <div className="lib-card-body">
        <div className="lib-card-title">{e.name}</div>
        <div className="lib-card-meta">{family} · {e.author}{e.updated ? ` · ${fmtDay(e.updated)}` : ''}</div>
        <div className="lib-card-foot">
          <StageChips e={e} />
          {e.shadow && <span className={`mono small ${e.shadow.r >= 0 ? 'gain' : 'loss'}`} title={`${e.shadow.n} shadow trades in 30 days, ${Math.round(e.shadow.win * 100)}% won`}>{fmtR(e.shadow.r)}</span>}
        </div>
      </div>
    </article>
  )
}

function Detail({ id, family, fav, canFav, onFav, onClose }: { id: string; family: (k: string) => string; fav: boolean; canFav: boolean; onFav: () => void; onClose: () => void }) {
  const q = useLibraryDetail(id)
  const nav = useNavigate()
  return (
    <aside className="lib-detail" aria-label="Script detail">
      <button className="lib-detail-close btn btn-xs" onClick={onClose} aria-label="Close"><IconX /></button>
      <QueryState {...q} data={q.data} empty="Unknown script." onRetry={() => q.refetch()}>
        {(d) => {
          const stages = d.pairs.reduce<Record<string, number>>((a, p) => ((a[p.stage] = (a[p.stage] ?? 0) + 1), a), {})
          return (
            <div className="lib-detail-body">
              <Spark points={d.shadow?.spark} big />
              <div className="lib-detail-meta">{family(d.family)}{d.updated ? ` · ${fmtDay(d.updated)}` : ''}</div>
              <h2 className="lib-detail-title">{d.name}</h2>
              <div className="muted small">
                {d.author} · {d.scriptType ?? 'script'} · Pine v{d.pineVersion ?? '?'}{d.lines ? ` · ${d.lines.toLocaleString()} lines` : ''}{d.overlay ? ' · on the price pane' : ' · own pane'}
              </div>
              <StageChips e={d} />
              {d.status !== 'runs' && <p className="lib-error small">{d.status === 'quarantined' ? 'Quarantined: ' : "Doesn't run: "}{d.health?.reason ?? d.health?.lastError ?? d.reason ?? 'no reason recorded'}</p>}

              <div className="lib-actions">
                <button className="btn btn-primary" disabled={d.status === 'fails'} onClick={() => nav(`/chart?add=${encodeURIComponent(d.id)}`)} title={d.status === 'fails' ? "The engine can't run this script" : 'Run it on the chart, on the market and timeframe the chart shows'}><IconChart /> Add to chart</button>
                <button className={`btn ${fav ? 'btn-on' : ''}`} disabled={!canFav} onClick={onFav} aria-pressed={fav}>{fav ? 'Favorited' : 'Favorite'}</button>
                <Link className="btn" to={`/scanners/${encodeURIComponent(d.id)}`}>Scanner page</Link>
                {d.url && <a className="btn" href={d.url} target="_blank" rel="noreferrer">{d.origin === 'luxalgo' ? 'LuxAlgo Library' : d.origin === 'tradingview' ? 'TradingView' : 'Source'} <IconExternal /></a>}
              </div>

              <div className="lib-facts">
                <Fact k="Shadow, 30 days" v={d.shadow ? fmtR(d.shadow.r) : '–'} tone={d.shadow ? (d.shadow.r >= 0 ? 'gain' : 'loss') : ''} sub={d.shadow ? `${d.shadow.n} trades · ${Math.round(d.shadow.win * 100)}% won` : 'no trades'} />
                <Fact k="Paper, all time" v={d.paper ? fmtUsd(d.paper.net) : '–'} tone={d.paper ? (d.paper.net >= 0 ? 'gain' : 'loss') : ''} sub={d.paper ? `${d.paper.n} trades · ${fmtR(d.paper.r)}` : 'never traded'} />
                <Fact k="Pairs" v={String(d.pairs.length)} sub={Object.entries(stages).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(' · ') || 'none'} />
              </div>

              {d.pairs.length > 0 && (
                <div className="lib-sub">
                  <h3>Pairs</h3>
                  <div className="scroll-x">
                    <table className="lib-table">
                      <colgroup><col className="c-mkt" /><col className="c-stage" /><col className="c-screen" /><col className="c-30" /></colgroup>
                      <thead><tr><th>Market</th><th>Stage</th><th>Screen</th><th className="num">30d</th></tr></thead>
                      <tbody>
                        {d.pairs.slice(0, 40).map((p) => (
                          <tr key={`${p.symbol}-${p.tf}`}>
                            <td className="mono">{p.symbol.replace(/USD$/, '')} <span className="muted">{p.tf}</span></td>
                            <td>{p.stage.replace('_', ' ')}</td>
                            <td className="small lib-screen">{p.screen ? <span className={p.screen.expired ? 'muted' : p.screen.pass ? 'gain' : 'loss'} title={p.screen.expired ? 'Screened on the previous engine; waits for a fresh screen' : undefined}>{p.screen.expired ? 'expired' : p.screen.pass ? 'pass' : 'fail'}{p.screen.trades != null ? ` · ${p.screen.trades}` : ''}{p.screen.avgR != null ? ` · ${p.screen.avgR >= 0 ? '+' : ''}${p.screen.avgR.toFixed(2)}R` : ''}</span> : '–'}</td>
                            <td className={`num small ${p.shadow30 ? (p.shadow30.r >= 0 ? 'gain' : 'loss') : 'muted'}`}>{p.shadow30 ? `${p.shadow30.n} · ${fmtR(p.shadow30.r)}` : '–'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {d.pairs.length > 40 && <p className="muted small">and {d.pairs.length - 40} more on the scanner page</p>}
                </div>
              )}

              {d.recent.length > 0 && (
                <div className="lib-sub">
                  <h3>Recent trades</h3>
                  <ul className="lib-trades">
                    {d.recent.map((t, i) => (
                      <li key={i}>
                        <span className="muted small">{t.book}</span>
                        <span className="mono small">{t.symbol.replace(/USD$/, '')} {t.tf}</span>
                        <span className={`small side-${t.side}`}>{t.side}</span>
                        <span className="muted small">{t.exitReason}</span>
                        <span className={`mono small ${t.r >= 0 ? 'gain' : 'loss'}`}>{fmtR(t.r)}{t.net != null ? ` · ${fmtUsd(t.net)}` : ''}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {d.license && <p className="muted small">Licence: {d.license}</p>}
            </div>
          )
        }}
      </QueryState>
    </aside>
  )
}

function Fact({ k, v, sub, tone = '' }: { k: string; v: string; sub: string; tone?: string }) {
  return (
    <div className="lib-fact"><div className="muted small">{k}</div><div className={`mono lib-fact-v ${tone}`}>{v}</div><div className="muted small">{sub}</div></div>
  )
}
