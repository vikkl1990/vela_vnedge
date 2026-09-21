import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { qk, useConfig, useMarkets, useRunScanner, useScanners, useUpdateScanner } from '../api/queries'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { ExitMode, Scanner } from '../api/types'
import { DataTable, type Column } from '../components/DataTable'
import { IconExternal, IconGrid, IconPlay, IconRows } from '../components/Icons'
import { ChipSelect, ConfirmDialog, Empty, ErrorState, Loading, PageTitle, Pill, Pnl, ScannerStatusPill, Segmented, Time } from '../components/ui'
import { CATEGORIES, categorize, type Category } from '../lib/categories'
import { fmtMs, fmtProfitFactor, fmtPct } from '../lib/format'
import { DELTA_TIMEFRAMES } from '../lib/timeframes'
import { useToast } from '../lib/toast'

const EXIT_MODES: ExitMode[] = ['levels', 'script', 'both']

export function Scanners() {
  const scanners = useScanners()
  const config = useConfig()
  const markets = useMarkets()
  const update = useUpdateScanner()
  const run = useRunScanner()
  const toast = useToast()
  const [view, setView] = useState<'cards' | 'table'>('cards')
  const [cat, setCat] = useState<Category>('All')
  const [filter, setFilter] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [confirmDisableAll, setConfirmDisableAll] = useState(false)
  const [removing, setRemoving] = useState<Scanner | null>(null)
  const qc = useQueryClient()
  const [showHidden, setShowHidden] = useState(false)
  const [author, setAuthor] = useState<string>('All')
  const busy = update.isPending || bulkBusy

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
    return (scanners.data ?? []).filter((s) =>
      (showHidden || !s.hidden) &&
      (author === 'All' || (s.author ?? 'WillyAlgoTrader') === author) &&
      (!f || s.name.toLowerCase().includes(f) || s.id.toLowerCase().includes(f)))
  }, [scanners.data, filter, showHidden, author])
  const rows = useMemo(() => filteredScanners.filter((s) => cat === 'All' || categorize(s.name) === cat), [filteredScanners, cat])
  // Render the grid in pages. Every scanner stays reachable, but a category with hundreds of
  // scripts no longer builds 20+ screens of cards before the page is usable.
  const PAGE = 60
  const [shown, setShown] = useState(PAGE)
  useEffect(() => setShown(PAGE), [cat, filteredScanners])
  const visibleRows = useMemo(() => rows.slice(0, shown), [rows, shown])
  const authors = useMemo(() => ['All', ...Array.from(new Set((scanners.data ?? []).map((s) => s.author ?? 'WillyAlgoTrader')))], [scanners.data])
  const hiddenCount = (scanners.data ?? []).filter((s) => s.hidden).length
  const enabledCount = (scanners.data ?? []).filter((s) => s.enabled).length
  const counts = useMemo(() => {
    const c = new Map<Category, number>()
    for (const s of filteredScanners) c.set(categorize(s.name), (c.get(categorize(s.name)) ?? 0) + 1)
    return c
  }, [filteredScanners])

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
        `Auto-tuned ${r.tuned} scanners`,
        `${r.disabled} disabled (no profitable symbol) · ${r.report
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
    const list = (scanners.data ?? []).filter((s) => (enabled ? s.status === 'ok' && !s.enabled && !s.hidden : s.enabled))
    if (!list.length) {
      const all = scanners.data ?? []
      const runnable = all.filter((s) => s.status === 'ok').length
      const on = all.filter((s) => s.enabled).length
      return toast.info(
        enabled ? `All ${runnable} runnable scanners are already enabled` : 'No scanners are enabled',
        enabled ? `${all.length - runnable} scanner(s) have no published source and cannot run` : `${on} enabled of ${runnable} runnable`,
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
            <span className={`dot ${s.enabled ? 'dot-ok' : s.status === 'ok' ? 'dot-neutral' : 'dot-danger'}`} />
            <span>
              <Link to={`/scanners/${s.id}`} className="strong">
                {s.name}
              </Link>{' '}
              <a href={s.url} target="_blank" rel="noreferrer" className="link muted" title="Open on TradingView" aria-label={`Open ${s.name} on TradingView`}>
                <IconExternal />
              </a>
              <div className="muted small mono">
                {s.id} · v{s.pineVersion} · {s.lines} lines
              </div>
            </span>
          </span>
        ),
      },
      { key: 'status', header: 'Status', value: (s) => s.status, render: (s) => <ScannerStatusPill status={s.status} reason={s.reason} /> },
      {
        key: 'enabled',
        header: 'On',
        value: (s) => (s.enabled ? 1 : 0),
        render: (s) => (
          <label className="switch" title={s.status !== 'ok' ? `Cannot enable: ${s.reason ?? s.status}` : s.enabled ? 'Enabled' : 'Disabled'}>
            <input type="checkbox" checked={s.enabled} disabled={s.status !== 'ok' || busy} onChange={(e) => patch(s, { enabled: e.target.checked })} aria-label={`Enable ${s.name}`} />
            <span className="switch-ui" />
          </label>
        ),
      },
      {
        key: 'symbols',
        header: 'Symbols',
        sortable: false,
        render: (s) => <ChipSelect compact options={symbolOptions} value={s.symbols ?? []} onChange={(v) => patch(s, { symbols: v })} emptyLabel="global" disabled={busy} />,
      },
      {
        key: 'tfs',
        header: 'Timeframes',
        sortable: false,
        render: (s) => <ChipSelect compact options={[...DELTA_TIMEFRAMES]} value={s.timeframes ?? []} onChange={(v) => patch(s, { timeframes: v })} emptyLabel="global" disabled={busy} />,
      },
      {
        key: 'exit',
        header: 'Exit',
        value: (s) => s.exitMode,
        render: (s) => (
          <select className="select select-sm" value={s.exitMode} onChange={(e) => patch(s, { exitMode: e.target.value as ExitMode })} aria-label={`Exit mode for ${s.name}`} disabled={busy}>
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
      { key: 'win', header: 'Win%', numeric: true, value: (s) => s.stats?.winRatePct, render: (s) => fmtPct(s.stats?.winRatePct) },
      { key: 'pnl', header: 'PnL', numeric: true, value: (s) => s.stats?.pnl, render: (s) => <Pnl value={s.stats?.pnl} /> },
      { key: 'pf', header: 'PF', numeric: true, value: (s) => s.stats?.profitFactor, render: (s) => fmtProfitFactor(s.stats?.profitFactor) },
      { key: 'bpf', header: 'BT PF', numeric: true, value: (s) => s.stats?.backtest?.profitFactor, render: (s) => <span className="muted">{fmtProfitFactor(s.stats?.backtest?.profitFactor)}</span>, title: 'Backtest profit factor' },
      {
        key: 'actions',
        header: '',
        sortable: false,
        align: 'right',
        render: (s) => (
          <span className="row-actions">
            <button className="btn btn-xs" onClick={() => onHide(s)} disabled={busy} title={s.hidden ? 'Restore to the list' : 'Remove from the list (disables it)'}>
              {s.hidden ? 'Restore' : 'Remove'}
            </button>
            <button className="btn btn-xs" onClick={() => runNow(s)} disabled={s.status !== 'ok' || run.isPending} title="Run now">
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
    [symbolOptions, busy, run.isPending],
  )

  return (
    <div className="page">
      <div className="page-head">
        <PageTitle pre="Every scanner," accent="one" post="terminal." sub={scanners.data ? `${scanners.data.filter((s) => !s.hidden).length} in list · ${enabledCount} enabled · ${hiddenCount} removed` : undefined} />
        <div className="page-actions">
          <button className="btn btn-cta" onClick={() => bulk(true)} disabled={busy || !scanners.data}>
            {bulkBusy ? 'Working…' : 'Enable all runnable'}
          </button>
          <button className="btn" onClick={() => autoTune()} disabled={busy || !scanners.data} title="Keep each scanner only on symbols where its backtest is profitable (≥ 3 trades, PF ≥ 1); disable scanners with none">
            Auto-tune symbols
          </button>
          <button className="btn" onClick={() => setShowHidden((v) => !v)} disabled={!scanners.data} title="Removed scanners stay disabled; restore any from here" aria-pressed={showHidden}>
            {showHidden ? 'Hide removed' : `Show removed (${hiddenCount})`}
          </button>
          <button className="btn btn-danger-outline" onClick={() => setConfirmDisableAll(true)} disabled={busy || !scanners.data || enabledCount === 0}>
            Disable all
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="cat-tabs" role="tablist" aria-label="Category">
          {CATEGORIES.map((c) => (
            <button key={c} role="tab" aria-selected={cat === c} className={`navpill ${cat === c ? 'navpill-on' : ''}`} onClick={() => setCat(c)}>
              {c} {c !== 'All' && counts.get(c) ? <span className="muted">{counts.get(c)}</span> : null}
            </button>
          ))}
        </div>
        <select className="input" value={author} onChange={(e) => setAuthor(e.target.value)} aria-label="Author" style={{ width: 'auto' }}>
          {authors.map((a) => (
            <option key={a} value={a}>
              {a === 'All' ? 'All authors' : a}
            </option>
          ))}
        </select>
        <input className="input" placeholder="Filter scanners…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter scanners" />
        <Segmented
          ariaLabel="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'cards', label: <IconGrid />, ariaLabel: 'Card view' },
            { value: 'table', label: <IconRows />, ariaLabel: 'Table view' },
          ]}
        />
      </div>

      {scanners.isLoading && !scanners.data && (view === 'table' ? <Loading kind="table" rows={10} cols={10} /> : <Loading kind="cards" rows={6} />)}
      {scanners.isError && !scanners.data && <ErrorState error={scanners.error} onRetry={() => scanners.refetch()} />}

      {scanners.data && view === 'table' && (
        <div className="panel">
          <DataTable
            columns={tableCols}
            rows={rows}
            rowKey={(s) => s.id}
            defaultSort={{ key: 'name', dir: 'asc' }}
            caption="Scanners"
            emptyLabel={
              <span>
                No scanners match<span className="empty-hint">Try another category, author or filter.</span>
              </span>
            }
          />
        </div>
      )}

      {scanners.data && view === 'cards' && (
        <div className="cards-2">
          {rows.length === 0 && <Empty label="No scanners match." hint="Try another category, author or filter." />}
          {visibleRows.map((s) => (
            <ScannerCard key={s.id} s={s} onToggle={(v) => patch(s, { enabled: v })} onRun={() => runNow(s)} onHide={() => onHide(s)} busy={busy} runBusy={run.isPending} />
          ))}
        </div>
      )}
      {scanners.data && view === 'cards' && rows.length > visibleRows.length && (
        <div className="more-row">
          <button type="button" className="btn" onClick={() => setShown((n) => n + PAGE)}>
            Show {Math.min(PAGE, rows.length - visibleRows.length)} more
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => setShown(rows.length)}>
            Show all {rows.length}
          </button>
          <span className="muted small mono">
            {visibleRows.length} of {rows.length}
          </span>
        </div>
      )}

      <ConfirmDialog
        open={confirmDisableAll}
        title={`Disable all ${enabledCount} enabled scanner${enabledCount === 1 ? '' : 's'}?`}
        body={<p>Every enabled scanner stops producing signals. Open positions are kept and still managed by the paper engine.</p>}
        confirmLabel="Disable all"
        danger
        busy={bulkBusy}
        onCancel={() => setConfirmDisableAll(false)}
        onConfirm={async () => {
          setConfirmDisableAll(false)
          await bulk(false)
        }}
      />
      <ConfirmDialog
        open={!!removing}
        title={removing ? `Remove ${removing.name}?` : ''}
        body={<p>The scanner is disabled and hidden from the list. You can restore it later via “Show removed”.</p>}
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

function ScannerCard({ s, onToggle, onRun, busy, runBusy, onHide }: { s: Scanner; onToggle: (v: boolean) => void; onRun: () => void; busy: boolean; runBusy: boolean; onHide: () => void }) {
  const st = s.stats
  const tfs = (s.timeframes ?? []).join('/') || 'global'
  return (
    <div className={`card scanner-card ${s.enabled ? 'card-on' : ''}`}>
      <div className="card-head">
        <span className={`dot ${s.enabled ? 'dot-ok' : s.status === 'ok' ? 'dot-neutral' : 'dot-danger'}`} />
        <Link to={`/scanners/${s.id}`} className="card-title">
          {s.name}
        </Link>
        <span className="card-pills">
          <Pill tone="accent">{tfs.toUpperCase()}</Pill>
          <ScannerStatusPill status={s.status} reason={s.reason} />
        </span>
      </div>
      <div className="card-summary mono">
        alerts: LONG/SHORT · SL · TP1-3 · {s.exitMode} · {(s.symbols ?? []).join(',') || 'global symbols'} · {categorize(s.name).toLowerCase()}
      </div>
      {s.status !== 'ok' && s.reason && (
        <div className="small loss" title={s.reason}>
          {s.reason.length > 90 ? `${s.reason.slice(0, 89)}…` : s.reason}
        </div>
      )}
      <div className="card-stats">
        <span className="stat-chip">
          <span className="stat-k">TRADES</span>
          <span className="mono">{st?.trades ?? 0}</span>
        </span>
        <span className="stat-chip">
          <span className="stat-k">WIN</span>
          <span className="mono">{fmtPct(st?.winRatePct)}</span>
        </span>
        <span className="stat-chip">
          <span className="stat-k">PF</span>
          <span className="mono">{fmtProfitFactor(st?.profitFactor)}</span>
        </span>
        <span className="stat-chip">
          <span className="stat-k">PNL</span>
          <Pnl value={st?.pnl} />
        </span>
        <span className="stat-chip" title="Backtest profit factor">
          <span className="stat-k">BT PF</span>
          <span className="mono muted">{fmtProfitFactor(st?.backtest?.profitFactor)}</span>
        </span>
      </div>
      <div className="card-foot">
        <span className="muted small">
          {s.lastRun ? (
            <>
              ran <Time t={s.lastRun.at} mode="ago" /> · {fmtMs(s.lastRun.ms)}
              {s.lastRun.error && <span className="loss"> · error</span>}
            </>
          ) : (
            'never run'
          )}
        </span>
        <span className="row-actions">
          <button className="btn btn-xs" onClick={onHide} disabled={busy} title={s.hidden ? 'Restore to the list' : 'Remove from the list (disables it)'}>
            {s.hidden ? 'Restore' : 'Remove'}
          </button>
          <button className="btn btn-xs" onClick={onRun} disabled={s.status !== 'ok' || runBusy} title="Run now">
            <IconPlay /> Run
          </button>
          <label className="switch" title={s.status !== 'ok' ? `Cannot enable: ${s.reason ?? s.status}` : s.enabled ? 'Enabled' : 'Disabled'}>
            <input type="checkbox" checked={s.enabled} disabled={s.status !== 'ok' || busy} onChange={(e) => onToggle(e.target.checked)} aria-label={`Enable ${s.name}`} />
            <span className="switch-ui" />
          </label>
        </span>
      </div>
    </div>
  )
}
