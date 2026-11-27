/** GET /api/edge-watch (decision 336): phase 1 verdicts and parity, pauses, and the candle archive. */
export type VerdictState = 'collecting' | 'consistent' | 'watch' | 'pause' | 'confirmed' | 'no-baseline'

export interface CellVerdict {
  state: VerdictState
  n?: number
  meanR?: number
  sumR?: number
  baselineMeanR?: number
  pBelow?: number | null
  psr?: number | null
  reason?: string
}

export interface EdgeBaseline {
  meanR: number
  sdR: number
  n: number
  since: number
  source: string
}

export interface ParityCell {
  scannerId: string
  symbol: string
  tf: string
  backtest: number
  live: number
  matched: number
  backtestOnly: Array<{ at: number; side: string; live: string }>
  liveOnly: Array<{ at: number; side: string }>
  error?: string
}

export interface EdgeWatchView {
  baselines: Record<string, EdgeBaseline>
  pauses: Record<string, { reason: string; at: number; n: number }>
  verdicts: { at: number; cells: Record<string, CellVerdict> } | null
  parity: { at: number; from: number; to: number; cells: ParityCell[]; missed: number } | null
  archive: {
    last: { at: number; added: number; errors: string[] } | null
    coverage: Array<{ symbol: string; tf: string; bars: number; from: number; to: number }>
  }
}
