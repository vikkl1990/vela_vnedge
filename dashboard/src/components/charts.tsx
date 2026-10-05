import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { EquityPoint } from '../api/types'
import { fmtDateTime, fmtMoney, fmtPnl } from '../lib/format'

const GAIN = 'hsl(136 39% 45%)'
const LOSS = 'hsl(7 80% 55%)'
const ACCENT = '#7c6ff5'

export function EquityChart({ data, height = 220, baseline }: { data: EquityPoint[]; height?: number; baseline?: number }) {
  if (!data.length) return <div className="state muted">No equity history yet.</div>
  const first = baseline ?? data[0].equity
  const last = data[data.length - 1].equity
  const color = last >= first ? GAIN : LOSS
  const min = Math.min(...data.map((d) => d.equity))
  const max = Math.max(...data.map((d) => d.equity))
  const pad = Math.max(1, (max - min) * 0.1)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="eqfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="at"
          tickFormatter={(v: number) => fmtDateTime(v)}
          stroke="var(--muted)"
          fontSize={10}
          tickLine={false}
          axisLine={false}
          minTickGap={60}
          fontFamily="JetBrains Mono, monospace"
        />
        <YAxis
          domain={[min - pad, max + pad]}
          tickFormatter={(v: number) => fmtMoney(v, 0)}
          stroke="var(--muted)"
          fontSize={10}
          tickLine={false}
          axisLine={false}
          width={64}
          fontFamily="JetBrains Mono, monospace"
        />
        <Tooltip
          contentStyle={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
          labelFormatter={(v) => fmtDateTime(Number(v))}
          formatter={(v, name) => [fmtMoney(Number(v)), String(name)]}
        />
        <Area type="monotone" dataKey="equity" stroke={color} strokeWidth={1.6} fill="url(#eqfill)" isAnimationActive={false} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

export interface PnlBar {
  name: string
  id: string
  pnl: number
}

export function PnlByScannerChart({ data, height = 220 }: { data: PnlBar[]; height?: number }) {
  if (!data.length) return <div className="state muted">No scanner PnL yet.</div>
  const sorted = [...data].sort((a, b) => b.pnl - a.pnl)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={sorted} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="name"
          stroke="var(--muted)"
          fontSize={10}
          tickLine={false}
          axisLine={false}
          interval={0}
          tickFormatter={(v: string) => (v.length > 12 ? `${v.slice(0, 11)}…` : v)}
          angle={-30}
          textAnchor="end"
          height={60}
        />
        <YAxis
          domain={[(min: number) => Math.min(0, min), (max: number) => Math.max(0, max)]}
          tickFormatter={(v: number) => fmtPnl(v, 0)}
          stroke="var(--muted)"
          fontSize={10}
          tickLine={false}
          axisLine={false}
          width={56}
          fontFamily="JetBrains Mono, monospace"
        />
        <Tooltip
          cursor={{ fill: 'rgba(124,111,245,0.08)' }}
          contentStyle={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
          formatter={(v) => [fmtPnl(Number(v)), 'PnL']}
        />
        <Bar dataKey="pnl" isAnimationActive={false} radius={[3, 3, 0, 0]}>
          {sorted.map((d) => (
            <Cell key={d.id} fill={d.pnl >= 0 ? GAIN : d.pnl < 0 ? LOSS : ACCENT} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/** A small inline line chart: one series, last value on the right, no axes (decision 80 system panel). */
export function Sparkline({ values, height = 44, width = 240, className = '', format = (v: number) => String(Math.round(v)) }: { values: Array<number | null>; height?: number; width?: number; className?: string; format?: (v: number) => string }) {
  const pts = values.map((v, i) => (v === null || !Number.isFinite(v) ? null : { i, v })).filter((p): p is { i: number; v: number } => p !== null)
  if (pts.length < 2) return <span className="muted small">no data yet</span>
  const min = Math.min(...pts.map((p) => p.v)), max = Math.max(...pts.map((p) => p.v))
  const span = max - min || 1
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * (width - 2) + 1
  const y = (v: number) => height - 3 - ((v - min) / span) * (height - 6)
  const d = pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1].v
  return (
    <span className={`sparkline ${className}`} title={`min ${format(min)} · max ${format(max)} · now ${format(last)}`}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`now ${format(last)}`}>
        <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <span className="mono small">{format(last)}</span>
    </span>
  )
}
