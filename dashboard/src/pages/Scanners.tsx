import { ambiguousScannerNames } from '../lib/scannerNames'
import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import {
  qk,
  useConfig,
  useMarkets,
  useReleaseScanner,
  useRunScanner,
  useScannerPipeline,
  useScanners,
  useUpdateScanner,
} from '../api/queries'
import type { ExitMode, Scanner } from '../api/types'
import { DataTable, type Column } from '../components/DataTable'
import { IconExternal, IconPlay } from '../components/Icons'
import {
  Callout,
  ChipSelect,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Loading,
  Pill,
  Pnl,
  RouteHeader,
  ScannerStatusPill,
  Stat,
  StatGrid,
  TabPanel,
  Tabs,
  Time,
  ToggleGroup,
  Toolbar,
} from '../components/kit'
import { RowMenu, type MenuItem } from '../components/RowMenu'
import { ScannerContributions } from '../components/ScannerContributions'
import { ScannerReadinessMatrix } from '../components/ScannerReadinessMatrix'
import { BookCells, ScannerCard, ShareBar } from '../components/scanners/ScannerParts'
import { choice, scannerSectionFromUrl } from '../lib/researchNavigation'
import {
  fleetStats,
  isQuarantined,
  isTrading,
  weekBlockers,
  weekTitle,
  worthActingOn,
} from '../lib/scannerFleet'
import { useResearchFilters } from '../lib/useResearchFilters'

import { useAuth } from '../auth/AuthGate'
import { CATEGORIES, categorize, type Category } from '../lib/categories'
import { fmtMs, fmtPct, fmtProfitFactor, timeAgo } from '../lib/format'
import { scannerActivity } from '../lib/scannerPresentation'
import { useToast } from '../lib/toast'
import '../styles/pages/scanners.css'

const KIND_TONE: Record<string, 'ok' | 'accent' | 'muted' | 'warn' | 'danger'> = {
  plan: 'ok',
  signal: 'accent',
  exits: 'muted',
  levels: 'muted',
  silent: 'warn',
  broken: 'danger',
}

const EXIT_MODES: ExitMode[] = ['levels', 'script', 'both']

