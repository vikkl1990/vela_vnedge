import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Vela as VelaType } from '@luxalgo/vela'
import { usePositionPath } from '../api/queries'
import type { PathPoint } from '../api/types'
import { VelaChart } from '../chart/VelaChart'
import { replayOverlay } from '../chart/replayOverlay'
import { Pill, QueryState } from '../components/ui'
import { fmtDateTime, fmtPrice } from '../lib/format'
import { tfMs as tfToMs } from '../lib/timeframes'

/**
 * Decision 156: trade replay. The trade's market and timeframe on the chart, rewound to before its entry, and its bars
 * revealed one at a time (by hand or on a timer) with the entry, the stop as it moved, the targets and the exit drawn.
 * Beside it, the trade as it stood at the cursor: R now, best and worst so far, where the stop was, and every event that
 * had happened. It answers what a closed row cannot: how the trade went, bar by bar, before it ended.
 */
const LEAD_BARS = 40
const TAIL_BARS = 20
const SPEEDS = [
  { ms: 1000, label: '1 bar/s' },
  { ms: 400, label: '2.5 bar/s' },
  { ms: 150, label: '7 bar/s' },
  { ms: 50, label: '20 bar/s' },
]
const fmtR = (r: number | null | undefined) => (r == null || !Number.isFinite(r) ? '–' : `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}R`)
const EVENT_LABEL: Record<string, string> = { tp1: 'target 1 hit', tp2: 'target 2 hit', tp3: 'target 3 hit', sl: 'stopped out', be: 'stop to break even', trail: 'trail exit', 'stop moved': 'stop moved', reversal: 'reversed', script_exit: 'script exit', liquidation: 'liquidated', manual: 'closed by hand' }

export function TradeReplay() {
  const { id } = useParams()
  const [resolution, setResolution] = useState<'strategy' | 'execution'>('execution')
  const q = usePositionPath(id ? Number(id) : null)
  return (
    <div className="page replay-page">
      <QueryState {...q} data={q.data} skeleton="chart" empty="No such trade." onRetry={() => q.refetch()}>
        {(d) => <ReplayBody key={`${id}:${resolution}`} lv={d.position} path={d.path} execution={resolution === 'execution'} onResolution={setResolution} />}
      </QueryState>
    </div>
  )
}

