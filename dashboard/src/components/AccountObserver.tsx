import { useExecutionQuality } from '../api/queries'
import { Panel, Pill, QueryState, Time } from './ui'

export function AccountObserverPanel() {
  const q = useExecutionQuality()
  return <Panel title="Production account observer" right={<Pill tone="accent">Read only · India</Pill>}>
    <QueryState {...q} data={q.data} onRetry={() => q.refetch()}>{data => {
      const o = data.observer
      if (!o) return <p>Observer status unavailable on this server.</p>
      const a = o.account
      return <>
        <p><Pill tone={o.state === 'observing' ? 'ok' : 'warn'}>{o.state}</Pill> {o.message} {o.syncing && <span className="muted">Sync in progress…</span>}</p>
        <p className="small muted">Observes the saved production account while paper trading continues. This component can read exchange data only.</p>
        {a && <>
          <div className="grid-2">
            <dl className="kv-list">
              <div><dt>Account reference</dt><dd className="mono">{a.label}</dd></div>
              <div><dt>Snapshot started</dt><dd><Time t={a.snapshotStartedAt} mode="datetime" /></dd></div>
              <div><dt>Complete sync</dt><dd><Time t={a.completedAt} mode="ago" /></dd></div>
              <div><dt>Actual exchange exposure</dt><dd>{a.snapshot.positions.length} positions · {a.snapshot.orders.length} open orders</dd></div>
            </dl>
            <dl className="kv-list">
              <div><dt>History begins</dt><dd><Time t={a.historyFrom} mode="datetime" /></dd></div>
              <div><dt>History imported through</dt><dd><Time t={a.historyThrough} mode="datetime" /></dd></div>
              <div><dt>Unimported tail</dt><dd>{Math.ceil(a.historyLagMs / 1000)} seconds</dd></div>
              <div><dt>Records</dt><dd>{a.counts.find(c => c.kind === 'fills')?.n ?? 0} fills · {a.counts.find(c => c.kind === 'wallet')?.n ?? 0} wallet entries</dd></div>
            </dl>
          </div>
          <div className="table-wrap"><table className="table"><thead><tr><th>Asset</th><th>Exchange balance</th><th>Available</th><th>Fee credit balance</th></tr></thead><tbody>
            {a.snapshot.balances.map(b => <tr key={b.asset}><td>{b.asset}</td><td>{b.balance ?? 'Unknown'}</td><td>{b.available ?? 'Unknown'}</td><td>{b.tradingFeeCredit ?? 'Unknown'}</td></tr>)}
            {!a.snapshot.balances.length && <tr><td colSpan={4}>Delta returned no wallet balances.</td></tr>}
          </tbody></table></div>
          <details><summary>Observed positions and orders</summary>
            <div className="table-wrap"><table className="table"><thead><tr><th>Product</th><th>Contracts (signed)</th><th>Entry price</th></tr></thead><tbody>{a.snapshot.positions.map(p => <tr key={p.productId}><td>{p.symbol ?? `Product ${p.productId}`}</td><td>{p.size}</td><td>{p.entryPrice ?? 'Unknown'}</td></tr>)}</tbody></table></div>
            <div className="table-wrap"><table className="table"><thead><tr><th>Order</th><th>Product</th><th>Side</th><th>Remaining</th><th>State</th><th>Reduce only</th><th>Stop price</th></tr></thead><tbody>{a.snapshot.orders.map(r => <tr key={r.id}><td>{r.id}</td><td>{r.symbol ?? r.productId}</td><td>{r.side}</td><td>{r.unfilled}/{r.size}</td><td>{r.state}</td><td>{r.reduceOnly === null ? 'Unknown' : r.reduceOnly ? 'Yes' : 'No'}</td><td>{r.stopPrice ?? 'Not reported'}</td></tr>)}</tbody></table></div>
          </details>
          <details><summary>Recent accounting evidence</summary><div className="table-wrap"><table className="table"><thead><tr><th>Time</th><th>Type</th><th>Asset</th><th>Wallet amount</th><th>Fill commission</th><th>Fee / credit detail</th></tr></thead><tbody>{a.recent.map(r => <tr key={`${r.kind}:${r.id}`}><td><Time t={r.at} mode="datetime" /></td><td>{r.transactionType ?? r.kind}</td><td>{r.asset ?? 'Unknown'}</td><td>{r.kind === 'wallet' ? r.amount ?? 'Unknown' : '—'}</td><td>{r.kind === 'fills' ? r.commission ?? 'Unknown' : '—'}</td><td>{r.feeDetails ? Object.entries(r.feeDetails).map(([k, v]) => `${k}: ${v}`).join(' · ') : 'Not reported'}</td></tr>)}</tbody></table></div></details>
          <p className="small"><Pill tone="warn">Accounting {a.accountingStatus}</Pill></p>
          <p className="small muted">{a.limitations}</p>
        </>}
      </>
    }}</QueryState>
  </Panel>
}
