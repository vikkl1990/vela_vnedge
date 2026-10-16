import { Link } from 'react-router-dom'
import { useGates } from '../api/queries'
import type { Gate, GateState } from '../api/types'
import { PageTitle, Panel, Pill, QueryState } from '../components/ui'

const TONE: Record<GateState, 'ok' | 'accent' | 'danger' | 'muted' | 'warn'> = { open: 'ok', armed: 'accent', blocking: 'danger', off: 'muted', attention: 'warn' }
const WORD: Record<GateState, string> = { open: 'open', armed: 'armed', blocking: 'blocking', off: 'off', attention: 'needs you' }
const ORDER = ['Account', 'Market', 'Trade', 'Pipeline', 'Real money']

/** Every gate between a setup and real money, with its live state and what would clear it (decision 99). */
export function Gates() {
  const q = useGates()
  return (
    <div className="page">
      <PageTitle pre="Every gate," accent="in one" post="place." sub="What stands between a setup and real money right now. Each row reads the state the gate itself acts on; blocking stops entries now, armed would, attention is yours." />
      <QueryState {...q} data={q.data} empty="No gates reported." onRetry={() => q.refetch()}>
        {(d) => (
          <>
            <div className={`banner small ${d.summary.blocking ? 'banner-warn' : ''}`} role="status">
              <b>{d.summary.blocking}</b> blocking · <b>{d.summary.attention}</b> need you · judged {new Date(d.at).toISOString().slice(11, 19)} UTC
            </div>
            {ORDER.filter((g) => d.gates.some((x) => x.group === g)).map((group) => (
              <Panel key={group} title={group} pad={false}>
                <table className="table">
                  <thead>
                    <tr><th>Gate</th><th>State</th><th>Now</th><th>Rule</th><th>Next step</th></tr>
                  </thead>
                  <tbody>
                    {d.gates.filter((x) => x.group === group).map((g: Gate) => (
                      <tr key={g.key} className={g.state === 'blocking' ? 'row-loss' : ''}>
                        <td><b>{g.name}</b></td>
                        <td><Pill tone={TONE[g.state]}>{WORD[g.state]}</Pill></td>
                        <td className="mono small">{g.value}</td>
                        <td className="muted small">{g.rule}</td>
                        <td className="small">{g.href ? <Link to={g.href}>{g.next}</Link> : g.next}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            ))}
          </>
        )}
      </QueryState>
    </div>
  )
}