function ReplayBody({ lv, path, execution, onResolution }: { execution: boolean; onResolution: (value: 'strategy' | 'execution') => void; lv: NonNullable<ReturnType<typeof usePositionPath>['data']>['position']; path: PathPoint[] }) {
  const tf = execution ? '1m' : lv.tf ?? '15m'
  const barMs = tfToMs(tf)
  const barOf = (t: number) => Math.floor(t / barMs) * barMs
  const entryBar = barOf(lv.entryAt)
  const exitBar = lv.exitAt != null ? barOf(lv.exitAt) : null
  const startT = entryBar - LEAD_BARS * barMs
  const [openedAt] = useState(() => Date.now())
  const endT = (exitBar ?? barOf(openedAt)) + TAIL_BARS * barMs
  const finalR = lv.status === 'closed' && lv.riskAmount ? ((lv.realizedPnl ?? 0) - (lv.fees ?? 0)) / lv.riskAmount : null
  const overlay = useMemo(() => replayOverlay(lv, path, barMs, finalR), [lv, path, barMs, finalR])
  const scripts = useMemo(() => [overlay], [overlay])

  const [chart, setChart] = useState<VelaType | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [ended, setEnded] = useState(false)
  const [speed, setSpeed] = useState(SPEEDS[1].ms)
  const [scrub, setScrub] = useState<number | null>(null)
  const startedRef = useRef(false)

  const seek = useCallback(async (from: number) => {
    if (!chart) return
    try { setEnded(false); await chart.replay.start({ from }) } catch (e) { console.warn('[replay] start failed', e) }
    // frame the trade: its lead-in, its life and a little after, so a trade of a few bars is not a speck on the right edge
    try { chart.setVisibleRange({ from: startT, to: endT }) } catch (e) { console.warn('[replay] setVisibleRange failed', e) }
  }, [chart, startT, endT])

  // enter replay once, rewound to before the entry, and follow the chart's replay events
  useEffect(() => {
    if (!chart) return
    const offs = [
      chart.on('replay:start', (e) => { setCursor(e.cursorTime); setEnded(false) }),
      chart.on('replay:step', (e) => setCursor(e.cursorTime)),
      chart.on('replay:play', () => setPlaying(true)),
      chart.on('replay:pause', () => setPlaying(false)),
      chart.on('replay:end', () => { setPlaying(false); setEnded(true) }),
    ]
    if (!startedRef.current) { startedRef.current = true; void seek(startT) }
    return () => { offs.forEach((off) => { try { off() } catch { /* chart gone */ } }) }
  }, [chart, seek, startT])

  const play = () => { if (!chart) return; if (ended) { void seek(startT).then(() => chart.replay.play(speed)); return } chart.replay.play(speed) }
  const pause = () => chart?.replay.pause()
  const step = () => { if (chart && !ended) chart.replay.step() }
  useEffect(() => { if (chart && playing) chart.replay.play(speed) }, [speed]) // eslint-disable-line react-hooks/exhaustive-deps

  // keys: space plays or pauses, the right arrow steps, Home rewinds
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return
      if (e.key === ' ') { e.preventDefault(); if (playing) pause(); else play() }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step() }
      else if (e.key === 'Home') { e.preventDefault(); void seek(startT) }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  })

  // the trade as it stood when the cursor's bar closed
  const at = ended ? Infinity : cursor != null ? cursor + barMs - 1 : startT
  const seen = useMemo(() => path.filter((p) => p.at <= at), [path, at])
  const phase = at < lv.entryAt ? 'before' : lv.exitAt != null && at >= lv.exitAt ? 'closed' : 'open'
  const orig = lv.slOriginal ?? lv.entryPrice
  const risk = Math.abs(lv.entryPrice - orig) || 1
  const rOf = (price: number) => ((price - lv.entryPrice) * (lv.side === 'long' ? 1 : -1)) / risk
  const last = seen[seen.length - 1]
  const rNow = phase === 'closed' ? finalR ?? last?.r ?? null : last?.r ?? null
  const peak = seen.length ? Math.max(...seen.map((p) => p.r)) : null
  const worst = seen.length ? Math.min(...seen.map((p) => p.r)) : null
  const stopNow = [...seen].reverse().find((p) => p.sl != null)?.sl ?? (phase !== 'before' ? orig : null)
  const events = seen.filter((p) => p.event)
  const progress = cursor != null ? Math.max(0, Math.min(1, (cursor - startT) / Math.max(1, endT - startT))) : 0

  return (
    <div className="replay">
      <div className="replay-head">
        <div>
          <h1 className="replay-title">#{lv.id} {lv.symbol} <span className="muted">{tf}</span> <span className={`side-${lv.side}`}>{lv.side}</span></h1>
          <div className="muted small">
            {lv.scannerId ? <Link to={`/scanners/${encodeURIComponent(lv.scannerId)}`} className="link">{lv.scannerName ?? lv.scannerId}</Link> : 'scanner'}
            {lv.book ? ` · ${lv.book} book` : ''} · opened {fmtDateTime(lv.entryAt)}{lv.exitAt ? ` · closed ${fmtDateTime(lv.exitAt)}` : ' · still open'}
          </div>
        </div>
        <span className="grow" />
        {finalR != null && <Pill tone={finalR >= 0 ? 'ok' : 'danger'}>{lv.exitReason ?? 'closed'} {fmtR(finalR)}</Pill>}
        <Link className="btn btn-sm" to="/trades">Trades</Link>
      </div>

      <p className="muted small">Trade timeframe {lv.tf ?? '15m'} · replay {tf}. Recorded path samples and candle bars cannot establish tick ordering or exact hypothetical fills.</p>
      <label className="field-inline">Replay detail <select className="select" aria-label="Replay detail" value={execution ? 'execution' : 'strategy'} onChange={(e) => onResolution(e.target.value as 'strategy' | 'execution')}><option value="execution">Execution · 1m</option><option value="strategy">Strategy candle overview</option></select></label>
      <div className="replay-grid">
        <div className="replay-chart">
          <VelaChart symbol={lv.symbol} tf={tf} height="100%" scripts={scripts} onChartReady={setChart} />
        </div>

        <aside className="replay-side" aria-label="The trade at the cursor">
          <div className="replay-controls" role="group" aria-label="Replay">
            <button className="btn btn-sm" onClick={() => void seek(startT)} disabled={!chart} title="Back to before the entry (Home)">⏮</button>
            <button className="btn btn-sm" onClick={() => void seek(entryBar - barMs)} disabled={!chart} title="To the bar before the entry">Entry</button>
            {playing
              ? <button className="btn btn-sm btn-primary" onClick={pause} title="Pause (space)">Pause</button>
              : <button className="btn btn-sm btn-primary" onClick={play} disabled={!chart} title="Play (space)">Play</button>}
            <button className="btn btn-sm" onClick={step} disabled={!chart || ended} title="One bar (→)">Step</button>
            {exitBar != null && <button className="btn btn-sm" onClick={() => void seek(exitBar)} disabled={!chart} title="To the exit bar">Exit</button>}
            <select className="select select-sm" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Speed">
              {SPEEDS.map((s) => <option key={s.ms} value={s.ms}>{s.label}</option>)}
            </select>
          </div>
          <label className="replay-scrub">
            <span className="sr-only">Position in the replay</span>
            <input type="range" min={startT} max={endT} step={barMs} value={scrub ?? cursor ?? startT}
              onChange={(e) => setScrub(Number(e.target.value))}
              onPointerUp={() => { if (scrub != null) { void seek(scrub); setScrub(null) } }}
              onKeyUp={() => { if (scrub != null) { void seek(scrub); setScrub(null) } }}
              disabled={!chart} aria-label="Scrub the replay" />
            <span className="muted small mono">{cursor != null && !ended ? fmtDateTime(cursor + barMs) : ended ? 'replay finished' : '–'} · {Math.round(progress * 100)}%</span>
          </label>

          <div className={`replay-phase ${phase}`}>{phase === 'before' ? 'Before the entry' : phase === 'open' ? 'In the trade' : 'Closed'}</div>
          <dl className="replay-facts">
            <dt>R now</dt><dd className={`mono ${(rNow ?? 0) >= 0 ? 'gain' : 'loss'}`}>{phase === 'before' ? '–' : fmtR(rNow)}</dd>
            <dt>Best so far</dt><dd className="mono gain">{phase === 'before' ? '–' : fmtR(peak)}</dd>
            <dt>Worst so far</dt><dd className="mono loss">{phase === 'before' ? '–' : fmtR(worst)}</dd>
            <dt>Stop</dt><dd className="mono">{stopNow != null && phase !== 'before' ? `${fmtPrice(stopNow)} (${fmtR(rOf(stopNow))})` : '–'}</dd>
            <dt>Entry</dt><dd className="mono">{fmtPrice(lv.entryPrice)}</dd>
            <dt>Stop at entry</dt><dd className="mono">{fmtPrice(orig)} <span className="muted">−1R{lv.levelsSource ? ` · ${lv.levelsSource === 'atr-fallback' ? 'ATR' : 'script'}` : ''}</span></dd>
            {(lv.tp ?? []).map((tp, i) => <Fragment key={i}><dt>Target {i + 1}</dt><dd className="mono">{fmtPrice(tp)} <span className="muted">{fmtR(rOf(tp))}</span></dd></Fragment>)}
            {lv.exitPrice != null && <><dt>Exit</dt><dd className="mono">{fmtPrice(lv.exitPrice)} <span className="muted">{lv.exitReason}</span></dd></>}
          </dl>

          <div className="replay-events">
            <h3>What happened</h3>
            {phase === 'before' && <p className="muted small">The signal fires at {fmtDateTime(lv.entryAt)}. Press Play or step.</p>}
            {phase !== 'before' && events.length === 0 && <p className="muted small">Nothing yet: no target, stop move or exit.</p>}
            <ul>
              {events.map((p, i) => (
                <li key={i}><span className="mono small muted">{fmtDateTime(p.at)}</span> <span>{EVENT_LABEL[p.event!] ?? p.event}</span> <span className={`mono small ${p.r >= 0 ? 'gain' : 'loss'}`}>{fmtR(p.r)}</span>{p.note ? <span className="muted small"> · {p.note}</span> : null}</li>
              ))}
            </ul>
            {path.length < 2 && <p className="muted small">No minute path was recorded for this trade, so only its levels are drawn.</p>}
          </div>
          <p className="muted small replay-keys">Space plays or pauses · → steps one bar · Home rewinds</p>
        </aside>
      </div>
    </div>
  )
}
