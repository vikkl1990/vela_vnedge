import type { PathLevels, PathPoint } from '../api/types'
import type { ChartScript } from './VelaChart'

/**
 * Decision 156: one trade drawn for a bar replay. A generated Pine overlay, like `positionOverlay`, but bounded to the
 * trade's own life and moving with it: the entry and the targets span entry to exit, the stop is a step line that
 * follows every move the engine recorded (the floor and the trail ratcheting), and the entry and exit bars are
 * marked. Each bar shows the stop as it stood when that bar closed, so a replay never shows a move before it happened.
 */
export function replayOverlay(lv: PathLevels, path: PathPoint[], tfMs: number, finalR: number | null): ChartScript {
  const long = lv.side === 'long'
  const barOf = (t: number) => Math.floor(t / tfMs) * tfMs
  const entryBar = barOf(lv.entryAt)
  const exitBar = lv.exitAt != null ? barOf(lv.exitAt) : null
  const orig = lv.slOriginal ?? lv.sl ?? lv.entryPrice
  const risk = Math.abs(lv.entryPrice - orig) || 1
  const rOf = (price: number) => ((price - lv.entryPrice) * (long ? 1 : -1)) / risk

  // the stop's change points: where it opened, then every recorded move (consecutive repeats dropped)
  const changes: Array<[number, number]> = [[lv.entryAt, orig]]
  for (const p of path) if (p.sl != null && Math.abs(p.sl - changes[changes.length - 1][1]) > 1e-12) changes.push([p.at, p.sl])
  const times = changes.map(([t]) => t).join(', ')
  const stops = changes.map(([, v]) => v).join(', ')

  const num = (v: number) => (Number.isFinite(v) ? String(v) : 'na')
  const tps = (lv.tp ?? []).filter((t) => t != null && Number.isFinite(t))
  const tpLines = tps
    .map((tp, i) => `plot(inTrade ? ${num(tp)} : na, "TP${i + 1} ${rOf(tp) >= 0 ? '+' : ''}${rOf(tp).toFixed(1)}R", color = color.new(#3fb950, ${(lv.tpHit?.[i] ?? 0) > 0 ? 0 : 35}), style = plot.style_linebr, linewidth = 1)`)
    .join('\n')
  const exitText = lv.exitAt != null ? `exit ${lv.exitReason ?? ''}${finalR != null ? ` ${finalR >= 0 ? '+' : ''}${finalR.toFixed(2)}R` : ''}`.trim() : ''
  const exitColor = finalR == null ? '#8f8f98' : finalR >= 0 ? '#3fb950' : '#e5484d'

  const source = `//@version=5
indicator("Trade #${lv.id} replay", overlay = true, max_labels_count = 10)
entryT = ${entryBar}
exitT = ${exitBar ?? 'na'}
barMs = ${tfMs}
inTrade = time >= entryT and (na(exitT) or time <= exitT)
var float[] st = array.from(${times})
var float[] sv = array.from(${stops})
var int k = 0
while k < array.size(st) - 1 and array.get(st, k + 1) <= time + barMs - 1
    k += 1
stopNow = inTrade ? array.get(sv, k) : na
plot(inTrade ? ${num(lv.entryPrice)} : na, "Entry", color = #1878f2, style = plot.style_linebr, linewidth = 2)
plot(inTrade ? ${num(orig)} : na, "Stop at entry −1R", color = color.new(#e5484d, 55), style = plot.style_linebr, linewidth = 1)
plot(stopNow, "Stop", color = #e5484d, style = plot.style_stepline, linewidth = 2)
${tpLines}
plotshape(time == entryT, "Entry", ${long ? 'shape.triangleup' : 'shape.triangledown'}, ${long ? 'location.belowbar' : 'location.abovebar'}, color = #1878f2, size = size.small, text = "${long ? 'long' : 'short'}")
if not na(exitT) and time == exitT
    label.new(bar_index, ${num(lv.exitPrice ?? lv.entryPrice)}, "${exitText}", color = ${exitColor}, textcolor = color.white, style = ${long ? 'label.style_label_down' : 'label.style_label_up'}, size = size.small)
`
  return { id: `replay-${lv.id}`, title: `Trade #${lv.id}`, overlay: true, source }
}
