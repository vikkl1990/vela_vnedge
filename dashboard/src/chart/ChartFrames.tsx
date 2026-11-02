import type { TimelineMark, ScriptRun } from '@luxalgo/vela'
import { useFrameSync } from './useFrameSync'
import { useState, type ReactNode } from 'react'
import { VelaChart, type ChartScript } from './VelaChart'
import { ChipSelect } from '../components/ui'
import { DELTA_TIMEFRAMES } from '../lib/timeframes'

/**
 * One market on several timeframes at once, every frame drawing the same scripts, so a scanner's
 * drawing can be read across the frames it is traded on. Each frame is its own Vela instance
 * (its own data and its own Pine run); four is the practical ceiling on a laptop.
 */
export function ChartFrames({ symbol, tfs, scripts, tickSize, onScriptError, onScriptReady, onScriptRun, height = '100%', marks, positionBadge }: {
  symbol: string; tfs: string[]; scripts: ChartScript[]; tickSize?: number; height?: number | string
  marks?: TimelineMark[]
  positionBadge?: ReactNode
  onScriptError?: (id: string, err: Error) => void; onScriptReady?: (id: string) => void
  onScriptRun?: (tf: string, run: ScriptRun) => void
}) {
  const {register, controls} = useFrameSync(tfs)
  const cols = tfs.length <= 1 ? 1 : 2
  return (
    <div style={{height, display:'flex', flexDirection:'column', minHeight:0}}>{controls}
    <div className="chart-frames" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, flex:1, minHeight:0 }}>
      {tfs.map((tf) => (
        <div key={tf} className="chart-frame" style={{ position: 'relative' }}>
          {positionBadge}
          <span className="chart-frame-tag mono">{symbol} · {tf}</span>
          <VelaChart marks={marks} symbol={symbol} tf={tf} height="100%" scripts={scripts} tickSize={tickSize} onScriptError={onScriptError} onScriptReady={onScriptReady}
            onChartReady={c => register(tf, c)} onScriptRun={r => onScriptRun?.(tf, r)} />
        </div>
      ))}
    </div>
    </div>
  )
}

/** The timeframe picker for the frames view: two to four of Delta's timeframes, in chart order. */
export function FramePicker({ value, onChange }: { value: string[]; onChange: (tfs: string[]) => void }) {
  const [warn, setWarn] = useState('')
  return (
    <span className="row gap">
      <ChipSelect
        label="Frames"
        options={[...DELTA_TIMEFRAMES]}
        value={value}
        onChange={(v) => {
          const ordered = DELTA_TIMEFRAMES.filter((t) => v.includes(t))
          if (ordered.length > 4) { setWarn('four frames at most'); return }
          if (ordered.length < 1) { setWarn('keep one frame'); return }
          setWarn(''); onChange(ordered)
        }}
        emptyLabel="no frames"
      />
      {warn && <span className="muted small">{warn}</span>}
    </span>
  )
}
