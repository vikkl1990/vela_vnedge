import type { DrawingBox, DrawingLine, NativeIndicatorContext, NativeIndicatorDescriptor, NativeIndicatorOutput } from '@luxalgo/vela'
import type { JournalRow } from '../api/journal'
import type { Position } from '../api/types'

/**
 * The account's trades drawn on the chart as boxes: entry time to exit time, entry price to exit price (to the latest
 * close while open), green when the trade made money and red when it lost, with its original stop and its targets as
 * short lines over the trade's life. Display only, from the journal and open positions; nothing here can trade.
 */
export const TRADE_BOXES = 'vnedge.trade-boxes'

export interface TradeBox {
  id: string
  side: 'long' | 'short'
  entryAt: number
  /** null while the trade is open: the box runs to the latest bar. */
  exitAt: number | null
  entry: number
  /** null while open: the box spans to the latest close. */
  exit: number | null
  sl: number | null
  tp: number[]
  /** Net result; null while open (the live close decides the colour). */
  net: number | null
  r: number | null
  label: string
}
export interface TradeBoxesPayload {
  symbol: string
  tf: string
  boxes: TradeBox[]
}

const GAIN = '#3fb950', LOSS = '#e5484d', STOP = '#e5484d', TARGET = '#3fb950'

const side = (s: string | null | undefined): 'long' | 'short' | null => (s === 'long' || s === 'short' ? s : null)

/** Closed journal rows and open positions of one market and timeframe, newest last, at most `limit`. */
export function tradeBoxesFrom(symbol: string, tf: string, closed: JournalRow[], open: Position[], limit = 100): TradeBoxesPayload {
  const boxes: TradeBox[] = []
  for (const r of closed) {
    const s = side(r.side)
    if (!s || r.symbol !== symbol || r.tf !== tf || r.entryAt == null || r.entryPrice == null || r.exitAt == null || r.exitPrice == null) continue
    const net = r.net ?? r.realizedNet
    boxes.push({
      id: `j${r.id}`, side: s, entryAt: r.entryAt, exitAt: r.exitAt, entry: r.entryPrice, exit: r.exitPrice,
      sl: r.slOriginal ?? r.sl, tp: (r.targets ?? []).filter((x) => Number.isFinite(x)), net, r: r.r,
      label: `#${r.id} ${s} ${r.r != null ? `${r.r >= 0 ? '+' : ''}${r.r.toFixed(2)}R` : ''}${r.exitReason ? ` · ${r.exitReason}` : ''}`,
    })
  }
  for (const p of open) {
    const s = side(p.side)
    if (!s || p.symbol !== symbol || p.tf !== tf) continue
    boxes.push({
      id: `p${p.id}`, side: s, entryAt: p.entryAt, exitAt: null, entry: p.entryPrice, exit: null,
      sl: p.slOriginal ?? p.sl ?? null, tp: (p.tp ?? []).filter((x): x is number => x != null && Number.isFinite(x)), net: null, r: null,
      label: `#${p.id} ${s} open`,
    })
  }
  boxes.sort((a, b) => a.entryAt - b.entryAt)
  return { symbol, tf, boxes: boxes.slice(-limit) }
}

const box = (id: string, left: number, right: number, top: number, bottom: number, color: string, text: string): DrawingBox => ({
  id, paneId: '', xloc: 'bar_time', left, right, top, bottom, extend: 'none',
  bgColor: `${color}26`, borderColor: `${color}b3`, borderWidth: 1, borderStyle: 'solid',
  text, textColor: color, textSize: 'tiny', hAlign: 'left', vAlign: 'top', wrap: false, fontFamily: 'monospace', bold: false, italic: false, overlay: true,
})
const line = (id: string, x1: number, x2: number, y: number, color: string, style: 'dashed' | 'dotted'): DrawingLine => ({
  id, paneId: '', xloc: 'bar_time', x1, y1: y, x2, y2: y, extend: 'none', color, invisible: false, width: 1, style,
  arrowLeft: false, arrowRight: false, overlay: true,
})

/** Draw a payload against the chart's bars (the open trades need the latest close and bar time). */
export function tradeBoxesOutput(ctx: Pick<NativeIndicatorContext, 'id' | 'symbol' | 'timeframe' | 'bars'>, p: TradeBoxesPayload): NativeIndicatorOutput {
  const out: Required<Pick<NativeIndicatorOutput, 'boxes' | 'lines'>> = { boxes: [], lines: [] }
  if (ctx.symbol.replace(/^delta:/, '') !== p.symbol || !Array.isArray(p.boxes)) return out
  const bars = ctx.bars()
  const last = bars[bars.length - 1]
  if (!last) return out
  const step = bars.length > 1 ? last.time - bars[bars.length - 2].time : 60_000
  const first = bars[0].time
  for (const b of p.boxes) {
    const right = b.exitAt ?? last.time + step
    if (right < first) continue   // older than the loaded history
    const exit = b.exit ?? last.close
    const dir = b.side === 'long' ? 1 : -1
    const won = b.net != null ? b.net > 0 : (exit - b.entry) * dir > 0
    const color = won ? GAIN : LOSS
    const left = Math.max(b.entryAt, first)
    out.boxes.push(box(`${ctx.id}:${b.id}`, left, right, Math.max(b.entry, exit), Math.min(b.entry, exit), color, b.label))
    if (b.sl != null && b.sl > 0) out.lines.push(line(`${ctx.id}:${b.id}:sl`, left, right, b.sl, `${STOP}cc`, 'dashed'))
    b.tp.forEach((t, i) => { if (t > 0) out.lines.push(line(`${ctx.id}:${b.id}:tp${i}`, left, right, t, `${TARGET}99`, 'dotted')) })
  }
  return out
}

export const tradeBoxesIndicator: NativeIndicatorDescriptor = {
  type: TRADE_BOXES,
  title: 'Account trades',
  paneHint: 'price',
  overlay: true,
  multiInstance: true,
  legend: false,
  inputsSchema: () => [],
  defaultInputs: () => ({}),
  create() {
    let context: NativeIndicatorContext | null = null
    let payload = ''
    const paint = () => {
      if (!context) return
      let out: NativeIndicatorOutput = { boxes: [], lines: [] }
      try {
        out = tradeBoxesOutput(context, JSON.parse(payload) as TradeBoxesPayload)
      } catch {
        /* malformed display data must not break the chart */
      }
      context.emit(out)
    }
    return {
      start(c, inputs) {
        context = c
        payload = String(inputs.trades ?? '')
        paint()
      },
      setInputs(inputs) {
        const next = String(inputs.trades ?? '')
        if (next !== payload) {
          payload = next
          paint()
        }
      },
      // an open trade's box follows the latest close
      onBars: () => paint(),
      onViewport() {},
      suspend() {},
      resume: () => paint(),
      stop() {
        context = null
      },
    }
  },
}
