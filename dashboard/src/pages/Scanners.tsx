import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useConfig, useMarkets, useRunScanner, useScanners, useUpdateScanner } from '../api/queries'
import type { ExitMode, Scanner } from '../api/types'
import { DataTable, type Column } from '../components/DataTable'
import { IconExternal, IconGrid, IconPlay, IconRows } from '../components/Icons'
import { ChipSelect, ErrorState, Loading, PageTitle, Pill, Pnl, ScannerStatusPill, Segmented } from '../components/ui'
import { CATEGORIES, categorize, type Category } from '../lib/categories'
import { fmtMs, fmtNum, fmtPct, timeAgo } from '../lib/format'
import { DELTA_TIMEFRAMES } from '../lib/timeframes'
import { useToast } from '../lib/toast'
import { useNow } from '../lib/useNow'

const EXIT_MODES: ExitMode[] = ['levels', 'script', 'both']

export function Scanners() {
  const scanners = useScanners()
  const config = useConfig()
  const markets = useMarkets()
  const update = useUpdateScanner()
  const run = useRunScanner()
  const toast = useToast()
  const now = useNow(10_000)
  const [view, setView] = useState<'cards' | 'table'>('cards')
  const [cat, setCat] = useState<Category>('All')
  const [filter, setFilter] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)

  // Inline chips offer the globally configured symbols plus anything a scanner already uses
  // (the full market list is hundreds of symbols — edit the global list on Settings).
  const symbolOptions = useMemo(() => {
    const set = new Set<string>(config.data?.symbols ?? [])
    for (const s of scanners.data ?? []) for (const x of s.symbols ?? []) set.add(x)
    if (set.size === 0) for (const m of (markets.data ?? []).slice(0, 8)) set.add(m.symbol)
    return Array.from(set)
  }, [config.data, markets.data, scanners.data])

  const rows = useMemo(() => {
    const list = scanners.data ?? []
    const f = filter.trim().toLowerCase()
    return list.filter((s) => (cat === 'All' || categorize(s.name) === cat) && (!f || s.name.toLowerCase().includes(f) || s.id.includes(f)))
  }, [scanners.data, cat, filter])

  const counts = useMemo(() => {
    const c = new Map<Category, number>()
    for (const s of scanners.data ?? []) c.set(categorize(s.name), (c.get(categorize(s.name)) ?? 0) + 1)
    return c
  }, [scanners.data])

  const patch = (s: Scanner, body: Parameters<typeof update.mutate>[0]['body']) =>
    update.mutate(
      { id: s.id, body },
      { onError: (e) => toast.error(`Update failed: ${s.name}`, e.message) },
    )

  const runNow = (s: Scanner) =>
    run.mutate(s.id, {
      onSuccess: (r) => toast.success(`Queued ${s.name}`, `${r.queued} run(s)`),
      onError: (e) => toast.error(`Run failed: ${s.name}`, e.message),
    })

  const bulk = async (enabled: boolean) => {
    const list = (scanners.data ?? []).filter((s) => (enabled ? s.status === 'ok' && !s.enabled : s.enabled))
    if (!list.length) return toast.info('Nothing to change')
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

  const tableCols: Column<Scanner>[] = [
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
            <a href={s.url} target="_blank" rel="noreferrer" className="link muted" title="Open on TradingView">
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
        <label className="switch" title={s.status !== 'ok' ? `Cannot enable: ${s.reason ?? s.status}` : ''}>
          <input type="checkbox" checked={s.enabled} disabled={s.status !== 'ok' || update.isPending} onChange={(e) => patch(s, { enabled: e.target.checked })} />
          <span className="switch-ui" />
        </label>
      ),
    },
    {
      key: 'symbols',
      header: 'Symbols',
      sortable: false,
      render: (s) => <ChipSelect compact options={symbolOptions} value={s.symbols ?? []} onChange={(v) => patch(s, { symbols: v })} emptyLabel="global" />,
    },
    {
      key: 'tfs',
      header: 'Timeframes',
      sortable: false,
      render: (s) => <ChipSelect compact options={[...DELTA_TIMEFRAMES]} value={s.timeframes ?? []} onChange={(v) => patch(s, { timeframes: v })} emptyLabel="global" />,
    },
    {
      key: 'exit',
      header: 'Exit',
      value: (s) => s.exitMode,
      render: (s) => (
        <select className="select select-sm" value={s.exitMode} onChange={(e) => patch(s, { exitMode: e.target.value as ExitMode })} aria-label="Exit mode">
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
            {timeAgo(s.lastRun.at, now)} <span className="mono muted">{fmtMs(s.lastRun.ms)}</span>
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
    { key: 'signals', header: 'Sig', align: 'right', value: (s) => s.stats?.signals, render: (s) => <span className="mono">{s.stats?.signals ?? 0}</span> },
    { key: 'trades', header: 'Trd', align: 'right', value: (s) => s.stats?.trades, render: (s) => <span className="mono">{s.stats?.trades ?? 0}</span> },
    { key: 'win', header: 'Win%', align: 'right', value: (s) => s.stats?.winRatePct, render: (s) => <span className="mono">{fmtPct(s.stats?.winRatePct, 0)}</span> },
    { key: 'pnl', header: 'PnL', align: 'right', value: (s) => s.stats?.pnl, render: (s) => <Pnl value={s.stats?.pnl} /> },
    { key: 'pf', header: 'PF', align: 'right', value: (s) => s.stats?.profitFactor, render: (s) => <span className="mono">{fmtNum(s.stats?.profitFactor)}</span> },
    { key: 'bpf', header: 'BT PF', align: 'right', value: (s) => s.stats?.backtest?.profitFactor, render: (s) => <span className="mono muted">{fmtNum(s.stats?.backtest?.profitFactor)}</span> },
    {
      key: 'actions',
      header: '',
      sortable: false,
      align: 'right',
      render: (s) => (
        <span className="row-actions">
          <button className="btn btn-xs" onClick={() => runNow(s)} disabled={s.status !== 'ok' || run.isPending} title="Run now">
            <IconPlay /> Run
          </button>
          <Link to={`/scanners/${s.id}`} className="btn btn-xs">
            View
          </Link>
        </span>
      ),
    },
  ]

  return (
    <div className="page">
      <div className="page-head">
        <PageTitle pre="Every scanner," accent="one" post="terminal." sub={scanners.data ? `${scanners.data.length} scripts · ${scanners.data.filter((s) => s.status === 'ok').length} runnable · ${scanners.data.filter((s) => s.enabled).length} enabled` : undefined} />
        <div className="page-actions">
          <button className="btn btn-cta" onClick={() => bulk(true)} disabled={bulkBusy || !scanners.data}>
            {bulkBusy ? 'Working…' : 'Enable all runnable'}
          </button>
          <button className="btn" onClick={() => bulk(false)} disabled={bulkBusy || !scanners.data}>
            Disable all
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="cat-tabs" role="tablist">
          {CATEGORIES.map((c) => (
            <button key={c} role="tab" aria-selected={cat === c} className={`navpill ${cat === c ? 'navpill-on' : ''}`} onClick={() => setCat(c)}>
              {c} {c !== 'All' && counts.get(c) ? <span className="muted">{counts.get(c)}</span> : null}
            </button>
          ))}
        </div>
        <input className="input" placeholder="Filter scanners…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter scanners" />
        <Segmented
          ariaLabel="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'cards', label: <IconGrid /> },
            { value: 'table', label: <IconRows /> },
          ]}
        />
      </div>

      {scanners.isLoading && !scanners.data && <Loading label="Loading scanners…" />}
      {scanners.isError && !scanners.data && <ErrorState error={scanners.error} onRetry={() => scanners.refetch()} />}

      {scanners.data && view === 'table' && (
        <div className="panel">
          <DataTable columns={tableCols} rows={rows} rowKey={(s) => s.id} defaultSort={{ key: 'name', dir: 'asc' }} emptyLabel="No scanners match" />
        </div>
      )}

      {scanners.data && view === 'cards' && (
        <div className="cards-2">
          {rows.length === 0 && <div className="state muted">No scanners match.</div>}
          {rows.map((s) => (
            <ScannerCard key={s.id} s={s} now={now} onToggle={(v) => patch(s, { enabled: v })} onRun={() => runNow(s)} busy={update.isPending} />
          ))}
        </div>
      )}
    </div>
  )
}

