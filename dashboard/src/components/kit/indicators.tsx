import type { ReactNode } from 'react'
import type { ScannerStatus, Side } from '../../api/types'
import {
  clamp,
  fmtDateTime,
  fmtFullDateTime,
  fmtPnl,
  fmtTime,
  fmtUtc,
  gradeTone,
  isNum,
  pnlClass,
  scoreGrade,
  timeAgo,
} from '../../lib/format'
import { useNow } from '../../lib/useNow'

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

export function StatusDot({
  tone = 'neutral',
  title,
}: {
  tone?: 'ok' | 'warn' | 'danger' | 'neutral' | 'accent'
  title?: string
}) {
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
  const instruction = action === 'exit-requested' || action === 'stop-update-requested'
  const label =
    action === 'exit-requested'
      ? 'exit requested'
      : action === 'stop-update-requested'
        ? 'stop update requested'
        : action
  const tone =
    action === 'opened'
      ? 'ok'
      : action === 'closed' || action === 'reduced' || instruction
        ? 'accent'
        : action.startsWith('rejected')
          ? 'danger'
          : 'muted'
  return (
    <Pill tone={tone} title={action}>
      {!instruction && label.length > 18 ? `${label.slice(0, 17)}…` : label}
    </Pill>
  )
}

export function ExitReasonPill({ reason }: { reason: string | null | undefined }) {
  if (!reason) return <span className="muted">–</span>
  const tone =
    reason.startsWith('tp') || reason === 'trail'
      ? 'ok'
      : reason === 'sl'
        ? 'danger'
        : reason === 'be'
          ? 'muted'
          : reason === 'manual'
            ? 'warn'
            : 'accent'
  return <Pill tone={tone}>{reason}</Pill>
}

export function ScoreBadge({ score }: { score: number | null | undefined }) {
  const grade = scoreGrade(score)
  const pct = isNum(score) ? clamp(score, 0, 100) : 0
  const tone = gradeTone(grade)
  return (
    <span
      className={`score score-${tone}`}
      title={isNum(score) ? `score ${score.toFixed(1)} · grade ${grade}` : 'no score'}
    >
      <span className="score-bar">
        <span className="score-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="score-grade">{grade}</span>
    </span>
  )
}

export function Grade({ score }: { score: number | null | undefined }) {
  const grade = scoreGrade(score)
  return (
    <span
      className={`grade grade-${gradeTone(grade)} mono`}
      title={isNum(score) ? `score ${score.toFixed(1)}` : 'no score'}
    >
      {grade}
    </span>
  )
}

export function Time({
  t,
  mode = 'time',
  className = '',
}: {
  t: number | null | undefined
  mode?: 'time' | 'datetime' | 'full' | 'ago'
  className?: string
}) {
  if (!isNum(t) || t <= 0) return <span className="muted">–</span>
  if (mode === 'ago') return <TimeAgo t={t} className={className} />
  const text = mode === 'datetime' ? fmtDateTime(t) : mode === 'full' ? fmtFullDateTime(t) : fmtTime(t)
  return (
    <time dateTime={new Date(t).toISOString()} title={fmtUtc(t)} className={`mono ${className}`.trim()}>
      {text}
    </time>
  )
}

export function TimeAgo({ t, className = '' }: { t: number; className?: string }) {
  const now = useNow(5000)
  return (
    <time
      dateTime={new Date(t).toISOString()}
      title={`${fmtFullDateTime(t)} local · ${fmtUtc(t)}`}
      className={className}
    >
      {timeAgo(t, now)}
    </time>
  )
}

export function Pnl({
  value,
  decimals = 2,
  suffix = '',
}: {
  value: number | null | undefined
  decimals?: number
  suffix?: string
}) {
  return (
    <span className={`mono ${pnlClass(value)}`}>
      {fmtPnl(value, decimals)}
      {isNum(value) ? suffix : ''}
    </span>
  )
}
