import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useJournalDetail } from '../api/queries'
import { Panel, Pill, Pnl, QueryState, Time } from './ui'
import { fmtMoney, fmtRecordedPrice as price, fmtR } from '../lib/format'

const money = (n: number | null) => n == null || !Number.isFinite(n) ? 'Unknown' : fmtMoney(n)

export function JournalDetailPanel({ book, id, onClose }: {book: string; id: number; onClose: () => void}) {
  const q = useJournalDetail(book, id)
  const ref = useRef<HTMLElement>(null)
  useEffect(() => { ref.current?.scrollIntoView({block:'start'}); ref.current?.focus({preventScroll:true}) }, [book,id])
  return <section id="journal-detail" ref={ref} tabIndex={-1}><Panel title={`Trade #${id} · ${book} journal`} right={<button className="btn btn-sm" onClick={onClose}>Close detail</button>}>
    <QueryState {...q} data={q.data} onRetry={() => q.refetch()}>{d => {
      const r = d.row
      return <>
        <p><b>{r.symbol} · {r.tf} · {r.side ?? 'Direction unknown'}</b> <Pill>{r.status}</Pill> {r.archived&&<Pill tone="warn">Before account reset</Pill>} <Link to={`/scanners/${encodeURIComponent(r.scannerId)}`}>{r.scannerName}</Link></p>
        {r.missingPosition && <p className="banner banner-warn">This pending order was deleted. Its cancellation event survives, but prices, size and placement time cannot be reconstructed.</p>}
        {r.accountingPending && <p className="banner banner-warn">Exchange accounting is incomplete. Reported P&amp;L is provisional.</p>}
        <div className="grid-2">
          <dl className="kv-list">
            <div><dt>{r.status === 'pending' ? 'Placed' : 'Entry'}</dt><dd>{r.entryAt === null ? 'Unknown' : <Time t={r.entryAt} mode="datetime" />}</dd></div>
            <div><dt>Exit / cancellation</dt><dd>{r.exitAt === null ? 'Not recorded' : <Time t={r.exitAt} mode="datetime" />}</dd></div>
            <div><dt>Entry → exit price</dt><dd>{price(r.entryPrice)} → {price(r.exitPrice)}</dd></div>
            <div><dt>Original SL → current / final SL</dt><dd>{price(r.slOriginal)} → {price(r.sl)}</dd></div>
            <div><dt>Targets</dt><dd>{r.targets?.length ? r.targets.map((p, i) => <div key={i}>TP{i + 1}: {price(p)} {r.targetsHit?.[i] ? '· hit' : '· not recorded as hit'}</div>) : 'Not recorded'}</dd></div>
            <div><dt>Levels source</dt><dd>{r.levelsSource ?? 'Unknown'}</dd></div>
            <div><dt>Exit reason</dt><dd>{r.exitReason ?? 'Not exited'}</dd></div>
          </dl>
          <dl className="kv-list">
            <div><dt>Contracts / remaining</dt><dd>{r.qty ?? 'Unknown'} / {r.qtyOpen ?? 'Unknown'}</dd></div>
            <div><dt>Entry notional / derived margin</dt><dd>{money(r.notional)} / {money(r.margin)}</dd></div>
            <div><dt>Recorded margin leverage</dt><dd>{r.marginLeverage === null ? 'Unknown' : `${r.marginLeverage}×`}</dd></div>
            <div><dt>{d.basketEntries?.length ? 'Basket risk at latest entry' : 'Original dollar risk'}</dt><dd>{money(r.risk)}</dd></div>
            <div><dt>Gross trading / commission</dt><dd>{money(r.grossTrading)} / {money(r.commission)}</dd></div>
            <div><dt>Recorded funding cashflow</dt><dd>{money(r.funding)}</dd></div>
            <div><dt>{r.status === 'closed' ? 'Closed net' : 'Realized net so far (no open valuation)'}</dt><dd>{r.realizedNet === null ? 'Unknown' : <Pnl value={r.realizedNet} />}</dd></div>
            <div><dt>Net R / peak R / worst R</dt><dd>{r.r === null ? 'Unknown' : fmtR(r.r)} / {r.peakR === null ? 'Unknown' : fmtR(r.peakR)} / {r.worstR === null ? 'Unknown' : fmtR(r.worstR)}</dd></div>
            <div><dt>ML probability at entry</dt><dd>{r.mlProbability === null ? 'Not recorded' : `${(r.mlProbability * 100).toFixed(1)}%`}</dd></div>
          </dl>
        </div>
        {r.pending && <p>Pending limit: {price(r.pending.price)} · expires {r.pending.expiresAt === null ? 'unknown' : <Time t={r.pending.expiresAt} mode="datetime" />}</p>}
        {!!d.basketEntries?.length && <>
          <h3>Basket entry ledger</h3>
          <p className="muted">One position, one shared margin budget. Each leg keeps its own fill and costs. Risk is set at the latest confirmed entry; later funding charges or a price gap can produce a loss beyond 1R. Expand the execution audit for the recorded calculation.</p>
          <div className="table-wrap"><table className="table"><thead><tr><th>Leg</th><th>Filled</th><th>Contracts</th><th>Price</th><th>Entry fee</th><th>Evidence</th></tr></thead><tbody>
            {d.basketEntries.map(b=><tr key={b.sequence}><td>{b.sequence}</td><td><Time t={b.at} mode="datetime" /></td><td>{b.qty}</td><td>{price(b.price)}</td><td>{money(b.fee)}</td><td>{b.context?.audit ? 'Recorded' : 'Legacy: not retained'}</td></tr>)}
          </tbody></table></div>
        </>}
        <h3>Entry signal</h3>
        {d.signal ? <p><Time t={d.signal.at} mode="datetime" /> · {d.signal.label} · {d.signal.message} · Current signal record: {d.signal.action}</p> : <p className="muted">No retained signal is linked to this record.</p>}
        <h3>Every recorded fill</h3>
        <div className="table-wrap"><table className="table"><thead><tr><th>Time</th><th>Reason</th><th>Contracts</th><th>Price</th><th>Commission</th><th>Fill P&amp;L / cashflow</th><th>Liquidity</th><th>Fee waiver</th></tr></thead><tbody>
          {r.fills?.map((f, i) => <tr key={i}><td><Time t={f.at} mode="datetime" /></td><td>{f.reason}</td><td>{f.qty}</td><td>{price(f.price)}</td><td>{money(f.fee)}</td><td>{money(f.pnl)}</td><td>{f.liquidity ?? 'Unknown'}</td><td>{f.feeWaived === undefined ? 'Unknown' : f.feeWaived ? 'Yes' : 'No'}</td></tr>)}
          {!r.fills?.length && <tr><td colSpan={8}>{r.fills === null ? 'Fill data unavailable.' : 'No fills recorded.'}</td></tr>}
        </tbody></table></div>
        <details><summary>Order ledger and execution prices ({d.orders.length})</summary><div className="table-wrap"><table className="table"><thead><tr><th>Time</th><th>Reason</th><th>Side</th><th>Qty</th><th>Fill</th><th>Role</th><th>Source</th><th>Bid / ask</th></tr></thead><tbody>{d.orders.map(o => <tr key={o.id}><td><Time t={o.at} mode="datetime" /></td><td>{o.reason}</td><td>{o.side}</td><td>{o.qty}</td><td>{price(o.price)}</td><td>{o.liquidity??'Unknown'}</td><td>{o.price_source ?? 'Unknown'}</td><td>{price(o.bid)} / {price(o.ask)}</td></tr>)}</tbody></table></div></details>
        <h3>Decision timeline</h3>
        {d.decisions.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Time</th><th>Stage</th><th>Reason</th></tr></thead><tbody>{d.decisions.map((e, i) => <tr key={i}><td><Time t={e.at} mode="datetime" /></td><td>{e.stage}</td><td>{e.reason ?? '—'}</td></tr>)}</tbody></table></div> : <p className="muted">No decision events retained for this trade.</p>}
        <p>Path samples: {d.pathCoverage.samples}. {!r.missingPosition && <Link className="btn btn-sm" to={`/trades/${r.id}/replay`}>Replay trade path</Link>}</p>
        <details><summary>Frozen policy, ML features and entry execution audit</summary><p>Scope: {r.evidenceScope} · Policy: {r.policyId ?? 'Not recorded'} · Configuration: {r.configFingerprint ?? 'Not recorded'}</p><pre className="small" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({policy:d.policy,features:d.features,entryExecution:d.entryExecution,entryFillEvidence:d.entryFillEvidence,basketEntries:d.basketEntries},null,2)}</pre></details>
        <p className="small muted">{d.caveats.join(' ')}</p>
      </>
    }}</QueryState>
  </Panel></section>
}
