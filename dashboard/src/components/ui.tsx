import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { ApiError } from '../api/client'
import type { ScannerStatus, Side } from '../api/types'
import { clamp, fmtPnl, isNum, pnlClass, scoreGrade } from '../lib/format'

// ---------- Pills / dots ----------

export function Pill({
  children,
  tone = 'neutral',
  title,
  className = '',
}: {
  children: ReactNode
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' | 'muted'
  title?: string
  className?: string
}) {
  return (
    <span className={`pill pill-${tone} ${className}`} title={title}>
      {children}
    </span>
  )
}

export function StatusDot({ tone = 'neutral', title }: { tone?: 'ok' | 'warn' | 'danger' | 'neutral' | 'accent'; title?: string }) {
  return <span className={`dot dot-${tone}`} title={title} aria-hidden />
}

export function ScannerStatusPill({ status, reason }: { status: ScannerStatus; reason?: string | null }) {
  const tone = status === 'ok' ? 'ok' : status === 'incompatible' ? 'danger' : 'warn'
  return (
    <Pill tone={tone} title={reason ?? undefined}>
      {status.toUpperCase()}
    </Pill>
  )
}

export function SidePill({ side }: { side: Side | null | undefined }) {
  if (!side) return <span className="muted">–</span>
  return <span className={`side side-${side}`}>{side.toUpperCase()}</span>
}

export function ActionPill({ action }: { action: string | null | undefined }) {
  if (!action) return <span className="muted">–</span>
  const tone = action === 'opened' ? 'ok' : action === 'closed' || action === 'reduced' ? 'accent' : action.startsWith('rejected') ? 'danger' : 'muted'
  return (
    <Pill tone={tone} title={action}>
      {action.length > 18 ? `${action.slice(0, 17)}…` : action}
    </Pill>
  )
}

export function ExitReasonPill({ reason }: { reason: string | null | undefined }) {
  if (!reason) return <span className="muted">–</span>
  const tone =
    reason.startsWith('tp') ? 'ok' : reason === 'sl' ? 'danger' : reason === 'be' ? 'muted' : reason === 'manual' ? 'warn' : 'accent'
  return <Pill tone={tone}>{reason}</Pill>
}

/** Score as a small colored bar + grade letter (A+/A/B/C). */
export function ScoreBadge({ score }: { score: number | null | undefined }) {
  const grade = scoreGrade(score)
  const pct = isNum(score) ? clamp(score, 0, 100) : 0
  const tone = grade === 'A+' || grade === 'A' ? 'ok' : grade === 'B' ? 'accent' : grade === 'C' ? 'warn' : 'muted'
  return (
    <span className={`score score-${tone}`} title={isNum(score) ? `score ${score.toFixed(1)}` : 'no score'}>
      <span className="score-bar">
        <span className="score-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="score-grade">{grade}</span>
    </span>
  )
}

export function Pnl({ value, decimals = 2, suffix = '' }: { value: number | null | undefined; decimals?: number; suffix?: string }) {
  return (
    <span className={`mono ${pnlClass(value)}`}>
      {fmtPnl(value, decimals)}
      {isNum(value) ? suffix : ''}
    </span>
  )
}

// ---------- KPI tile ----------

