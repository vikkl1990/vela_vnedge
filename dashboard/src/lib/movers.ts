import type { MoverRow, Position } from '../api/types'

export type MoverWindow = 5 | 15 | 60
export const MOVER_WINDOWS: ReadonlyArray<{ value: MoverWindow; label: string }> = [
  { value: 5, label: '5m' },
  { value: 15, label: '15m' },
  { value: 60, label: '1h' },
]

/**
 * A move is "hot" when it is large for its window: 1.5% in five minutes, 3% in fifteen, 5% in an hour. Chosen from the
 * spike study (a 5-minute move of 1.2% and 5 standard deviations happens about 90 times a day across 81 markets), so a
 * hot chip is unusual without being rare enough to never show.
 */
export const HOT_PCT: Record<MoverWindow, number> = { 5: 1.5, 15: 3, 60: 5 }

export function changeFor(row: MoverRow, w: MoverWindow): number | null {
  return w === 5 ? row.ch5 : w === 15 ? row.ch15 : row.ch60
}

/** The biggest movers by absolute change over one window; markets with no figure for it are left out. */
export function pickMovers(rows: ReadonlyArray<MoverRow>, w: MoverWindow, limit = 8) {
  return rows
    .map((row) => ({ row, ch: changeFor(row, w) }))
    .filter((x): x is { row: MoverRow; ch: number } => x.ch !== null && Number.isFinite(x.ch))
    .sort((a, b) => Math.abs(b.ch) - Math.abs(a.ch))
    .slice(0, limit)
    .map((x) => ({ ...x, hot: Math.abs(x.ch) >= HOT_PCT[w] }))
}

/** Which way the account is positioned in each market (the first open position wins when it holds both). */
export function heldSides(
  positions: ReadonlyArray<Pick<Position, 'symbol' | 'side'>>,
): Map<string, 'long' | 'short'> {
  const m = new Map<string, 'long' | 'short'>()
  for (const p of positions) if (!m.has(p.symbol)) m.set(p.symbol, p.side)
  return m
}

/** Words for a move that do not depend on colour: ▲ or ▼, and a sign. */
export function arrowFor(ch: number): string {
  return ch > 0 ? '▲' : ch < 0 ? '▼' : '–'
}
