import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import { fmtDateTime } from '../lib/format'
import { VelaChart, type ChartScript } from './VelaChart'

const deltaScript: ChartScript = { id: 'measured-tape-delta', title: 'Delta tape · executed volume', overlay: false,
  source: `//@version=6
indicator("Delta tape · executed volume", overlay=false)
footprint fp = request.footprint(1)
float d = na(fp) ? na : fp.delta()
plot(d, "Buy minus sell contracts", style=plot.style_histogram, color=d >= 0 ? color.lime : color.red)` }
const cvdScript: ChartScript = { id: 'measured-tape-cvd', title: 'Delta tape · CVD', overlay: false,
  source: `//@version=6
indicator("Delta tape · CVD", overlay=false)
footprint fp = request.footprint(1)
float d = na(fp) ? na : fp.delta()
var float cumulative = na
cumulative := na(d) ? na : nz(cumulative) + d
plot(cumulative, "CVD contracts (resets after gaps)", style=plot.style_linebr, color=color.aqua)` }

export function OrderFlowPanel({ symbol }: {symbol: string}) {
  const [tf, setTf] = useState('1m')
  const [plot, setPlot] = useState(false)
  const q = useQuery({ queryKey: ['order-flow', symbol, tf], queryFn: () => api.orderFlow(symbol, tf), refetchInterval: 10000 })
  const data = q.data, last = data?.bars.at(-1)
  const levels = [...(last?.levels ?? [])].sort((a, b) => b.buyVolume + b.sellVolume - a.buyVolume - a.sellVolume).slice(0, 15).sort((a, b) => b.price - a.price)
  const n = (v: number | null | undefined) => v == null ? 'Unavailable' : v.toLocaleString(undefined, {maximumFractionDigits: 2})
  return <section id="chart-order-flow" className="panel chart-section" style={{padding: 16}} aria-label="Measured order flow">
    <div className="row gap" style={{flexWrap: 'wrap'}}><h2 style={{margin: 0}}>Delta order flow · {symbol}</h2>
      <select className="select" aria-label="Order flow timeframe" value={tf} onChange={e => setTf(e.target.value)}>{['1m','5m','15m','1h','4h'].map(t => <option key={t}>{t}</option>)}</select>
      <button className="btn btn-xs" onClick={() => setPlot(v => !v)} aria-pressed={plot}>{plot ? 'Hide' : 'Show'} delta / CVD chart</button>
    </div>
    {q.isError ? <p role="alert">Order-flow data could not be loaded: {q.error.message}</p> : !data ? <p>Loading tape coverage…</p> : !data.supported ? <p>Recorded footprints currently cover BTC, ETH and SOL. {symbol} has no recorded footprint feed.</p> : <>
      <p className="small muted">{data.connected ? 'Collector connected' : 'Collector disconnected'} · Executed volume in contracts · Closed bars, with a 10-second settlement delay.
        {' '}{data.observedSince ? `Archive starts ${fmtDateTime(data.observedSince)}.` : 'Collecting the first complete minute.'} This is research context; it does not place or block orders.</p>
      {!last ? <p>Waiting for a complete {tf} interval. Earlier candle history has no recorded trade-side data.</p> : <>
        <div className="row gap" style={{flexWrap:'wrap'}}>
          <strong>{fmtDateTime(last.openTime)}</strong><span>{last.covered ? 'Continuously observed' : 'Incomplete coverage'}</span>
          <span>Buy {n(last.buy)}</span><span>Sell {n(last.sell)}</span><span>Delta {n(last.delta)}</span><span>CVD {n(last.cvd)}</span><span>{last.trades} trades</span>
        </div>
        <p className="small muted">{last.observedMinutes}/{last.expectedMinutes} minutes · {n(last.unknown)} unclassified contracts
          {last.cvdStart != null ? ` · CVD starts ${fmtDateTime(last.cvdStart)}` : ' · CVD unavailable across this gap'}</p>
        <details><summary>Footprint · 15 largest price levels in the selected bar</summary>
          <table className="table"><thead><tr><th>Price</th><th>Buy contracts</th><th>Sell contracts</th><th>Delta</th></tr></thead><tbody>{levels.map(l => <tr key={l.price}><td>{n(l.price)}</td><td>{n(l.buyVolume)}</td><td>{n(l.sellVolume)}</td><td>{n(l.buyVolume - l.sellVolume)}</td></tr>)}</tbody></table>
          {!last.covered && <p>Observed prints only; this incomplete footprint is excluded from Pine calculations.</p>}
        </details>
      </>}
      <p className="small muted">{data.coverageBasis}. Retention: {data.retention}. CVD resets after gaps and starts at each view’s first covered bar; totals can differ with the history window.</p>
      {plot && <VelaChart key={`${symbol}:${tf}`} symbol={symbol} tf={tf} height={460} scripts={[deltaScript, cvdScript]} />}
    </>}
  </section>
}
