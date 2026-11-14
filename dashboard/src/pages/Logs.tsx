import { memo, useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { useLogs } from '../api/queries'
import type { LogEntry, LogLevel } from '../api/types'
import { WindowedList } from '../components/WindowedList'
import { ErrorState, Loading, Panel, Segmented } from '../components/ui'
import { EmptyState, PageHeader, Toolbar } from '../components/kit'
import '../styles/pages/logs.css'
import { fmtTime, fmtUtc } from '../lib/format'

const LEVELS: ('all' | LogLevel)[] = ['all', 'debug', 'info', 'warn', 'error']
const SEV: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** Fixed line height so the windowed list can position rows without measuring. */
const ROW_H = 22
const DETAIL_LINE_H = 16
const DETAIL_MAX_H = 240

function detailText(l: LogEntry): string {
  const data = l.data !== undefined && l.data !== null ? JSON.stringify(l.data, null, 2) : ''
  return data ? `${l.msg}\n${data}` : l.msg
}
function detailHeight(l: LogEntry): number {
  const lines = detailText(l).split('\n').length
  return Math.min(DETAIL_MAX_H, 12 + lines * DETAIL_LINE_H)
}

export function Logs() {
  const [level, setLevel] = useState<'all' | LogLevel>('all')
  const [scope, setScope] = useState('')
  const [text, setText] = useState('')
  const [auto, setAuto] = useState(true)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const logs = useLogs(level === 'all' ? undefined : level, 400)
  const boxRef = useRef<HTMLDivElement | null>(null)

  const rows = useMemo(() => {
    const t = text.trim().toLowerCase()
    return (logs.data ?? [])
      .filter((l) => level === 'all' || SEV[l.level] >= SEV[level])
      .filter((l) => !scope || l.scope === scope)
      .filter((l) => !t || l.msg.toLowerCase().includes(t) || JSON.stringify(l.data ?? '').toLowerCase().includes(t))
  }, [logs.data, level, scope, text])

  const scopes = useMemo(() => Array.from(new Set((logs.data ?? []).map((l) => l.scope))).sort(), [logs.data])

  const keyOf = useCallback((l: LogEntry, i: number) => `${l.at}-${i}`, [])
  const itemHeight = useCallback((l: LogEntry, i: number) => ROW_H + (open.has(keyOf(l, i)) ? detailHeight(l) + 6 : 0), [open, keyOf])
  const toggle = useCallback((k: string) => {
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  }, [])

  useEffect(() => {
    if (auto && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [rows, auto])

  const onScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8
      if (!atBottom && auto) setAuto(false)
    },
    [auto],
  )
  const setBox = useCallback((el: HTMLDivElement | null) => {
    boxRef.current = el
  }, [])

  const filtered = level !== 'all' || scope !== '' || text.trim() !== ''
  const clearFilters = () => { setLevel('all'); setScope(''); setText('') }

  return (
    <div className="page logs-page">
      <PageHeader title="Logs" subtitle="The newest 400 lines, plus live events as they arrive. Click a line to open its details." />
      <Toolbar end={<span className="muted small mono" role="status">{rows.length} line{rows.length === 1 ? '' : 's'}{filtered ? ' match' : ''}</span>}>
        <Segmented ariaLabel="Level" value={level} onChange={setLevel} options={LEVELS} />
        <select className="select select-sm" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Scope">
          <option value="">all scopes</option>
          {scopes.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input className="input input-sm logs-search" type="search" placeholder="Search messages and data" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search logs" />
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Follow newest
        </label>
        {filtered && <button className="btn btn-sm" onClick={clearFilters}>Clear filters</button>}
      </Toolbar>
      <Panel title="Log tail" pad={false}>
        {logs.isLoading && !logs.data && (
          <div className="logbox">
            <Loading rows={12} />
          </div>
        )}
        {logs.isError && !logs.data && <ErrorState error={logs.error} onRetry={() => logs.refetch()} />}
        {logs.data && (
          <WindowedList
            className="logbox"
            height="max(320px, calc(100vh - 330px))"
            items={rows}
            itemKey={keyOf}
            itemHeight={itemHeight}
            scrollRef={setBox}
            onScroll={onScroll}
            empty={
              <EmptyState
                title={filtered ? 'No log lines match' : 'No log lines yet'}
                hint={filtered ? 'Loosen the level, scope or search, or wait for new events.' : 'Lines appear here as the server writes them.'}
                action={filtered ? <button className="btn btn-sm" onClick={clearFilters}>Clear filters</button> : undefined}
              />
            }
            render={(l, i) => {
              const k = keyOf(l, i)
              return <LogLine l={l} open={open.has(k)} onToggle={() => toggle(k)} />
            }}
          />
        )}
      </Panel>
    </div>
  )
}

const LogLine = memo(function LogLine({ l, open, onToggle }: { l: LogEntry; open: boolean; onToggle: () => void }) {
  const hasData = l.data !== undefined && l.data !== null
  return (
    <div
      className={`logline lvl-${l.level} ${open ? 'logline-open' : ''}`}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onToggle()
        }
      }}
    >
      <time className="log-time" dateTime={new Date(l.at).toISOString()} title={fmtUtc(l.at)}>
        {fmtTime(l.at)}
      </time>
      <span className="log-level">{l.level.toUpperCase().padEnd(5)}</span>
      <span className="log-scope">{l.scope}</span>
      <span className="log-msg" title={l.msg}>
        {l.msg}
        {hasData && !open && <span className="muted"> {'{…}'}</span>}
      </span>
      {open && (
        <pre className="log-data" style={{ height: detailHeight(l) }}>
          {detailText(l)}
        </pre>
      )}
    </div>
  )
})
