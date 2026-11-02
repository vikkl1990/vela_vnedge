import { VelaChart, type ChartScript } from './VelaChart'
import type { ChartVenue } from './venues'

export function CryptoComparison({ symbol, tf, scripts, open, onOpenChange }: {symbol: string; tf: string; scripts: ChartScript[]; open: boolean; onOpenChange: (open: boolean) => void}) {
  if (!['BTCUSD', 'ETHUSD', 'SOLUSD'].includes(symbol)) return <section id="chart-venues" className="panel chart-section" style={{padding: 16}}><h2>Crypto venue comparison</h2><p>Venue comparison currently covers BTC, ETH and SOL. Choose one in the <a href="#chart-price">symbol selector</a>.</p></section>
  const venues: Array<[ChartVenue, string]> = [['binance', 'Binance · USDT perpetual'], ['hyperliquid', 'Hyperliquid · perpetual'], ['coinbase', 'Coinbase · USD spot']]
  return <section id="chart-venues" className="panel chart-section" style={{padding: 16}}>
    <button className="btn" aria-expanded={open} onClick={() => onOpenChange(!open)}>{open ? 'Close' : 'Open'} crypto venue comparison</button>
    <p className="small muted">{symbol} · {tf} · Same selected scanners on each venue’s own candles. Delta entries, stops and journal marks are shown on the Delta chart above.</p>
    {open && <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,450px),1fr))', gap:12}}>{venues.map(([venue,label]) => <div key={`${venue}:${symbol}`}><h3>{label}</h3><VelaChart venue={venue} symbol={symbol} tf={tf} height={440} scripts={scripts} /></div>)}</div>}
  </section>
}
