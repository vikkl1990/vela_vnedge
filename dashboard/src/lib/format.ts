/** Number / time formatting helpers used across the dashboard. */

const nf = (min: number, max: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max })

const nfCache = new Map<string, Intl.NumberFormat>()
function fmt(min: number, max: number): Intl.NumberFormat {
  const k = `${min}:${max}`
  let f = nfCache.get(k)
  if (!f) {
    f = nf(min, max)
    nfCache.set(k, f)
  }
  return f
}

export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Decimals implied by a tick size (0.5 → 1, 0.01 → 2, 1 → 0). */
export function decimalsForTick(tickSize: number | undefined): number {
  if (!isNum(tickSize) || tickSize <= 0) return 2
  if (tickSize >= 1) return 0
  const s = tickSize.toString()
  if (s.includes('e-')) return Math.min(8, parseInt(s.split('e-')[1] ?? '2', 10))
  const d = s.split('.')[1]?.length ?? 0
  return Math.min(8, Math.max(1, d))
}

/** Price with decimals derived from the tick size (defaults to 1-2 decimals by magnitude). */
export function fmtPrice(v: number | null | undefined, tickSize?: number): string {
  if (!isNum(v)) return '–'
  let d: number
  if (isNum(tickSize)) d = decimalsForTick(tickSize)
  else if (Math.abs(v) >= 1000) d = 1
  else if (Math.abs(v) >= 1) d = 2
  else d = 4
  return fmt(d, d).format(v)
}

export function fmtNum(v: number | null | undefined, decimals = 2): string {
  if (!isNum(v)) return '–'
  return fmt(decimals, decimals).format(v)
}

export function fmtInt(v: number | null | undefined): string {
  if (!isNum(v)) return '–'
  return fmt(0, 0).format(v)
}

/** Compact currency-ish number: 1,234.56 */
export function fmtMoney(v: number | null | undefined, decimals = 2): string {
  if (!isNum(v)) return '–'
  return fmt(decimals, decimals).format(v)
}

/** Signed PnL string: +1,234.50 / −98.20. Pair with `pnlClass` for color. */
export function fmtPnl(v: number | null | undefined, decimals = 2): string {
  if (!isNum(v)) return '–'
  const s = fmt(decimals, decimals).format(Math.abs(v))
  if (v > 0) return `+${s}`
  if (v < 0) return `−${s}`
  return s
}

export function fmtPct(v: number | null | undefined, decimals = 1, signed = false): string {
  if (!isNum(v)) return '–'
  const s = fmt(decimals, decimals).format(Math.abs(v))
  if (signed) {
    if (v > 0) return `+${s}%`
    if (v < 0) return `−${s}%`
  } else if (v < 0) return `−${s}%`
  return `${s}%`
}

export function fmtR(v: number | null | undefined): string {
  if (!isNum(v)) return '–'
  const s = fmt(2, 2).format(Math.abs(v))
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${s}R`
}

/** CSS class for a signed number. */
export function pnlClass(v: number | null | undefined): string {
  if (!isNum(v) || v === 0) return 'neutral'
  return v > 0 ? 'gain' : 'loss'
}

export function fmtMs(ms: number | null | undefined): string {
  if (!isNum(ms)) return '–'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function timeAgo(t: number | null | undefined, now = Date.now()): string {
  if (!isNum(t) || t <= 0) return '–'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m ago`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h ago`
}

export function fmtAge(ms: number | null | undefined): string {
  if (!isNum(ms) || ms < 0) return '–'
  const s = ms / 1000
  if (s < 1) return `${Math.round(ms)}ms`
  if (s < 60) return `${s.toFixed(0)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h`
}

const dtf = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})
const dtfDate = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const dtfFull = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

const dtfUtc = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

/** Full timestamp in UTC for tooltips: "20 Sep 2026, 16:45:12 UTC". */
export function fmtUtc(t: number | null | undefined): string {
  if (!isNum(t) || t <= 0) return '–'
  return `${dtfUtc.format(new Date(t))} UTC`
}

/** Local zone abbreviation, e.g. "IST" or "GMT+5:30". */
export const LOCAL_TZ: string = (() => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date())
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? 'local'
  } catch {
    return 'local'
  }
})()

export function fmtTime(t: number | null | undefined): string {
  if (!isNum(t) || t <= 0) return '–'
  return dtf.format(new Date(t))
}
export function fmtDateTime(t: number | null | undefined): string {
  if (!isNum(t) || t <= 0) return '–'
  return dtfDate.format(new Date(t))
}
export function fmtFullDateTime(t: number | null | undefined): string {
  if (!isNum(t) || t <= 0) return '–'
  return dtfFull.format(new Date(t))
}

/** Humanized duration: 42s · 3m 12s · 2h 05m · 1d 3h. */
export function fmtDuration(ms: number | null | undefined): string {
  if (!isNum(ms) || ms < 0) return '–'
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d ${h % 24}h`
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${s}s`
}

export function fmtUptime(sec: number | null | undefined): string {
  if (!isNum(sec)) return '–'
  return fmtDuration(sec * 1000)
}

/** Score → letter grade (≥85 A+, ≥70 A, ≥55 B, else C; unknown → –). */
export function scoreGrade(score: number | null | undefined): string {
  if (!isNum(score)) return '–'
  if (score >= 85) return 'A+'
  if (score >= 70) return 'A'
  if (score >= 55) return 'B'
  return 'C'
}

/** Tone for a grade letter (for CSS classes). */
export function gradeTone(grade: string): 'ok' | 'accent' | 'warn' | 'muted' {
  if (grade === 'A+' || grade === 'A') return 'ok'
  if (grade === 'B') return 'accent'
  if (grade === 'C') return 'warn'
  return 'muted'
}

export function truncate(s: string | null | undefined, n = 80): string {
  if (!s) return ''
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
