import { useState } from 'react'
import { VelaChart, type ChartScript } from './VelaChart'
import type { ChartVenue } from './venues'

export function CryptoComparison({ symbol, tf, scripts }: {symbol: string; tf: string; scripts: ChartScript[]}) {
  const [open, setOpen] = useState(false)
  if (!['BTCUSD', 'ETHUSD', 'SOLUSD'].includes(symbol)) return null
  const venues: Array<[ChartVenue, string]> = [['binance', 'Binance · USDT perpetual'], ['hyperliquid', 'Hyperliquid · perpetual'], ['coinbase', 'Coinbase · USD spot']]
  return <section className="panel" style={{padding: 16}}>
    <button className="btn" aria-expanded={open} onClick={() => setOpen(v => !v)}>{open ? 'Close' : 'Open'} crypto venue comparison</button>
    <p className="small muted">{symbol} · {tf} · Same selected scanners on each venue’s own candles. Delta entries, stops and journal marks are shown on the Delta chart above.</p>
    {open && <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,450px),1fr))', gap:12}}>{venues.map(([venue,label]) => <div key={`${venue}:${symbol}`}><h3>{label}</h3><VelaChart venue={venue} symbol={symbol} tf={tf} height={440} scripts={scripts} /></div>)}</div>}
  </section>
}
