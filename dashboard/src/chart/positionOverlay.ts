import type { Position } from '../api/types'
import type { NativeIndicatorContext, NativeIndicatorDescriptor, NativeIndicatorOutput } from '@luxalgo/vela'

/** A price the overlay can draw, with its label and colour role. */
type Level = { price: number; label: string; role: 'entry' | 'stop' | 'target' | 'peak'; dashed?: boolean }
export interface PositionOverlay {
  id: string
  title: string
  symbol: string
  levels: Level[]
}
export const POSITION_LEVELS = 'vnedge.position-levels'

const ROLE_COLOR: Record<Level['role'], string> = {
  entry: '#1878f2',
  stop: '#e5484d',
  target: '#3fb950',
  peak: '#e0b04a',
}

/**
 * Recorded position levels, sent directly to Vela's native renderer. Updating the
 * stop or peak does not compile Pine or replay scanner history.
 *
 * Targets carrying no contracts are drawn faintly and marked, because they cannot fill (decision 38),
 * and the stop is drawn twice when the floor or the trail has moved it: where it started, and where
 * it now stands.
 */
export function positionOverlay(p: Position, peakR?: number | null): PositionOverlay {
  const dir = p.side === 'long' ? 1 : -1
  const original = p.slOriginal ?? p.sl ?? p.entryPrice
  const risk = Math.abs(p.entryPrice - original) || 1
  const rOf = (price: number) => ((price - p.entryPrice) * dir) / risk

  const levels: Level[] = [{ price: p.entryPrice, label: 'entry', role: 'entry' }]
  if (p.slOriginal != null)
    levels.push({ price: p.slOriginal, label: 'stop −1R', role: 'stop', dashed: true })
  if (p.sl != null && (p.slOriginal == null || Math.abs(p.sl - p.slOriginal) > 1e-12))
    levels.push({
      price: p.sl,
      label: `stop now ${rOf(p.sl) >= 0 ? '+' : ''}${rOf(p.sl).toFixed(2)}R`,
      role: 'stop',
    })
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
  if (peakR != null && peakR > 0.05)
    levels.push({
      price: p.entryPrice + dir * peakR * risk,
      label: `peak +${peakR.toFixed(2)}R`,
      role: 'peak',
      dashed: true,
    })

  return {
    id: `position-${p.id}`,
    title: `#${p.id} ${p.symbol} ${p.side}`,
    symbol: p.symbol,
    levels: levels.filter((l) => Number.isFinite(l.price) && l.price > 0),
  }
}

/** Native outputs cannot be dragged into changing an order. They are display only. */
export const positionLevelsIndicator: NativeIndicatorDescriptor = {
  type: POSITION_LEVELS,
  title: 'Recorded position levels',
  paneHint: 'price',
  overlay: true,
  multiInstance: true,
  legend: false,
  inputsSchema: () => [],
  defaultInputs: () => ({}),
  create() {
    // Context is assigned at start; no polling or worker exists for this overlay.
    let context: NativeIndicatorContext | null = null
    let payload = ''
    const paint = () => {
      if (!context) return
      let out: NativeIndicatorOutput = { priceLines: [] }
      try {
        const p = JSON.parse(payload) as PositionOverlay
        // Today's stop must never be presented as the stop in a historical replay.
        if (context.live && context.symbol.replace(/^delta:/, '') === p.symbol && Array.isArray(p.levels))
          out = {
            priceLines: p.levels
              .filter((l) => Number.isFinite(l.price) && l.price > 0 && l.role in ROLE_COLOR)
              .map((l, i) => ({
                id: `${context!.id}:${i}`,
                paneId: '',
                price: l.price,
                title: l.label,
                color: ROLE_COLOR[l.role] + (l.dashed ? '8c' : ''),
                lineStyle: l.dashed ? 'dashed' : 'solid',
                width: l.role === 'entry' ? 2 : 1,
              })),
          }
      } catch {
        /* Malformed display data must not break the chart. */
      }
      context.emit(out)
    }
    return {
      start(c, inputs) {
        context = c
        payload = String(inputs.levels ?? '')
        paint()
      },
      setInputs(inputs) {
        const next = String(inputs.levels ?? '')
        if (next !== payload) {
          payload = next
          paint()
        }
      },
      onBars() {},
      onViewport() {},
      suspend() {},
      resume: paint,
      stop() {
        context = null
      },
    }
  },
}
