import { Link } from 'react-router-dom'
import { usePaperFleet } from '../../api/queries'
import { COPY_LABEL, OWN_LABEL, copyRuleText, copySharePct } from '../../lib/fleet'
import { QueryState, Section } from '../kit'

/** What the paper account is made of: its own list at full size, and shadow copies at the pilot size (decision 323). */
export function PaperFleetPanel() {
  const fleet = usePaperFleet()
  return (
    <Section variant="panel" title="Paper fleet">
      <QueryState {...fleet} data={fleet.data} empty="No fleet data yet." onRetry={() => fleet.refetch()}>
        {(d) => {
          const share = copySharePct(d.window)
          return (
            <div className="fleet">
              <div
                className="fleet-row"
                title="Scanners allocated to a market and timeframe by you or by promotion, subject to account sizing and risk checks"
              >
                <span>{OWN_LABEL}</span>
                <span className="mono accent">
                  {d.own.scanners} scanners · {d.own.pairs} pairs
                </span>
              </div>
              <div
                className="fleet-row"
                title={`Scanners the account took trades from in the last ${d.window.days} days without having them on the own list`}
              >
                <span>
                  {COPY_LABEL} · last {d.window.days} d
                </span>
                <span className="mono">{d.window.copyScanners} scanners</span>
              </div>
              <div
                className="fleet-row"
                title={`Entries the account opened in the last ${d.window.days} days`}
              >
                <span>Entries · last {d.window.days} d</span>
                <span className="mono">
                  {d.window.entries.own} own · {d.window.entries.copy} copy · {d.window.entries.unknown}{' '}
                  unknown
                  {share !== null ? ` (${share}% copies)` : ''}
                </span>
              </div>
              <div
                className="fleet-row"
                title={d.idle.length ? `Switched on with nothing allocated: ${d.idle.join(', ')}` : 'None'}
              >
                <span>Switched on, nothing allocated</span>
                <span className={`mono ${d.idle.length ? 'warn' : ''}`}>{d.idle.length}</span>
              </div>
              <p className="muted small mt">{copyRuleText(d.copy)}</p>
              <p className="small mt">
                <Link to="/trades?list=own">Own-list trades</Link> ·{' '}
                <Link to="/trades?list=copy">Copy trades</Link>
              </p>
            </div>
          )
        }}
      </QueryState>
    </Section>
  )
}
