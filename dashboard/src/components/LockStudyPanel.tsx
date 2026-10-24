import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { Panel } from './ui'

const r = (v: number, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`
const tone = (v: number) => (v > 0.05 ? 'gain' : v < -0.05 ? 'loss' : '')

/**
 * Decision 197: the early profit lock (+0.3R arms a stop at +0.1R) is off. Every day this replays it on the trades both
 * books took, from their recorded paths, so the case for switching it on for 15m is built from fresh evidence.
 */
export function LockStudyPanel() {
  const [days, setDays] = useState(14)
  const q = useQuery({ queryKey: ['research', 'lock', days], queryFn: () => api.lockStudy(days), refetchInterval: 10 * 60_000 })
  const d = q.data
  const recentDays = d ? [...new Set(d.daily.map((x) => x.day))].slice(0, 14) : []
  const cell = (day: string, book: string, tf: string) => d?.daily.find((x) => x.day === day && x.book === book && x.tf === tf)
  return (
    <Panel
      title={d ? `Early profit lock — off · what +${d.atR}R → +${d.keepR}R would have done` : 'Early profit lock — off'}
      right={
        <select className="select select-sm" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Window">
          {[7, 14, 30, 60].map((x) => <option key={x} value={x}>last {x} days</option>)}
        </select>
      }
    >
      {!d ? <p className="muted small">{q.isError ? 'The server did not answer /api/research/lock.' : 'Loading…'}</p> : (
        <>
          <p className="muted small">Each closed trade replayed from its recorded path: unchanged unless it reached +{d.atR}R and later fell back to +{d.keepR}R, where the rest is closed at the lock level with its own taker fee and slippage. Positive change means the lock would have done better. Decision 197: on for 15m only after two more weeks that agree; 1h and 4h stay as they are.</p>
          <div className="table-wrap">
            <table className="table small">
              <thead><tr><th>Book</th><th>TF</th><th className="num">Trades</th><th className="num">Lock fired</th><th className="num">Losses rescued</th><th className="num">Winners cut short</th><th className="num">R now</th><th className="num">R with lock</th><th className="num">Change</th><th className="num" title="Paths with at least two samples, and of those, how many have no gap over three minutes">Path coverage</th></tr></thead>
              <tbody>
                {d.rows.map((x) => (
                  <tr key={x.book + x.tf}>
                    <td>{x.book}</td><td className="mono">{x.tf}</td><td className="num mono">{x.trades}</td><td className="num mono">{x.fired}</td>
                    <td className="num mono">{x.rescued} · <span className="gain">{r(x.rescuedR)}R</span></td>
                    <td className="num mono">{x.cutShort} · <span className="loss">{r(-x.cutShortR)}R</span></td>
                    <td className="num mono">{r(x.baseR)}</td><td className="num mono">{r(x.lockR)}</td>
                    <td className={`num mono ${tone(x.deltaR)}`}><b>{r(x.deltaR)}</b></td>
                    <td className="num mono" title={`${x.armed} reached +${d.atR}R`}>{x.covered}/{x.withPath}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table className="table small">
              <caption className="sr-only">Change in R by the day trades closed</caption>
              <thead><tr><th>Closed</th><th className="num">Account 15m</th><th className="num">Shadow 15m</th><th className="num">Shadow 1h</th><th className="num">Shadow 4h</th></tr></thead>
              <tbody>
                {recentDays.map((day) => (
                  <tr key={day}>
                    <td className="mono">{day}</td>
                    {([['account', '15m'], ['shadow', '15m'], ['shadow', '1h'], ['shadow', '4h']] as const).map(([b, tf]) => {
                      const c = cell(day, b, tf)
                      return <td key={b + tf} className={`num mono ${c ? tone(c.deltaR) : 'muted'}`} title={c ? `${c.trades} trades, lock fired on ${c.fired}` : 'no trades'}>{c ? r(c.deltaR, 2) : '–'}</td>
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary className="small">How this is computed</summary>
            <ul className="plain-list small">{d.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
          </details>
        </>
      )}
    </Panel>
  )
}