function ScannerCard({ s, now, onToggle, onRun, busy }: { s: Scanner; now: number; onToggle: (v: boolean) => void; onRun: () => void; busy: boolean }) {
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
          <span className="mono">{fmtPct(st?.winRatePct, 0)}</span>
        </span>
        <span className="stat-chip">
          <span className="stat-k">PF</span>
          <span className="mono">{fmtNum(st?.profitFactor)}</span>
        </span>
        <span className="stat-chip">
          <span className="stat-k">PNL</span>
          <Pnl value={st?.pnl} />
        </span>
        <span className="stat-chip">
          <span className="stat-k">BT PF</span>
          <span className="mono muted">{fmtNum(st?.backtest?.profitFactor)}</span>
        </span>
      </div>
      <div className="card-foot">
        <span className="muted small">
          {s.lastRun ? (
            <>
              ran {timeAgo(s.lastRun.at, now)} · {fmtMs(s.lastRun.ms)}
              {s.lastRun.error && <span className="loss"> · error</span>}
            </>
          ) : (
            'never run'
          )}
        </span>
        <span className="row-actions">
          <button className="btn btn-xs" onClick={onRun} disabled={s.status !== 'ok'} title="Run now">
            <IconPlay /> Run
          </button>
          <label className="switch" title={s.status !== 'ok' ? `Cannot enable: ${s.reason ?? s.status}` : 'Enabled'}>
            <input type="checkbox" checked={s.enabled} disabled={s.status !== 'ok' || busy} onChange={(e) => onToggle(e.target.checked)} />
            <span className="switch-ui" />
          </label>
        </span>
      </div>
    </div>
  )
}
