import type { Position } from '../api/types'
import type { ChartScript } from './VelaChart'

/** A price the overlay can draw, with its label and colour role. */
type Level = { price: number; label: string; role: 'entry' | 'stop' | 'target' | 'peak'; dashed?: boolean }

const ROLE_COLOR: Record<Level['role'], string> = {
  entry: '#a89cff',
  stop: '#e5484d',
  target: '#3fb950',
  peak: '#e0b04a',
}

/**
 * The position's own levels, as a Pine overlay the chart can run.
 *
 * The chart executes Pine, so the levels are drawn by a generated script rather than through the
 * chart's drawing API: one horizontal line per level, labelled with its distance in R so the picture
 * answers the question the table cannot — where price is now, relative to everything that will end
 * this trade.
 *
 * Targets carrying no contracts are drawn faintly and marked, because they cannot fill (decision 38),
 * and the stop is drawn twice when the floor or the trail has moved it: where it started, and where
 * it now stands.
 */
export function positionOverlay(p: Position, peakR?: number | null): ChartScript {
  const dir = p.side === 'long' ? 1 : -1
  const original = p.slOriginal ?? p.sl ?? p.entryPrice
  const risk = Math.abs(p.entryPrice - original) || 1
  const rOf = (price: number) => ((price - p.entryPrice) * dir) / risk

  const levels: Level[] = [{ price: p.entryPrice, label: 'entry', role: 'entry' }]
  if (p.slOriginal != null) levels.push({ price: p.slOriginal, label: 'stop −1R', role: 'stop', dashed: true })
  if (p.sl != null && p.slOriginal != null && Math.abs(p.sl - p.slOriginal) > 1e-12)
    levels.push({ price: p.sl, label: `stop now ${rOf(p.sl) >= 0 ? '+' : ''}${rOf(p.sl).toFixed(2)}R`, role: 'stop' })
  p.tp?.forEach((tp, i) => {
    if (tp == null) return
    const funded = (p.legs?.[i] ?? 1) > 0
    const hit = p.tpHit?.[i]
    levels.push({
      price: tp,
      label: `TP${i + 1} +${rOf(tp).toFixed(1)}R${hit ? ' ✓' : funded ? '' : ' (no size)'}`,
      role: 'target',
      dashed: !funded,
    })
  })
  if (peakR != null && peakR > 0.05) levels.push({ price: p.entryPrice + dir * peakR * risk, label: `peak +${peakR.toFixed(2)}R`, role: 'peak', dashed: true })

  const body = levels
    .map((l) => {
      const style = l.dashed ? 'hline.style_dashed' : 'hline.style_solid'
      return `hline(${l.price}, "${l.label}", color = color.new(color.rgb(${hexToRgb(ROLE_COLOR[l.role])}), ${l.dashed ? 45 : 0}), linestyle = ${style}, linewidth = ${l.role === 'entry' ? 2 : 1})`
    })
    .join('\n')

  return {
    id: `position-${p.id}`,
    title: `#${p.id} ${p.symbol} ${p.side}`,
    overlay: true,
    source: `//@version=5\nindicator("Position #${p.id}", overlay = true)\n${body}\n`,
  }
}

function hexToRgb(hex: string): string {
  const v = hex.replace('#', '')
  return `${parseInt(v.slice(0, 2), 16)}, ${parseInt(v.slice(2, 4), 16)}, ${parseInt(v.slice(4, 6), 16)}`
}
