import type { Vela } from '@luxalgo/vela'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { api } from '../api/client'
import type { JournalRow } from '../api/journal'
import { qk, useScannerIndex } from '../api/queries'
import type { Position } from '../api/types'
import { decisionMarks } from '../chart/decisionMarks'
import { positionOverlay } from '../chart/positionOverlay'
import { tradeBoxesFrom } from '../chart/tradeBoxes'
import { VelaChart, type ChartScript } from '../chart/VelaChart'

/**
 * One Terminal chart: a market on one timeframe with the Pine of every enabled scanner that trades that cell, the
 * journal's decision marks, the account's trades as boxes and the open trade's levels. The Terminal shows one, two or
 * four of these; each loads only what its own timeframe needs.
 */
export interface FrameCell { id: string; symbol: string; tf: string }

export function TerminalFrame({
  symbol, tf, cells, hidden, tickSize, closed, positions, tag, onChartReady, onScriptError, onScriptReady,
}: {
  symbol: string
  tf: string
  cells: FrameCell[]
  hidden: Record<string, boolean>
  tickSize?: number
  closed: JournalRow[]
  positions: Position[]
  /** Show the timeframe in a corner tag (multi-chart view). */
  tag?: boolean
  onChartReady?: (chart: Vela | null) => void
  onScriptError?: (id: string, err: Error) => void
  onScriptReady?: (id: string) => void
}) {
  const scanners = useScannerIndex()
  const ids = useMemo(
    () => [...new Set(cells.filter((c) => c.symbol === symbol && c.tf === tf && !hidden[c.id]).map((c) => c.id))],
    [cells, symbol, tf, hidden],
  )
  const sources = useQueries({
    queries: ids.map((id) => ({ queryKey: qk.scannerSource(id), queryFn: () => api.scannerSource(id), staleTime: 5 * 60_000, retry: 1 })),
  })
  const scripts = useMemo<ChartScript[]>(() => {
    const out: ChartScript[] = []
    ids.forEach((id, i) => {
      const src = sources[i]?.data
      const sc = (scanners.data ?? []).find((s) => s.id === id)
      if (src?.patched && sc)
        out.push({ id, title: sc.name, source: src.patched, overlay: sc.overlay, inputs: src.inputs, sourceHash: src.sourceHash, timezone: src.timezone })
    })
    return out
  }, [ids, sources, scanners.data])
  const signals = useQuery({
    queryKey: ['scalp-chart-signals', symbol, tf],
    queryFn: () => api.signals({ kind: 'entry', symbol, tf, limit: 300 }),
    refetchInterval: 15_000,
    staleTime: 10_000,
  })
  const marks = useMemo(() => decisionMarks(signals.data ?? []), [signals.data])
  const open = positions.find((p) => p.symbol === symbol && p.tf === tf)
  const overlay = useMemo(() => (open ? positionOverlay(open, open.peakR ?? null) : null), [open])
  const boxes = useMemo(() => tradeBoxesFrom(symbol, tf, closed, positions), [symbol, tf, closed, positions])
  return (
    <div className="scalp-frame">
      {tag && <span className="scalp-frame-tag mono">{tf}</span>}
      <VelaChart
        symbol={symbol}
        tf={tf}
        height="100%"
        scripts={scripts}
        marks={marks}
        positionOverlay={overlay}
        tradeBoxes={boxes}
        tickSize={tickSize}
        onChartReady={onChartReady}
        onScriptError={onScriptError}
        onScriptReady={onScriptReady}
      />
    </div>
  )
}
