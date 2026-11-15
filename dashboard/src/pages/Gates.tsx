import { Link } from 'react-router-dom'
import { useGates } from '../api/queries'
import type { Gate, GateState } from '../api/types'
import { Callout, Pill, QueryState, RouteHeader, Section, Stat, StatGrid } from '../components/kit'

import '../styles/pages/gates.css'

const TONE: Record<GateState, 'ok' | 'accent' | 'danger' | 'muted' | 'warn'> = {
  open: 'ok',
  armed: 'accent',
  blocking: 'danger',
  off: 'muted',
  attention: 'warn',
}
const WORD: Record<GateState, string> = {
  open: 'open',
  armed: 'armed',
  blocking: 'blocking',
  off: 'off',
  attention: 'needs you',
}
const ORDER = ['Account', 'Market', 'Trade', 'Pipeline', 'Real money']

/** Every gate between a setup and real money, with its live state and what would clear it (decision 99). */
export function Gates() {
  const q = useGates()
  return (
    <div className="page gates-page">
      <RouteHeader sub="What stands between a setup and real money right now, and what would clear each gate. Blocking stops entries now, armed would, needs you is yours to act on." />
      <QueryState {...q} data={q.data} empty="No gates reported." onRetry={() => q.refetch()}>
        {(d) => {
          const blocking = d.gates.filter((g) => g.state === 'blocking')
          const attention = d.gates.filter((g) => g.state === 'attention')
          const armed = d.gates.filter((g) => g.state === 'armed').length
          return (
            <>
              <StatGrid min={150}>
                <Stat
                  label="Blocking now"
                  value={d.summary.blocking}
                  tone={d.summary.blocking ? 'loss' : 'muted'}
                  sub="stopping entries"
                />
                <Stat
                  label="Needs you"
                  value={d.summary.attention}
                  tone={d.summary.attention ? 'warn' : 'muted'}
                  sub="waiting on an operator"
                />
                <Stat
                  label="Armed"
                  value={armed}
                  tone={armed ? 'accent' : 'muted'}
                  sub="would block if tripped"
                />
                <Stat
                  label="Gates"
                  value={d.gates.length}
                  sub={`judged ${new Date(d.at).toISOString().slice(11, 19)} UTC`}
                />
              </StatGrid>
              {blocking.length > 0 && (
                <Callout tone="warn" title="Blocking now">
                  {blocking.map((g) => g.name).join(', ')}. New entries are stopped until{' '}
                  {blocking.length === 1 ? 'this clears' : 'these clear'}; the next step is in the table
                  below.
                </Callout>
              )}
              {attention.length > 0 && (
                <Callout tone="info" title="Needs you">
                  {attention.map((g) => g.name).join(', ')}.
                </Callout>
              )}
              {ORDER.filter((g) => d.gates.some((x) => x.group === g)).map((group) => (
                <Section key={group} title={group}>
                  <div className="panel">
                    <div className="table-wrap">
                      <table className="table gates-table gates-table-v2">
                        <thead>
                          <tr>
                            <th scope="col">Gate</th>
                            <th scope="col">State</th>
                            <th scope="col">Now</th>
                            <th scope="col">Rule</th>
                            <th scope="col">Next step</th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.gates
                            .filter((x) => x.group === group)
                            .map((g: Gate) => (
                              <tr key={g.key} className={g.state === 'blocking' ? 'row-loss' : ''}>
                                <th scope="row" className="gate-name" data-label="Gate">
                                  {g.name}
                                </th>
                                <td data-label="State">
                                  <Pill tone={TONE[g.state]}>{WORD[g.state]}</Pill>
                                </td>
                                <td className="small gate-now" data-label="Now">
                                  {g.value}
                                </td>
                                <td className="muted small gate-rule" data-label="Rule">
                                  {g.rule}
                                </td>
                                <td className="small" data-label="Next step">
                                  {g.href ? <Link to={g.href}>{g.next}</Link> : g.next}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </Section>
              ))}
            </>
          )
        }}
      </QueryState>
    </div>
  )
}
