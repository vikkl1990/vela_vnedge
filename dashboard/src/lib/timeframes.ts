/** Delta timeframe strings (API) ⇄ Vela/TradingView timeframe strings. */

export const DELTA_TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '1d'] as const
export type DeltaTf = (typeof DELTA_TIMEFRAMES)[number]

const DELTA_TO_VELA: Record<string, string> = {
  '1m': '1',
  '3m': '3',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '2h': '120',
  '4h': '240',
  '6h': '360',
  '1d': 'D',
}
const VELA_TO_DELTA: Record<string, string> = Object.fromEntries(
  Object.entries(DELTA_TO_VELA).map(([d, v]) => [v, d]),
)

export function deltaToVelaTf(tf: string): string {
  return DELTA_TO_VELA[tf] ?? tf
}

/** Accepts '15', '60', '240', 'D', '1D', '1W' style; returns Delta resolution. */
export function velaToDeltaTf(tf: string): string {
  const t = tf.toUpperCase()
  if (VELA_TO_DELTA[t]) return VELA_TO_DELTA[t]
  if (VELA_TO_DELTA[tf]) return VELA_TO_DELTA[tf]
  if (t === '1D' || t === 'D') return '1d'
  if (t === '1W' || t === 'W') return '1w'
  if (t === '1M' || t === 'M') return '1M'
  const n = Number(tf)
  if (Number.isFinite(n)) {
    if (n % 1440 === 0) return `${n / 1440}d`
    if (n % 60 === 0) return `${n / 60}h`
    return `${n}m`
  }
  return tf
}

export function tfMinutes(tf: string): number {
  const m = /^(\d+)([mhd])$/.exec(tf)
  if (!m) return 15
  const n = Number(m[1])
  return m[2] === 'm' ? n : m[2] === 'h' ? n * 60 : n * 1440
}

export function tfMs(tf: string): number {
  return tfMinutes(tf) * 60_000
}
