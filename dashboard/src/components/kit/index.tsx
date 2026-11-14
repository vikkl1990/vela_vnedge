import { useId, useRef, type ReactNode } from 'react'

/**
 * The page-level building blocks every screen is composed from. Presentation only: no data fetching, no routing
 * decisions. Styling lives in styles/kit.css.
 */

// ---------- PageHeader ----------

/** Title, one plain sentence of context, optional chips and actions, optional tabs underneath. */
export function PageHeader({ title, subtitle, meta, actions, tabs }: { title: ReactNode; subtitle?: ReactNode; meta?: ReactNode; actions?: ReactNode; tabs?: ReactNode }) {
  return (
    <header className="ph">
      <div className="ph-row">
        <div className="ph-main">
          <h1 className="ph-title">{title}</h1>
          {meta && <div className="ph-meta">{meta}</div>}
        </div>
        {actions && <div className="ph-actions">{actions}</div>}
      </div>
      {subtitle && <p className="ph-sub">{subtitle}</p>}
      {tabs && <div className="ph-tabs">{tabs}</div>}
    </header>
  )
}

// ---------- Tabs ----------

export interface TabItem<T extends string> {
  id: T
  label: ReactNode
  /** a count or short value after the label */
  count?: ReactNode
  /** a small warning dot, e.g. "something in here needs you" */
  attention?: boolean
}

/** A WAI-ARIA tablist: arrow keys move between tabs, Home/End jump. The caller renders the panel for `value`. */
export function Tabs<T extends string>({ value, onChange, items, label, idPrefix }: { value: T; onChange: (v: T) => void; items: Array<TabItem<T>>; label: string; idPrefix?: string }) {
  const auto = useId()
  const prefix = idPrefix ?? auto
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = items.findIndex((t) => t.id === value)
    let next = -1
    if (e.key === 'ArrowRight') next = (i + 1) % items.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + items.length) % items.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    if (next < 0) return
    e.preventDefault()
    onChange(items[next].id)
    refs.current[items[next].id]?.focus()
  }
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((t) => (
        <button
          key={t.id}
          ref={(el) => { refs.current[t.id] = el }}
          type="button"
          role="tab"
          id={`${prefix}-tab-${t.id}`}
          aria-selected={t.id === value}
          aria-controls={`${prefix}-panel-${t.id}`}
          tabIndex={t.id === value ? 0 : -1}
          className={`tab ${t.id === value ? 'on' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count !== undefined && <span className="tab-count mono">{t.count}</span>}
          {t.attention && <span className="tab-dot" aria-label="needs attention" />}
        </button>
      ))}
    </div>
  )
}

/** The panel a tab controls; give it the same `idPrefix` as its Tabs. */
export function TabPanel({ id, value, idPrefix, children }: { id: string; value: string; idPrefix: string; children: ReactNode }) {
  if (id !== value) return null
  return <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`} tabIndex={0} className="tabpanel">{children}</div>
}

// ---------- Callout ----------

/** A message that earns its space: what is wrong or notable, in a sentence, with what to do about it. */
export function Callout({ tone = 'info', title, children, actions }: { tone?: 'info' | 'ok' | 'warn' | 'danger'; title?: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`callout callout-${tone}`} role={tone === 'danger' ? 'alert' : 'note'}>
      <span className="callout-bar" aria-hidden />
      <div className="callout-body">
        {title && <b className="callout-title">{title}</b>}
        {children && <span className="callout-text">{children}</span>}
      </div>
      {actions && <div className="callout-actions">{actions}</div>}
    </div>
  )
}

// ---------- Stat ----------

/** A number with its label and one line of context; optionally a sparkline. The headline tile of a page. */
export function Stat({ label, value, sub, tone, spark, title }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'gain' | 'loss' | 'warn' | 'accent' | 'muted'; spark?: number[]; title?: string }) {
  return (
    <div className="stat" title={title}>
      <span className="stat-label">{label}</span>
      <span className={`stat-value mono ${tone ? `tone-${tone}` : ''}`}>{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
      {spark && spark.length > 1 && <Sparkline values={spark} tone={tone} />}
    </div>
  )
}

export function StatGrid({ children, min = 220 }: { children: ReactNode; min?: number }) {
  return <div className="stat-grid" style={{ ['--stat-min' as string]: `${min}px` }}>{children}</div>
}

// ---------- Sparkline ----------

/** A 120×28 area line, no axes. Decorative: the number beside it carries the meaning. */
export function Sparkline({ values, tone }: { values: number[]; tone?: 'gain' | 'loss' | 'warn' | 'accent' | 'muted' }) {
  const w = 120, h = 28, pad = 2
  const min = Math.min(...values), max = Math.max(...values)
  const span = max - min || 1
  const pts = values.map((v, i) => [pad + (i / (values.length - 1)) * (w - pad * 2), h - pad - ((v - min) / span) * (h - pad * 2)] as const)
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z`
  return (
    <svg className={`spark ${tone ? `tone-${tone}` : ''}`} viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="presentation" aria-hidden preserveAspectRatio="none">
      <path className="spark-area" d={area} />
      <path className="spark-line" d={line} />
    </svg>
  )
}

// ---------- EmptyState ----------

/** Nothing here, why, and what to do next. */
export function EmptyState({ title, hint, action, icon }: { title: ReactNode; hint?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon && <span className="empty-icon" aria-hidden>{icon}</span>}
      <b className="empty-title">{title}</b>
      {hint && <span className="empty-hint">{hint}</span>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  )
}

// ---------- Section ----------

/** A titled block of a page: label, optional one-line explanation, optional actions on the right. */
export function Section({ title, hint, actions, children }: { title: ReactNode; hint?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <div className="section-titles">
          <h2 className="section-title">{title}</h2>
          {hint && <span className="section-hint">{hint}</span>}
        </div>
        {actions && <div className="section-actions">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

/** A horizontal row of filters and controls above a table or grid. */
export function Toolbar({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="toolbar-row" role="toolbar">
      <div className="toolbar-main">{children}</div>
      {end && <div className="toolbar-end">{end}</div>}
    </div>
  )
}