export function Scanners() {
  const scanners = useScanners()
  const auth = useAuth()
  // filters live in the URL so a link, Back and Forward keep them; defaults stay out of it
  const { params, set, setSection, hash } = useResearchFilters()
  const activity = choice(
    params.get('activity'),
    ['all', 'scheduled', 'shadow', 'watch', 'fault', 'unallocated', 'context', 'off', 'unknown'],
    'all',
  )
  const config = useConfig()
  const markets = useMarkets()
  const update = useUpdateScanner()
  const run = useRunScanner()
  const release = useReleaseScanner()
  const releaseNow = (s: Scanner) =>
    release.mutate(s.id, {
      onSuccess: () => toast.success(`${s.name} released: it runs again from its next bar`),
      onError: (e) => toast.error(String((e as Error).message ?? e)),
    })
  const toast = useToast()
  // narrow screens start on cards: a wide table is the wrong first look on a phone
  const defaultView =
    typeof window !== 'undefined' && window.matchMedia?.('(max-width: 700px)').matches ? 'cards' : 'list'
  const view = choice(params.get('view'), ['list', 'cards', 'table'], defaultView)
  const setView = (value: 'list' | 'cards' | 'table') => set({ view: value })
  const pipeline = useScannerPipeline()
  const cat = choice(params.get('category'), CATEGORIES, 'All') as Category
  const filter = params.get('q') ?? ''
  const [bulkBusy, setBulkBusy] = useState(false)
  const [confirmBulk, setConfirmBulk] = useState<boolean | null>(null)
  const [removing, setRemoving] = useState<Scanner | null>(null)
  const qc = useQueryClient()
  const showHidden = params.get('removed') === '1'
  const author = params.get('author') ?? 'All'
  // `?book=account` from the Overview's attention line lands on the right tab
  const book = params.get('book')
  const bookFilter = book === 'account' || book === 'shadow' || book === 'none' ? book : 'all'
  const setBookFilter = (value: string) => set({ book: value === 'all' ? null : value })
  const busy = !auth.canTrade || update.isPending || bulkBusy
  const tab = scannerSectionFromUrl(params, hash)
  const setTab = (value: ScTab) => setSection(value)

  // Inline chips offer the globally configured symbols plus anything a scanner already uses
  // (the full market list is hundreds of symbols — edit the global list on Settings).
  const symbolOptions = useMemo(() => {
    const set = new Set<string>(config.data?.symbols ?? [])
    for (const s of scanners.data ?? []) for (const x of s.symbols ?? []) set.add(x)
    if (set.size === 0) for (const m of (markets.data ?? []).slice(0, 8)) set.add(m.symbol)
    return Array.from(set)
  }, [config.data, markets.data, scanners.data])

  const filteredScanners = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (scanners.data ?? []).filter(
      (s) =>
        (showHidden || !s.hidden) &&
        (activity === 'all' || scannerActivity(s).key === activity) &&
        (author === 'All' || (s.author ?? 'Unknown author') === author) &&
        (bookFilter === 'all' ||
          (bookFilter === 'account'
            ? (s.books?.account.length ?? 0) > 0
            : bookFilter === 'shadow'
              ? (s.books?.shadow.length ?? 0) + (s.books?.proposed.length ?? 0) > 0
              : !(s.books?.account.length || s.books?.shadow.length || s.books?.proposed.length))) &&
        (!f || s.name.toLowerCase().includes(f) || s.id.toLowerCase().includes(f)),
    )
  }, [scanners.data, filter, showHidden, author, bookFilter, activity])
  const isListTab = tab === 'trading' || tab === 'catalogue' || tab === 'quarantined'
  const scoped = useMemo(
    () =>
      tab === 'trading'
        ? filteredScanners.filter(isTrading)
        : tab === 'quarantined'
          ? filteredScanners.filter(isQuarantined)
          : filteredScanners,
    [filteredScanners, tab],
  )
  const rows = useMemo(() => scoped.filter((s) => cat === 'All' || categorize(s.name) === cat), [scoped, cat])
  // Render the grid in pages. Every scanner stays reachable, but a category with hundreds of
  // scripts no longer builds 20+ screens of cards before the page is usable.
  const PAGE = 60
  // the page count is keyed on what is being paged, so a new category or filter starts again at one page without an effect
  const pageKey = `${tab}|${cat}|${scoped.map((x) => x.id).join(',')}`
  const [page, setPage] = useState<{ key: string; n: number }>({ key: pageKey, n: PAGE })
  const shown = page.key === pageKey ? page.n : PAGE
  const visibleRows = useMemo(() => rows.slice(0, shown), [rows, shown])
  const authors = useMemo(
    () => ['All', ...Array.from(new Set((scanners.data ?? []).map((s) => s.author ?? 'Unknown author')))],
    [scanners.data],
  )
  const hiddenCount = (scanners.data ?? []).filter((s) => s.hidden).length
  const enabledCount = (scanners.data ?? []).filter((s) => s.enabled).length
  const counts = useMemo(() => {
    const c = new Map<Category, number>()
    for (const s of scoped) c.set(categorize(s.name), (c.get(categorize(s.name)) ?? 0) + 1)
    return c
  }, [scoped])
  const listed = useMemo(
    () => (scanners.data ?? []).filter((s) => showHidden || !s.hidden),
    [scanners.data, showHidden],
  )
  const tabCounts = useMemo(
    () => ({
      trading: listed.filter(isTrading).length,
      catalogue: listed.length,
      quarantined: listed.filter(isQuarantined).length,
    }),
    [listed],
  )
  const ambiguousNames = useMemo(() => ambiguousScannerNames(scanners.data ?? []), [scanners.data])
  const fleet = useMemo(() => fleetStats(scanners.data ?? []), [scanners.data])
  const todo = useMemo(() => worthActingOn(scanners.data ?? []), [scanners.data])
  const [todoAll, setTodoAll] = useState(false)
  const pipe = useMemo(() => {
    const cells = pipeline.data?.cells
    return cells
      ? { runs: cells.reduce((n, c) => n + c.runs, 0), failures: cells.reduce((n, c) => n + c.failures, 0) }
      : null
  }, [pipeline.data])
  const resetFilters = () =>
    set({ q: null, category: null, author: null, activity: null, removed: null, book: null })
  const filtersActive =
    !!filter || cat !== 'All' || author !== 'All' || activity !== 'all' || bookFilter !== 'all'

  const patch = (s: Scanner, body: Parameters<typeof update.mutate>[0]['body'], okMsg?: string) =>
    update.mutate(
      { id: s.id, body },
      {
        onSuccess: () => okMsg && toast.success(okMsg),
        onError: (e) => toast.error(`Update failed: ${s.name}`, e.message),
      },
    )

  const runNow = (s: Scanner) =>
    run.mutate(s.id, {
      onSuccess: (r) => toast.success(`Queued ${s.name}`, `${r.queued} run(s)`),
      onError: (e) => toast.error(`Run failed: ${s.name}`, e.message),
    })

  const autoTune = async () => {
    setBulkBusy(true)
    try {
      const r = await api.autoTune()
      void qc.invalidateQueries({ queryKey: qk.scanners })
      void qc.invalidateQueries({ queryKey: qk.config })
      toast.success(
        r.applied ? `Auto-tuned ${r.tuned} scanners` : `Reviewed ${r.tuned} scanners`,
        !r.applied
          ? 'Recommendations only. Incubator and Decisions manage account allocations.'
          : `${r.disabled} disabled (no profitable symbol) · ${r.report
              .filter((x) => !x.disabled)
              .map((x) => `${x.name.slice(0, 18)}: ${x.after.length}/${x.before.length}`)
              .slice(0, 6)
              .join(' · ')}`,
      )
    } catch (e) {
      toast.error('Auto-tune failed', (e as Error).message)
    } finally {
      setBulkBusy(false)
    }
  }

  const bulk = async (enabled: boolean) => {
    const list = (scanners.data ?? []).filter((s) =>
      enabled ? s.status === 'ok' && !s.enabled && !s.hidden : s.enabled,
    )
    if (!list.length) {
      const all = scanners.data ?? []
      const runnable = all.filter((s) => s.status === 'ok').length
      const on = all.filter((s) => s.enabled).length
      return toast.info(
        enabled ? `All ${runnable} runnable scanners are already enabled` : 'No scanners are enabled',
        enabled
          ? `${all.length - runnable} scanner(s) have no published source and cannot run`
          : `${on} enabled of ${runnable} runnable`,
      )
    }
    setBulkBusy(true)
    let ok = 0
    for (const s of list) {
      try {
        await update.mutateAsync({ id: s.id, body: { enabled } })
        ok++
      } catch (e) {
        toast.error(`Failed: ${s.name}`, (e as Error).message)
      }
    }
    setBulkBusy(false)
    toast.success(`${enabled ? 'Enabled' : 'Disabled'} ${ok} scanner(s)`)
  }

  const onHide = (s: Scanner) => {
    if (s.hidden) patch(s, { hidden: false }, `Restored ${s.name}`)
    else setRemoving(s)
  }

  const tableCols = useMemo<Column<Scanner>[]>(
    () => [
      {
        key: 'name',
        header: 'Scanner',
        value: (s) => s.name,
        render: (s) => (
          <span className="cell-sym">
            <span
              className={`dot ${s.enabled ? 'dot-ok' : s.status === 'ok' ? 'dot-neutral' : 'dot-danger'}`}
            />
            <span>
              <Link to={`/scanners/${s.id}`} className="strong">
                {s.name}
                {ambiguousNames.has(s.name) && <span className="small muted"> · {s.id}</span>}
              </Link>{' '}
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="link muted"
                title="Open on TradingView"
                aria-label={`Open ${s.name} on TradingView`}
              >
                <IconExternal />
              </a>
              <div className="muted small mono">
                {s.id} · v{s.pineVersion} · {s.lines} lines
              </div>
            </span>
          </span>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        value: (s) => s.status,
        render: (s) => <ScannerStatusPill status={s.status} reason={s.reason} />,
      },
      {
        key: 'books',
        header: 'Books',
        value: (s) =>
          (s.books?.account.length ?? 0) * 1000 +
          (s.books?.shadow.length ?? 0) +
          (s.books?.proposed.length ?? 0),
        title:
          'Account allocations and shadow research allocations. A book allocation alone does not guarantee a scheduled scan or a fill. Hover for markets.',
        render: (s) => <BookCells s={s} />,
      },
      {
        key: 'week',
        header: '7 days',
        title:
          "This scanner's entry signals in the last seven days: how many, how many opened, and what refused the rest (market gate, fee rule, regime, entry guards)",
        value: (s) => s.week?.entries ?? 0,
        numeric: true,
        render: (s) =>
          s.week && s.week.entries ? (
            <span
              className="mono small"
              title={`filled ${s.week.opened} · pending ${s.week.pending ?? 0} · pilot cap ${s.week.pilot ?? 0} · protection ${s.week.protection ?? 0} · gate ${s.week.gate} · fee ${s.week.fee} · regime ${s.week.regime} · guards ${s.week.guard} · other ${s.week.other}`}
            >
              {s.week.entries} → <b className={s.week.opened ? 'gain' : ''}>{s.week.opened}</b>
              {s.week.pending ? ` · pending ${s.week.pending}` : ''}
              {s.week.pilot ? ` · pilot cap ${s.week.pilot}` : ''}
              {s.week.protection ? ` · stops ${s.week.protection}` : ''}
              {s.week.gate ? ` · gate ${s.week.gate}` : ''}
              {s.week.fee ? ` · fee ${s.week.fee}` : ''}
              {s.week.regime ? ` · regime ${s.week.regime}` : ''}
              {s.week.guard ? ` · guard ${s.week.guard}` : ''}
            </span>
          ) : (
            <span className="muted">–</span>
          ),
      },
      {
        key: 'kind',
        header: 'Kind',
        value: (s) => s.kind ?? '',
        title:
          'What the script produced when last profiled: plan (its own stop and targets), signal (a direction), levels (information), silent, broken',
        render: (s) =>
          s.health?.quarantined ? (
            <Pill tone="danger" title={`Quarantined: ${s.health.reason ?? s.health.lastError}`}>
              quarantined
            </Pill>
          ) : s.kind ? (
            <Pill tone={KIND_TONE[s.kind]}>{s.kind}</Pill>
          ) : (
            <span className="muted">–</span>
          ),
      },
      {
        key: 'reads',
        header: 'Reads',
        value: (s) => (s.reads?.sources ?? []).join(','),
        title:
          'Which channels may open a trade; automatic uses the production reader, while an empty list disables entries',
        render: (s) => (
          <span className="mono small muted">
            {s.reads?.sources == null
              ? 'automatic'
              : s.reads.sources.length
                ? s.reads.sources.join('+')
                : 'entries disabled'}
            {s.reads?.rule ? ` · ${s.reads.rule}` : ''}
          </span>
        ),
      },
      {
        key: 'enabled',
        header: 'On',
        value: (s) => (s.enabled ? 1 : 0),
        render: (s) => (
          <label
            className="switch"
            title={
              s.status !== 'ok'
                ? `Cannot enable: ${s.reason ?? s.status}`
                : s.enabled
                  ? 'Enabled'
                  : 'Disabled'
            }
          >
            <input
              type="checkbox"
              checked={s.enabled}
              disabled={s.status !== 'ok' || busy}
              onChange={(e) => patch(s, { enabled: e.target.checked })}
              aria-label={`Enable ${s.name}`}
            />
            <span className="switch-ui" />
          </label>
        ),
      },
      {
        key: 'symbols',
        header: 'Symbols',
        sortable: false,
        render: (s) =>
          Array.isArray(s.pairs) ? (
            <span className="mono small" title="Explicit pair assignments. Add pairs through the Incubator.">
              {s.pairs.length
                ? s.pairs.map((p) => `${p.symbol.replace(/USD$/, '')} ${p.tf}`).join(' · ')
                : 'No pairs assigned'}
            </span>
          ) : (
            <ChipSelect
              compact
              options={symbolOptions}
              value={s.symbols ?? []}
              onChange={(v) => patch(s, { symbols: v })}
              emptyLabel="none assigned"
              disabled={busy}
            />
          ),
      },
      {
        key: 'tfs',
        header: 'Timeframes',
        sortable: false,
        render: (s) => (
          <span className="muted small">
            {Array.isArray(s.pairs)
              ? s.pairs.length
                ? 'per pair'
                : 'no scheduled frames'
              : s.symbols?.length
                ? (s.timeframes ?? config.data?.timeframes ?? []).join(' · ')
                : 'no scheduled frames'}
          </span>
        ),
      },
      {
        key: 'exit',
        header: 'Exit',
        value: (s) => s.exitMode,
        render: (s) => (
          <select
            className="select select-sm"
            value={s.exitMode}
            onChange={(e) => patch(s, { exitMode: e.target.value as ExitMode })}
            aria-label={`Exit mode for ${s.name}`}
            disabled={busy}
          >
            {EXIT_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ),
      },
      {
        key: 'lastRun',
        header: 'Last run',
        value: (s) => s.lastRun?.at ?? null,
        render: (s) =>
          s.lastRun ? (
            <span className="small" title={`${s.lastRun.symbol} ${s.lastRun.tf}`}>
              <Time t={s.lastRun.at} mode="ago" /> <span className="mono muted">{fmtMs(s.lastRun.ms)}</span>
              {s.lastRun.error && (
                <div className="loss small" title={s.lastRun.error}>
                  {s.lastRun.error.slice(0, 40)}
                  {s.lastRun.error.length > 40 ? '…' : ''}
                </div>
              )}
            </span>
          ) : (
            <span className="muted">–</span>
          ),
      },
      { key: 'signals', header: 'Sig', numeric: true, value: (s) => s.stats?.signals ?? 0 },
      { key: 'trades', header: 'Trd', numeric: true, value: (s) => s.stats?.trades ?? 0 },
      {
        key: 'win',
        header: 'Win%',
        numeric: true,
        value: (s) => s.stats?.winRatePct,
        render: (s) => fmtPct(s.stats?.winRatePct),
      },
      {
        key: 'pnl',
        header: 'PnL',
        numeric: true,
        value: (s) => s.stats?.pnl,
        render: (s) => <Pnl value={s.stats?.pnl} />,
      },
      {
        key: 'pf',
        header: 'PF',
        numeric: true,
        value: (s) => s.stats?.profitFactor,
        render: (s) => fmtProfitFactor(s.stats?.profitFactor),
      },
      {
        key: 'bpf',
        header: 'BT PF',
        numeric: true,
        value: (s) => s.stats?.backtest?.profitFactor,
        render: (s) => <span className="muted">{fmtProfitFactor(s.stats?.backtest?.profitFactor)}</span>,
        title: 'Backtest profit factor',
      },
      {
        key: 'actions',
        header: '',
        sortable: false,
        align: 'right',
        render: (s) => (
          <span className="row-actions">
            <button
              className="btn btn-xs"
              onClick={() => onHide(s)}
              disabled={busy}
              title={s.hidden ? 'Restore to the list' : 'Remove from the list (disables it)'}
            >
              {s.hidden ? 'Restore' : 'Remove'}
            </button>
            {s.health?.quarantined && (
              <button
                className="btn btn-xs btn-danger-outline"
                onClick={() => releaseNow(s)}
                disabled={busy || release.isPending}
                title={`Quarantined: ${s.health.reason ?? s.health.lastError}. Release it to schedule it again; a repeat failure quarantines it again.`}
              >
                Release
              </button>
            )}
            <button
              className="btn btn-xs"
              onClick={() => runNow(s)}
              disabled={s.status !== 'ok' || !auth.canTrade || run.isPending}
              title="Run now"
            >
              <IconPlay /> Run
            </button>
            <Link to={`/scanners/${s.id}`} className="btn btn-xs">
              View
            </Link>
          </span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [symbolOptions, busy, run.isPending, config.data?.timeframes, ambiguousNames],
  )

  const totalEntries = fleet.totalEntries
  const listCols = useMemo<Column<Scanner>[]>(
    () => [
      {
        key: 'name',
        header: 'Scanner',
        value: (s) => s.name,
        render: (s) => {
          const tfs = Array.isArray(s.pairs)
            ? [...new Set(s.pairs.map((p) => p.tf))].join('/')
            : (s.timeframes ?? []).join('/')
          return (
            <span className="sc-name">
              <span
                className={`dot ${s.enabled ? 'dot-ok' : s.status === 'ok' ? 'dot-neutral' : 'dot-danger'}`}
                aria-hidden
              />
              <span className="sc-name-text">
                <span className="sc-name-line">
                  <Link to={`/scanners/${s.id}`} className="strong">
                    {s.name}
                    {ambiguousNames.has(s.name) && <span className="small muted"> · {s.id}</span>}
                  </Link>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="link muted"
                    title="Open on TradingView"
                    aria-label={`Open ${s.name} on TradingView`}
                  >
                    <IconExternal />
                  </a>
                </span>
                <span className="sc-sub">{[s.author, tfs].filter(Boolean).join(' · ')}</span>
              </span>
            </span>
          )
        },
      },
      {
        key: 'status',
        header: 'Status',
        value: (s) => scannerActivity(s).label,
        title: 'Whether the paper account is scanning it, and why not if it is not',
        render: (s) => {
          const a = scannerActivity(s)
          return (
            <span className="sc-cell">
              <Pill tone={a.tone} title={a.detail}>
                {a.label}
              </Pill>
              <span className="sc-books">
                {s.books && (s.books.account.length || s.books.shadow.length || s.books.proposed.length) ? (
                  <BookCells s={s} />
                ) : null}
                <span className="sc-sub" title={a.detail}>
                  {a.key === 'scheduled'
                    ? `${s.scheduledCells} ${s.scheduledCells === 1 ? 'cell' : 'cells'}`
                    : a.detail}
                </span>
              </span>
            </span>
          )
        },
      },
      {
        key: 'entries',
        header: 'Entries · 7d',
        numeric: true,
        value: (s) => s.week?.entries ?? 0,
        title:
          'Entry signals in the last seven days, how many opened a trade, and what stopped most of the rest',
        render: (s) => {
          const w = s.week
          if (!w || !w.entries) return <span className="muted">–</span>
          const top = weekBlockers(w)[0]
          return (
            <span className="sc-cell end" title={weekTitle(w)}>
              <span className="mono">{w.entries}</span>
              <span className="sc-sub">
                <b className={w.opened ? 'gain' : ''}>{w.opened} opened</b>
                {top ? ` · ${top[0]} ${top[1]}` : ''}
              </span>
            </span>
          )
        },
      },
      {
        key: 'share',
        header: 'Entry share',
        value: (s) => s.week?.entries ?? 0,
        title: "This scanner's part of all entry signals in the last seven days",
        render: (s) =>
          totalEntries && s.week?.entries ? (
            <ShareBar pct={(s.week.entries / totalEntries) * 100} />
          ) : (
            <span className="muted">–</span>
          ),
      },
      {
        key: 'record',
        header: 'Record',
        value: (s) => s.stats?.trades ?? 0,
        title:
          'Closed paper trades, win rate and profit factor. The second line is the backtest profit factor.',
        render: (s) => {
          const st = s.stats
          return st?.trades ? (
            <span className="sc-cell">
              <span className="small">
                <span className="mono">{st.trades}</span> trades ·{' '}
                <span className="mono">{fmtPct(st.winRatePct)}</span> win
              </span>
              <span className="sc-sub">
                PF {fmtProfitFactor(st.profitFactor)} · backtest {fmtProfitFactor(st.backtest?.profitFactor)}
              </span>
            </span>
          ) : (
            <span className="sc-cell">
              <span className="muted small">No trades yet</span>
              <span className="sc-sub">backtest PF {fmtProfitFactor(st?.backtest?.profitFactor)}</span>
            </span>
          )
        },
      },
      {
        key: 'pnl',
        header: 'PnL',
        numeric: true,
        value: (s) => s.stats?.pnl,
        render: (s) => <Pnl value={s.stats?.pnl} />,
      },
      {
        key: 'lastRun',
        header: 'Last run',
        value: (s) => s.lastRun?.at ?? null,
        render: (s) =>
          s.lastRun ? (
            <span className="sc-cell" title={`${s.lastRun.symbol} ${s.lastRun.tf}`}>
              <span className="small">
                <Time t={s.lastRun.at} mode="ago" />
              </span>
              <span className="sc-sub">
                {s.lastRun.error ? <span className="loss">failed</span> : fmtMs(s.lastRun.ms)}
              </span>
            </span>
          ) : (
            <span className="muted">never</span>
          ),
      },
      {
        key: 'enabled',
        header: 'On',
        value: (s) => (s.enabled ? 1 : 0),
        render: (s) => (
          <label
            className="switch"
            title={
              s.status !== 'ok'
                ? `Cannot enable: ${s.reason ?? s.status}`
                : s.enabled
                  ? 'Enabled'
                  : 'Disabled'
            }
          >
            <input
              type="checkbox"
              checked={s.enabled}
              disabled={s.status !== 'ok' || busy}
              onChange={(e) => patch(s, { enabled: e.target.checked })}
              aria-label={`Enable ${s.name}`}
            />
            <span className="switch-ui" />
          </label>
        ),
      },
      {
        key: 'actions',
        header: <span className="sr-only">Actions</span>,
        sortable: false,
        align: 'right',
        render: (s) => (
          <span className="sc-actions">
            {s.health?.quarantined && (
              <button
                className="btn btn-xs btn-danger-outline"
                onClick={() => releaseNow(s)}
                disabled={busy || release.isPending}
                title={`Quarantined: ${s.health.reason ?? s.health.lastError}. Release it to schedule it again; a repeat failure quarantines it again.`}
              >
                Release
              </button>
            )}
            <RowMenu label={`Actions for ${s.name}`} items={rowMenuItems(s)} />
          </span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, run.isPending, release.isPending, totalEntries, auth.canTrade, ambiguousNames],
  )
  const rowMenuItems = (s: Scanner): MenuItem[] => [
    { key: 'open', label: 'Open details', to: `/scanners/${s.id}` },
    {
      key: 'run',
      label: (
        <>
          <IconPlay /> Run now
        </>
      ),
      onSelect: () => runNow(s),
      disabled: s.status !== 'ok' || !auth.canTrade || run.isPending,
      title: s.status !== 'ok' ? `Cannot run: ${s.reason ?? s.status}` : 'Queue one run now',
    },
    { key: 'tv', label: 'Open on TradingView', href: s.url },
    ...(s.health?.quarantined
      ? [
          {
            key: 'release',
            label: 'Release from quarantine',
            onSelect: () => releaseNow(s),
            disabled: busy || release.isPending,
          },
        ]
      : []),
    {
      key: 'hide',
      label: s.hidden ? 'Restore to the list' : 'Remove from the list',
      onSelect: () => onHide(s),
      disabled: busy,
      danger: !s.hidden,
      title: s.hidden ? undefined : 'Disables it and hides it. Restore it later with Show removed.',
    },
  ]

  const moreItems: MenuItem[] = [
    {
      key: 'enable',
      label: bulkBusy ? 'Working…' : 'Enable all runnable',
      onSelect: () => setConfirmBulk(true),
      disabled: busy || !scanners.data,
      title:
        'Every runnable scanner on its own symbols: a fleet far above the cap, which the server refuses. Enable scanners one at a time or through the Incubator instead.',
    },
    {
      key: 'disable',
      label: 'Disable all',
      onSelect: () => setConfirmBulk(false),
      disabled: busy || !scanners.data || enabledCount === 0,
      danger: true,
      title: 'Stops every enabled scanner. Open positions are kept.',
    },
  ]
  const subtitle = scanners.data
    ? `${tabCounts.trading} allocated or enabled, ${tabCounts.catalogue} in the catalogue, ${tabCounts.quarantined} quarantined${hiddenCount ? `, ${hiddenCount} removed` : ''}.`
    : 'Loading scanners.'
  const tabItems = [
    { id: 'trading' as const, label: 'Allocated', count: scanners.data ? tabCounts.trading : undefined },
    { id: 'catalogue' as const, label: 'Catalogue', count: scanners.data ? tabCounts.catalogue : undefined },
    {
      id: 'quarantined' as const,
      label: 'Quarantined',
      count: scanners.data ? tabCounts.quarantined : undefined,
      attention: tabCounts.quarantined > 0 && todo.some((t) => t.tone === 'danger'),
    },
    { id: 'readiness' as const, label: 'Readiness' },
    { id: 'contributions' as const, label: 'Contributions' },
  ]
  const shownTodo = todoAll ? todo : todo.slice(0, 5)

  return (
    <div className="page sc-page">
      <RouteHeader
        sub={subtitle}
        actions={
          <>
            <button
              className="btn"
              onClick={() => autoTune()}
              disabled={busy || !scanners.data}
              title="Review backtest recommendations. Advisory while Incubator is enabled; applies symbol allocations only when Incubator is off."
            >
              Review backtests
            </button>
            <RowMenu label="Bulk actions" items={moreItems}>
              More
            </RowMenu>
          </>
        }
      />

      <StatGrid min={150}>
        <Stat
          label="Paper entry signals · 7d"
          value={scanners.data ? fleet.totalEntries.toLocaleString() : '–'}
          sub={scanners.data ? `${fleet.opened} opened a trade` : undefined}
          title="Paper admission signals, including qualified shadow copies, from listed scanners in the last seven days"
        />
        <Stat
          label="Largest share"
          value={fleet.top ? `${fleet.top.pct.toFixed(0)}%` : '–'}
          tone={fleet.top && fleet.top.pct >= 50 ? 'warn' : undefined}
          sub={fleet.top ? <span title={fleet.top.name}>{fleet.top.name}</span> : 'No entry signals yet'}
          title="The scanner with the biggest part of all entry signals"
        />
        <Stat
          label="Runs · 24h"
          value={pipe ? pipe.runs.toLocaleString() : '–'}
          tone={pipe && pipe.failures > 0 ? 'warn' : undefined}
          sub={pipe ? `${pipe.failures} failed` : pipeline.isError ? 'Not available' : 'Loading'}
          title="Scans of scheduled scanner and market pairs in the last 24 hours"
        />
        <Stat
          label="Last run"
          value={fleet.lastRunAt ? timeAgo(fleet.lastRunAt) : '–'}
          sub={fleet.lastRunName ?? 'Nothing has run yet'}
          title="The most recent scan by any scanner"
        />
      </StatGrid>

      <Tabs value={tab} onChange={setTab} items={tabItems} label="Scanner views" idPrefix="sc" />

      {isListTab && (
        <TabPanel id={tab} value={tab} idPrefix="sc">
          {tab === 'trading' &&
            scanners.data &&
            (todo.length > 0 ? (
              <div className="needs mb-page">
                <div className="needs-head">
                  <h2>Setup and entry reviews</h2>
                  <span className="needs-count mono">{todo.length}</span>
                </div>
                <p className="muted sc-todo-note">
                  Past refusals are historical outcomes, not necessarily active blocks. Expand a row for exact
                  reasons and current paper readiness.
                </p>
                <ul className="needs-list">
                  {shownTodo.map((t) => (
                    <li key={t.s.id} className="sc-todo-item">
                      <div className="needs-text">
                        <span className={`sc-todo-tone ${t.tone}`} aria-hidden />
                        <div className="sc-todo-copy">
                          <Link to={`/scanners/${t.s.id}`} className="strong">
                            {t.s.name}
                            {ambiguousNames.has(t.s.name) && <span className="muted mono"> · {t.s.id}</span>}
                          </Link>
                          <span className="sc-todo-detail">{t.text}</span>
                          {t.history && !!t.s.week?.lastEntryAt && (
                            <span className="muted sc-todo-detail">
                              Last entry attempt {timeAgo(t.s.week.lastEntryAt)}
                            </span>
                          )}
                          {t.evidence && <span className="sc-todo-detail">{t.evidence}</span>}
                          {((t.history && !!t.s.week?.reasons?.length) ||
                            !!t.s.paperReadiness?.holds.length) && (
                            <details className="sc-todo-detail">
                              <summary>Evidence and recorded reasons</summary>
                              {t.history &&
                                t.s.week?.reasons?.map((r) => (
                                  <div key={`${r.action}:${r.symbol}:${r.tf}`} className="sc-todo-reason">
                                    {r.n} × {r.symbol} {r.tf}: {r.action.replace(/^rejected:/, '')} ·{' '}
                                    {timeAgo(r.lastAt)}
                                  </div>
                                ))}
                              {t.s.paperReadiness?.holds.map((r) => (
                                <div key={`${r.symbol}:${r.tf}`} className="sc-todo-reason">
                                  Current evidence · {r.symbol} {r.tf}: {r.reason}
                                </div>
                              ))}
                            </details>
                          )}
                        </div>
                      </div>
                      <span className="sc-todo-actions">
                        {t.release && (
                          <button
                            className="btn btn-xs btn-danger-outline"
                            onClick={() => releaseNow(t.s)}
                            disabled={busy || release.isPending}
                          >
                            Release
                          </button>
                        )}
                        <Link to={t.href ?? `/scanners/${t.s.id}`} className="btn btn-xs">
                          {t.action ?? 'Inspect scanner'}
                        </Link>
                      </span>
                    </li>
                  ))}
                </ul>
                {todo.length > 5 && (
                  <button
                    type="button"
                    className="btn btn-xs btn-quiet mt-small"
                    onClick={() => setTodoAll((v) => !v)}
                  >
                    {todoAll ? 'Show fewer' : `Show all ${todo.length}`}
                  </button>
                )}
              </div>
            ) : (
              <div className="mb-page">
                <Callout tone="ok" title="No setup or entry reviews.">
                  No issues meet this panel’s review criteria in the available data. This does not guarantee
                  future signals or fills.
                </Callout>
              </div>
            ))}

          {tab === 'quarantined' && (
            <div className="mb-page">
              <Callout tone="warn" title="These scanners failed repeatedly and are not scheduled.">
                Release one to schedule it again. A repeat failure quarantines it again.
              </Callout>
            </div>
          )}

          <div className="sc-filters">
            <Toolbar
              end={
                <>
                  <span className="sc-count" role="status">
                    {scanners.data ? `${rows.length} shown` : 'Loading…'}
                  </span>
                  <ToggleGroup
                    ariaLabel="View"
                    value={view}
                    onChange={setView}
                    options={[
                      { value: 'list', label: 'List', ariaLabel: 'List view' },
                      { value: 'cards', label: 'Cards', ariaLabel: 'Card view' },
                      {
                        value: 'table',
                        label: 'All columns',
                        ariaLabel: 'All columns, with symbol and exit editing',
                      },
                    ]}
                  />
                </>
              }
            >
              <input
                className="input sc-search"
                type="search"
                placeholder="Search scanners"
                value={filter}
                onChange={(e) => set({ q: e.target.value }, true)}
                aria-label="Search scanners by name or id"
              />
              <ToggleGroup
                ariaLabel="Book"
                value={bookFilter}
                onChange={setBookFilter}
                options={[
                  { value: 'all', label: 'All books' },
                  { value: 'account', label: 'In the account' },
                  { value: 'shadow', label: 'In the shadow book' },
                  { value: 'none', label: 'Not trading' },
                ]}
              />
              <select
                className="select sc-author-select"
                value={author}
                onChange={(e) => set({ author: e.target.value === 'All' ? null : e.target.value })}
                aria-label="Author"
              >
                {authors.map((a) => (
                  <option key={a} value={a}>
                    {a === 'All' ? 'All authors' : a}
                  </option>
                ))}
              </select>
              <label className="sc-field">
                <span>Execution path</span>
                <select
                  className="select"
                  value={activity}
                  onChange={(e) => set({ activity: e.target.value === 'all' ? null : e.target.value })}
                >
                  <option value="all">All states</option>
                  <option value="scheduled">Scheduled</option>
                  <option value="fault">Errors / quarantine</option>
                  <option value="unallocated">No scheduled cells</option>
                  <option value="context">Entries disabled</option>
                  <option value="off">Paper disabled</option>
                  <option value="shadow">Shadow allocated / copy path</option>
                  <option value="watch">Watch-only tracking</option>
                  <option value="unknown">Schedule unknown</option>
                </select>
              </label>
              <label className="sc-check" title="Removed scanners stay disabled; restore any from here">
                <input
                  type="checkbox"
                  checked={showHidden}
                  onChange={(e) => set({ removed: e.target.checked ? '1' : null })}
                  disabled={!scanners.data}
                />{' '}
                Show removed{scanners.data ? ` (${hiddenCount})` : ''}
              </label>
              {(filtersActive || showHidden) && (
                <button className="btn btn-sm" onClick={resetFilters}>
                  Clear filters
                </button>
              )}
            </Toolbar>
            <div className="sc-chips" role="group" aria-label="Category">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="sc-chip"
                  aria-pressed={cat === c}
                  onClick={() => set({ category: c === 'All' ? null : c })}
                >
                  {c}
                  {c !== 'All' && counts.get(c) ? <span className="sc-chip-n">{counts.get(c)}</span> : null}
                </button>
              ))}
            </div>
          </div>

          {scanners.isLoading &&
            !scanners.data &&
            (view === 'cards' ? (
              <Loading kind="cards" rows={6} />
            ) : (
              <Loading kind="table" rows={10} cols={8} />
            ))}
          {scanners.isError && <ErrorState error={scanners.error} onRetry={() => scanners.refetch()} />}

          {scanners.data && rows.length === 0 && (
            <div className="panel mt-page">
              <EmptyState
                title={
                  tab === 'trading' && !filtersActive
                    ? 'No scanner is trading.'
                    : tab === 'quarantined' && !filtersActive
                      ? 'No scanner is quarantined.'
                      : 'No scanners match these filters.'
                }
                hint={
                  tab === 'trading' && !filtersActive
                    ? 'Turn one on from the Catalogue, or promote one through the Incubator.'
                    : tab === 'quarantined' && !filtersActive
                      ? 'Scanners land here after repeated failures.'
                      : 'Clear a filter or pick another category.'
                }
                action={
                  <>
                    {(filtersActive || showHidden) && (
                      <button className="btn btn-sm" onClick={resetFilters}>
                        Clear filters
                      </button>
                    )}
                    {tab !== 'catalogue' && (
                      <button className="btn btn-sm" onClick={() => setTab('catalogue')}>
                        Open the catalogue
                      </button>
                    )}
                  </>
                }
              />
            </div>
          )}

          {scanners.data && rows.length > 0 && view !== 'cards' && (
            <div className="panel sc-list mt-page">
              <DataTable
                key={view}
                columns={view === 'list' ? listCols : tableCols}
                rows={rows}
                rowKey={(s) => s.id}
                defaultSort={
                  view === 'list'
                    ? tab === 'quarantined'
                      ? { key: 'name', dir: 'asc' }
                      : { key: 'entries', dir: 'desc' }
                    : { key: 'name', dir: 'asc' }
                }
                caption="Scanners"
                rowHeight={view === 'list' ? 56 : 38}
              />
            </div>
          )}

          {scanners.data && rows.length > 0 && view === 'cards' && (
            <div className="sc-cards mt-page">
              {visibleRows.map((s) => (
                <ScannerCard
                  key={s.id}
                  s={s}
                  showIdentity={ambiguousNames.has(s.name)}
                  onToggle={(v) => patch(s, { enabled: v })}
                  onRun={() => runNow(s)}
                  onHide={() => onHide(s)}
                  onRelease={() => releaseNow(s)}
                  busy={busy}
                  runBusy={!auth.canTrade || run.isPending}
                />
              ))}
            </div>
          )}
          {scanners.data && view === 'cards' && rows.length > visibleRows.length && (
            <div className="more-row">
              <button
                type="button"
                className="btn"
                onClick={() => setPage({ key: pageKey, n: shown + PAGE })}
              >
                Show {Math.min(PAGE, rows.length - visibleRows.length)} more
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setPage({ key: pageKey, n: rows.length })}
              >
                Show all {rows.length}
              </button>
              <span className="muted small mono">
                {visibleRows.length} of {rows.length}
              </span>
            </div>
          )}
        </TabPanel>
      )}

      <TabPanel id="readiness" value={tab} idPrefix="sc">
        <ScannerReadinessMatrix />
      </TabPanel>
      <TabPanel id="contributions" value={tab} idPrefix="sc">
        <ScannerContributions />
      </TabPanel>

      <ConfirmDialog
        open={confirmBulk !== null}
        title={
          confirmBulk
            ? `Enable ${(scanners.data ?? []).filter((s) => s.status === 'ok' && !s.enabled && !s.hidden).length} runnable scanners?`
            : `Disable all ${enabledCount} enabled scanners?`
        }
        body={
          <p>
            {confirmBulk
              ? 'Scanners without assigned pairs wait for allocation. Existing capacity and admission rules still apply.'
              : 'Enabled scanners stop producing signals. Open positions remain managed by the engine.'}
          </p>
        }
        confirmLabel={confirmBulk ? 'Enable scanners' : 'Disable all'}
        danger={!confirmBulk}
        busy={bulkBusy}
        onCancel={() => setConfirmBulk(null)}
        onConfirm={async () => {
          if (confirmBulk === null) return
          await bulk(confirmBulk)
          setConfirmBulk(null)
        }}
      />
      <ConfirmDialog
        open={!!removing}
        title={removing ? `Remove ${removing.name}?` : ''}
        body={
          <p>
            The scanner is disabled and hidden from the list. You can restore it later via “Show removed”.
          </p>
        }
        confirmLabel="Remove"
        danger
        busy={update.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return
          update.mutate(
            { id: removing.id, body: { hidden: true } },
            {
              onSuccess: () => {
                toast.success(`Removed ${removing.name}`)
                setRemoving(null)
              },
              onError: (e) => toast.error(`Remove failed: ${removing.name}`, e.message),
            },
          )
        }}
      />
    </div>
  )
}

// ---------- tabs and fleet numbers ----------

type ScTab = 'trading' | 'catalogue' | 'quarantined' | 'readiness' | 'contributions'
