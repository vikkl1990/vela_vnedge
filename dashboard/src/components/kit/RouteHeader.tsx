import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { routeMeta } from '../shell/navModel'
import { PageHeader } from './primitives'

export function RouteHeader({
  pre,
  accent,
  post,
  sub,
  title,
  actions,
}: {
  pre?: string
  accent?: string
  post?: string
  sub?: ReactNode
  title?: ReactNode
  actions?: ReactNode
}) {
  const loc = useLocation()
  const known = routeMeta(loc.pathname)
  const text = title ?? (known.section ? known.title : [pre, accent, post].filter(Boolean).join(' '))
  return <PageHeader title={text} subtitle={sub} actions={actions} />
}
