/** The Terminal's chart timeframes, in chart order. */
export const TERMINAL_FRAMES = ['1m', '5m', '15m', '1h', '4h'] as const

/** The timeframes a 1-, 2- or 4-chart view shows around the selected one: itself, then higher-timeframe context. */
export function viewFrames(frame: string, n: 1 | 2 | 4): string[] {
  if (n === 1) return [frame]
  if (n === 4) return ['5m', '15m', '1h', '4h']
  const context: Record<string, string> = { '1m': '15m', '5m': '1h', '15m': '4h', '1h': '4h', '4h': '1h' }
  return TERMINAL_FRAMES.filter((tf) => tf === frame || tf === context[frame])
}