export function KpiTile({
  label,
  value,
  sub,
  tone,
  hint,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'gain' | 'loss' | 'neutral' | 'accent'
  hint?: string
}) {
  return (
    <div className="kpi" title={hint}>
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value mono ${tone ?? ''}`}>{value}</div>
      {sub !== undefined && <div className="kpi-sub">{sub}</div>}
    </div>
  )
}

// ---------- States ----------

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state">
      <span className="spinner" /> {label}
    </div>
  )
}

export function Empty({ label = 'Nothing here yet.', children }: { label?: string; children?: ReactNode }) {
  return (
    <div className="state muted">
      {label}
      {children}
    </div>
  )
}

export function ErrorState({ error, label = 'Failed to load', onRetry }: { error?: ApiError | Error | null; label?: string; onRetry?: () => void }) {
  return (
    <div className="state error">
      <div>
        {label}
        {error ? <span className="muted"> — {error.message}</span> : null}
      </div>
      {onRetry && (
        <button className="btn btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  )
}

/** Renders loading/error/empty or children depending on the query state. */
export function QueryState<T>({
  isLoading,
  isError,
  error,
  data,
  empty,
  onRetry,
  children,
}: {
  isLoading: boolean
  isError: boolean
  error?: ApiError | Error | null
  data: T | undefined
  empty?: string
  onRetry?: () => void
  children: (data: T) => ReactNode
}) {
  if (isLoading && data === undefined) return <Loading />
  if (isError && data === undefined) return <ErrorState error={error} onRetry={onRetry} />
  if (data === undefined) return <Empty label={empty} />
  if (Array.isArray(data) && data.length === 0) return <Empty label={empty} />
  return <>{children(data)}</>
}

// ---------- Panel / card ----------

export function Panel({
  title,
  right,
  children,
  className = '',
  pad = true,
}: {
  title?: ReactNode
  right?: ReactNode
  children: ReactNode
  className?: string
  pad?: boolean
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || right) && (
        <header className="panel-head">
          <div className="panel-title">{title}</div>
          <div className="panel-right">{right}</div>
        </header>
      )}
      <div className={pad ? 'panel-body' : 'panel-body nopad'}>{children}</div>
    </section>
  )
}

// ---------- Confirm dialog ----------

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  body?: ReactNode
  confirmLabel?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} className="dialog" onClose={onCancel} onCancel={onCancel}>
      <h3>{title}</h3>
      {body && <div className="dialog-body">{body}</div>}
      <div className="dialog-actions">
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} disabled={busy}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </dialog>
  )
}

// ---------- Chip multi-select ----------

export function ChipSelect({
  options,
  value,
  onChange,
  label,
  emptyLabel = 'inherit',
  disabled,
  compact,
}: {
  options: string[]
  value: string[]
  onChange: (next: string[]) => void
  label?: string
  emptyLabel?: string
  disabled?: boolean
  compact?: boolean
}) {
  const id = useId()
  const toggle = (o: string) => {
    if (disabled) return
    onChange(value.includes(o) ? value.filter((v) => v !== o) : [...value, o])
  }
  return (
    <div className={`chips ${compact ? 'chips-compact' : ''}`} role="group" aria-labelledby={label ? id : undefined}>
      {label && (
        <span id={id} className="chips-label">
          {label}
        </span>
      )}
      {options.map((o) => (
        <button
          key={o}
          type="button"
          className={`chip ${value.includes(o) ? 'chip-on' : ''}`}
          aria-pressed={value.includes(o)}
          onClick={() => toggle(o)}
          disabled={disabled}
        >
          {o}
        </button>
      ))}
      {value.length === 0 && <span className="muted small">{emptyLabel}</span>}
    </div>
  )
}

// ---------- Segmented tabs ----------

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly { value: T; label: ReactNode }[] | readonly T[]
  value: T
  onChange: (v: T) => void
  ariaLabel?: string
}) {
  const opts = (options as readonly (T | { value: T; label: ReactNode })[]).map((o) =>
    typeof o === 'string' ? { value: o, label: o } : o,
  )
  return (
    <div className="segmented" role="tablist" aria-label={ariaLabel}>
      {opts.map((o) => (
        <button
          key={o.value}
          role="tab"
          type="button"
          aria-selected={o.value === value}
          className={`seg ${o.value === value ? 'seg-on' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ---------- Collapsible ----------

export function Collapsible({ title, children, defaultOpen = false, right }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; right?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="panel">
      <header className="panel-head clickable" onClick={() => setOpen((o) => !o)}>
        <button className="panel-title as-button" aria-expanded={open}>
          <span className={`caret ${open ? 'caret-open' : ''}`}>▸</span> {title}
        </button>
        <div className="panel-right" onClick={(e) => e.stopPropagation()}>
          {right}
        </div>
      </header>
      {open && <div className="panel-body">{children}</div>}
    </section>
  )
}

/** Hero-style page title with one italic serif accent word. */
export function PageTitle({ pre, accent, post, sub }: { pre: string; accent: string; post?: string; sub?: ReactNode }) {
  return (
    <div className="page-title">
      <h1>
        {pre} <em>{accent}</em>
        {post ? ` ${post}` : ''}
      </h1>
      {sub && <p className="page-sub">{sub}</p>}
    </div>
  )
}

// ---------- Symbol picker (selected chips + searchable add) ----------

export function SymbolPicker({
  options,
  value,
  onChange,
  placeholder = 'add symbol…',
  disabled,
}: {
  options: string[]
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  disabled?: boolean
}) {
  const id = useId()
  const [text, setText] = useState('')
  const add = (raw: string) => {
    const v = raw.trim().toUpperCase()
    if (!v) return
    if (!value.includes(v)) onChange([...value, v])
    setText('')
  }
  const remove = (v: string) => onChange(value.filter((x) => x !== v))
  const suggestions = options.filter((o) => !value.includes(o)).slice(0, 200)
  return (
    <div className="chips" role="group">
      {value.map((v) => (
        <button key={v} type="button" className="chip chip-on" onClick={() => remove(v)} disabled={disabled} title="Remove" aria-label={`Remove ${v}`}>
          {v} ×
        </button>
      ))}
      <input
        className="input input-sm mono"
        list={id}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        aria-label="Add symbol"
        onChange={(e) => {
          const v = e.target.value
          // datalist pick fires a change with the full option value
          if (options.includes(v.toUpperCase())) add(v)
          else setText(v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add(text)
          }
        }}
        onBlur={() => text && add(text)}
      />
      <datalist id={id}>
        {suggestions.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      {value.length === 0 && <span className="muted small">none</span>}
    </div>
  )
}
