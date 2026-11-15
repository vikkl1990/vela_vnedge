import { useEffect, useId, useRef, type ReactNode } from 'react'
import type { ApiError } from '../../api/client'
import { CardsSkeleton, ChartSkeleton, KpiSkeleton, SkeletonLines, TableSkeleton } from '../Skeleton'
import { EmptyState } from './primitives'

export type SkeletonKind = 'lines' | 'table' | 'kpi' | 'chart' | 'cards'

export function Loading({
  kind = 'lines',
  rows,
  cols,
  height,
  label,
}: {
  kind?: SkeletonKind
  rows?: number
  cols?: number
  height?: number
  label?: string
}) {
  void label
  switch (kind) {
    case 'table':
      return <TableSkeleton rows={rows ?? 6} cols={cols ?? 6} />
    case 'kpi':
      return <KpiSkeleton count={rows ?? 8} />
    case 'chart':
      return <ChartSkeleton height={height ?? 220} />
    case 'cards':
      return <CardsSkeleton count={rows ?? 4} />
    default:
      return <SkeletonLines lines={rows ?? 3} />
  }
}

export function ErrorState({
  error,
  label = 'Failed to load',
  onRetry,
}: {
  error?: ApiError | Error | null
  label?: string
  onRetry?: () => void
}) {
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

export function QueryState<T>({
  isLoading,
  isError,
  error,
  data,
  empty,
  hint,
  skeleton = 'lines',
  skeletonRows,
  skeletonCols,
  skeletonHeight,
  onRetry,
  children,
}: {
  isLoading: boolean
  isError: boolean
  error?: ApiError | Error | null
  data: T | undefined
  empty?: string
  hint?: string
  skeleton?: SkeletonKind
  skeletonRows?: number
  skeletonCols?: number
  skeletonHeight?: number
  onRetry?: () => void
  children: (data: T) => ReactNode
}) {
  if (isLoading && data === undefined)
    return <Loading kind={skeleton} rows={skeletonRows} cols={skeletonCols} height={skeletonHeight} />
  if (isError && data === undefined) return <ErrorState error={error} onRetry={onRetry} />
  if (data === undefined) return <EmptyState title={empty} hint={hint} />
  if (Array.isArray(data) && data.length === 0) return <EmptyState title={empty} hint={hint} />
  return (
    <>
      {isError && (
        <div role="alert" className="banner banner-warn small">
          Refresh failed; showing previously loaded data.{' '}
          <button className="btn btn-sm" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
      {children(data)}
    </>
  )
}

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
  const titleId = useId()
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      onClose={() => {
        if (!busy) onCancel()
      }}
      onCancel={(e) => {
        if (busy) e.preventDefault()
        else onCancel()
      }}
    >
      <h3 id={titleId}>{title}</h3>
      {body && <div className="dialog-body">{body}</div>}
      <div className="dialog-actions">
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
