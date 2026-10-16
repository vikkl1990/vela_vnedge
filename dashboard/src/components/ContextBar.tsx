import { useContext } from '../api/queries'

const arrow = (b: number) => (b > 0 ? '▲' : b < 0 ? '▼' : '–')
const tone = (b: number) => (b > 0 ? 'gain' : b < 0 ? 'loss' : 'muted')

/** The market as a whole, in one line (decision 101): the majors' bias, the crowded side, the smart-money book, the session. */
export function ContextBar() {
  const q = useContext()
  const g = q.data?.global
  if (!g) return null
  const btc = q.data?.markets.find((m) => m.coin === 'BTC')?.smart
  const eth = q.data?.markets.find((m) => m.coin === 'ETH')?.smart
  const net = (s: { netUsd: number; longs: number; shorts: number } | null | undefined) => (s ? <span className={s.netUsd > 0 ? 'gain' : s.netUsd < 0 ? 'loss' : 'muted'}>{s.netUsd >= 0 ? '+' : '−'}${(Math.abs(s.netUsd) / 1e6).toFixed(1)}M · {s.longs}L/{s.shorts}S</span> : <span className="muted">–</span>)
  const at = new Date(g.at).toISOString().slice(11, 16)
  return (
    <div className="context-bar small" title={`Public data, refreshed hourly (last ${at} UTC): Delta tickers, Hyperliquid contexts and our own smart-money cohort of ${g.cohort.wallets} profitable wallets, Binance ratios. Sources: ${Object.entries(g.sources).map(([k, v]) => `${k} ${v}`).join(', ')}`}>
      <span className="ctx"><b>BTC</b> <span className={tone(g.bias.BTC.h4)}>4h {arrow(g.bias.BTC.h4)}</span> <span className={tone(g.bias.BTC.d1)}>1d {arrow(g.bias.BTC.d1)}</span></span>
      <span className="ctx"><b>ETH</b> <span className={tone(g.bias.ETH.h4)}>4h {arrow(g.bias.ETH.h4)}</span> <span className={tone(g.bias.ETH.d1)}>1d {arrow(g.bias.ETH.d1)}</span></span>
      <span className="ctx" title="Average funding across the fleet's markets: positive means longs pay, the crowd is long"><b>funding</b> <span className={g.fundingSkewPct == null ? 'muted' : g.fundingSkewPct > 0 ? 'warn' : 'gain'}>{g.fundingSkewPct == null ? '–' : `${g.fundingSkewPct >= 0 ? '+' : ''}${(g.fundingSkewPct * 100).toFixed(3)}%`}</span></span>
      <span className="ctx" title="Our smart-money cohort's net book on Hyperliquid: long minus short in USD, and wallet counts"><b>smart BTC</b> {net(btc)}</span>
      <span className="ctx"><b>smart ETH</b> {net(eth)}</span>
      <span className="ctx"><b>session</b> <span className="mono">{g.session}</span></span>
      {Object.values(g.sources).some((v) => v === 'failed') && <span className="ctx loss">a source failed</span>}
    </div>
  )
}
