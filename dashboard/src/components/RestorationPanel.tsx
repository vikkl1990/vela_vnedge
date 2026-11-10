import type {IncubatorPair} from '../api/types'
import {Panel,Pill} from './ui'
import {fmtR,timeAgo} from '../lib/format'

export function RestorationPanel({pairs}:{pairs:IncubatorPair[]}) {
  const enrolled=pairs.filter(p=>p.restoration)
  if(!enrolled.length)return null
  const passed=enrolled.filter(p=>p.restoration?.passed).length
  return <Panel title="Restored cells · forward shadow evaluation" right={<Pill tone={passed?'ok':'warn'}>{passed}/{enrolled.length} passed</Pill>}>
    <p className="small muted">Comparable full-fee history is retained with its original costs. These cells need new shadow trades after enrollment before they can qualify for paper copying, promotion or evidence-based sizing. Passing this test still requires the normal liquidity, execution and risk checks.</p>
    <p className="small muted">The test keeps the timeframe’s promotion requirements, with at least 20 new closes, positive results in both time halves and positive net R after an extra 0.05% round-trip cost. Restarting does not reset it. Gated signals and old trades do not count as forward results.</p>
    <div className="table-wrap"><table className="table">
      <thead><tr><th>Scanner / market</th><th>Started</th><th>Forward sample</th><th>Net R</th><th>After cost stress</th><th>Status / remaining evidence</th></tr></thead>
      <tbody>{enrolled.map(p=>{const e=p.restoration!;return <tr key={p.id}>
        <td>{p.scannerName}<div className="small mono muted">{p.symbol} · {p.tf} · {p.stage}</div></td>
        <td title={e.startedAt?new Date(e.startedAt).toISOString():undefined}>{e.startedAt?timeAgo(e.startedAt):'New window required'}</td>
        <td className="mono">{e.stats&&e.requirements?<>{e.stats.trades}/{e.requirements.minTrades} closes<div className="small muted">{e.stats.days.toFixed(1)}/{e.requirements.minDays} days</div></>:'—'}</td>
        <td className="mono">{e.stats?fmtR(e.stats.netR):'—'}</td>
        <td className="mono">{typeof e.stressedR==='number'?fmtR(e.stressedR):'Unverified'}</td>
        <td><Pill tone={e.passed?'ok':'warn'}>{e.passed?'Evidence passed':'Shadow only'}</Pill><div className="small muted">{e.passed?'Entry checks still apply':e.reasons.join('; ')}</div></td>
      </tr>})}</tbody>
    </table></div>
  </Panel>
}
