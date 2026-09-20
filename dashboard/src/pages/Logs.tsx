import { useEffect, useMemo, useRef, useState } from 'react'
import { useLogs } from '../api/queries'
import type { LogEntry, LogLevel } from '../api/types'
import { ErrorState, Loading, PageTitle, Panel, Segmented } from '../components/ui'
import { fmtTime } from '../lib/format'

const LEVELS: ('all' | LogLevel)[] = ['all', 'debug', 'info', 'warn', 'error']
const SEV: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export function Logs() {
  const [level, setLevel] = useState<'all' | LogLevel>('all')
  const [scope, setScope] = useState('')
  const [text, setText] = useState('')
  const [auto, setAuto] = useState(true)
  const logs = useLogs(level === 'all' ? undefined : level, 400)
  const boxRef = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => {
    const t = text.trim().toLowerCase()
    return (logs.data ?? [])
      .filter((l) => level === 'all' || SEV[l.level] >= SEV[level])
      .filter((l) => !scope || l.scope === scope)
      .filter((l) => !t || l.msg.toLowerCase().includes(t) || JSON.stringify(l.data ?? '').toLowerCase().includes(t))
  }, [logs.data, level, scope, text])

  const scopes = useMemo(() => Array.from(new Set((logs.data ?? []).map((l) => l.scope))).sort(), [logs.data])

  useEffect(() => {
    if (auto && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [rows, auto])

  return (
    <div className="page">
      <PageTitle pre="Every line," accent="traced." sub="Tail of /api/logs plus live `log` events." />
      <Panel
        title={
          <span>
            Logs <span className="muted small">({rows.length})</span>
          </span>
        }
        right={
          <div className="row gap filters">
            <Segmented ariaLabel="Level" value={level} onChange={setLevel} options={LEVELS} />
            <select className="select select-sm" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Scope">
              <option value="">all scopes</option>
              {scopes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <input className="input input-sm" placeholder="search…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search logs" />
            <label className="check">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto-scroll
            </label>
          </div>
        }
        pad={false}
      >
        {logs.isLoading && !logs.data && <Loading label="Loading logs…" />}
        {logs.isError && !logs.data && <ErrorState error={logs.error} onRetry={() => logs.refetch()} />}
        {logs.data && (
          <div className="logbox" ref={boxRef} onScroll={(e) => {
            const el = e.currentTarget
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8
            if (!atBottom && auto) setAuto(false)
          }}>
            {rows.length === 0 && <div className="muted small pad">No log lines.</div>}
            {rows.map((l, i) => (
              <LogLine key={`${l.at}-${i}`} l={l} />
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}

function LogLine({ l }: { l: LogEntry }) {
  const [open, setOpen] = useState(false)
  const hasData = l.data !== undefined && l.data !== null
  return (
    <div className={`logline lvl-${l.level}`} onClick={hasData ? () => setOpen((o) => !o) : undefined} role={hasData ? 'button' : undefined}>
      <span className="log-time">{fmtTime(l.at)}</span>
      <span className={`log-level`}>{l.level.toUpperCase().padEnd(5)}</span>
      <span className="log-scope">{l.scope}</span>
      <span className="log-msg">
        {l.msg}
        {hasData && !open && <span className="muted"> {'{…}'}</span>}
      </span>
      {open && hasData && <pre className="log-data">{JSON.stringify(l.data, null, 2)}</pre>}
    </div>
  )
}
