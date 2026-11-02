import { useCallback, useRef, useState } from 'react'
import type { Vela } from '@luxalgo/vela'
import { tfMs } from '../lib/timeframes'
import { fmtDateTime } from '../lib/format'
import { replayOpenAt } from './venues'

export function useFrameSync(tfs: string[]) {
  const charts = useRef(new Map<string, {chart: Vela; off: () => void}>())
  const [cursor, setCursor] = useState<number | null>(null)
  const [end, setEnd] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const register = useCallback((tf: string, chart: Vela | null) => {
    charts.current.get(tf)?.off(); charts.current.delete(tf)
    if (chart) charts.current.set(tf, {chart, off: chart.renderer.onCrosshairMove(e => {
      for (const [other, v] of charts.current) if (other !== tf) v.chart.renderer.setExternalCrosshair(e.time, e.price ?? undefined)
    })})
  }, [])
  const seek = async (at: number) => {
    setBusy(true); setError('')
    try {
      if (charts.current.size !== tfs.length) throw new Error('Wait for every frame to load')
      const results = await Promise.allSettled([...charts.current].map(async ([tf, {chart}]) => {
        await chart.replay.start({from: replayOpenAt(at, tfMs(tf))})
        if (!chart.replay.state.active) throw new Error(`No replay history for ${tf}`)
      }))
      const failed = results.find(r => r.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      setCursor(at)
    } catch (e) {
      for (const {chart} of charts.current.values()) chart.replay.stop()
      setCursor(null); setError((e as Error).message)
    } finally { setBusy(false) }
  }
  const start = () => {
    const entries = [...charts.current]
    if (entries.length !== tfs.length || entries.some(([,v]) => !v.chart.replay.bounds)) { setError('Wait for every frame to load'); return }
    const end = Math.min(Date.now(), ...entries.map(([tf,v]) => v.chart.replay.bounds!.last + tfMs(tf)))
    setEnd(end)
    const first = Math.max(...entries.map(([tf,v]) => v.chart.replay.bounds!.first + tfMs(tf)))
    void seek(Math.max(first, end - 86400000))
  }
  const controls = <div className="row gap" style={{padding:'4px 0',flexWrap:'wrap'}}>
    <button className="btn btn-xs" disabled={busy} onClick={start}>Replay together · previous day</button>
    {cursor !== null && <><button className="btn btn-xs" disabled={busy || cursor + Math.min(...tfs.map(tfMs)) > end} onClick={() => void seek(cursor + Math.min(...tfs.map(tfMs)))}>Next closed bar</button>
      <button className="btn btn-xs" disabled={busy} onClick={() => {for (const {chart} of charts.current.values()) chart.replay.stop(); setCursor(null)}}>Return live</button>
      <span className="small mono">Closed through {fmtDateTime(cursor)}</span></>}
    {error && <span role="alert">{error}</span>}
  </div>
  return {register, controls}
}
