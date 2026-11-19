import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { REFRESH } from '../api/refreshPolicy'
import {
  Callout,
  DataTable,
  EmptyState,
  QueryState,
  RouteHeader,
  Section,
  Stat,
  StatGrid,
  TabPanel,
  Tabs,
  Toolbar,
} from '../components/kit'
import { PairHeatmap } from '../components/PairHeatmap'
import { ScannerExitStudy } from '../components/ScannerExitStudy'

import type { TradeMonitorView } from '../api/tradeMonitor'
import { fmtAge, fmtPnl, fmtPnlUsd } from '../lib/format'
import { evidenceBook, heatLabel, type HeatMetric } from '../lib/monitorHeatmap'
import { useNow } from '../lib/useNow'
import '../styles/pages/monitor.css'

const tone = (n: number | null) => (n === null ? '' : n < 0 ? 'loss' : n > 0 ? 'gain' : '')
export function TradeMonitor() {
  const q = useQuery({
    queryKey: ['trade-monitor'],
    queryFn: api.tradeMonitor,
    refetchInterval: REFRESH.live,
  })
  const [tab, setTab] = useState<'pairs' | 'exits'>('pairs'),
    [metric, setMetric] = useState<HeatMetric>('paper'),
    [search, setSearch] = useState(''),
    [activeOnly, setActiveOnly] = useState(false)
  const [params, setParams] = useSearchParams()
  const selected = params.get('pair') ?? ''
  const now = useNow(1000)
  const select = (symbol: string) => setParams(symbol ? { pair: symbol } : {})
  return (
    <div className="page monitor-page">
      <RouteHeader
        sub="Trade health, observed order flow and what-if exits for every pair. Advisory only: this page never opens, closes or resizes a trade."
        actions={
          <Link className="btn btn-sm" to="/trades">
            Open journals
          </Link>
        }
      />
      <QueryState {...q} data={q.data} onRetry={() => q.refetch()}>
        {(d) => {
          const pairs = d.pairs.filter(
            (p) => (!activeOnly || p.active) && p.symbol.toLowerCase().includes(search.toLowerCase()),
          )
          const positions = d.positions.filter((p) => !selected || p.symbol === selected),
            trials = d.trials.filter((t) => !selected || t.symbol === selected)
          const stale = !d.at || now - d.at > 20000
          const quick = (symbol: string) => {
            setSearch('')
            select(symbol)
          }
          return (
            <>
              {stale && (
                <Callout
                  tone="warn"
                  title={d.at ? 'Observations are delayed' : 'Collecting first observations'}
                >
                  {d.at
                    ? 'Treat the state shown here as stale.'
                    : 'Complete flow needs five settled minutes.'}
                </Callout>
              )}
              {d.marketError && (
                <Callout tone="danger" title="Market data problem">
                  {d.marketError}
                </Callout>
              )}
              <StatGrid min={150}>
                <Stat label="Pairs" value={d.pairs.length} sub="in the book" />
                <Stat
                  label="Observed"
                  value={d.connections.symbols}
                  tone="accent"
                  sub="pairs the collector watches"
                />
                <Stat
                  label="Depth under 10 s"
                  value={d.pairs.filter((p) => p.depthFresh).length}
                  sub="fresh order book"
                />
                <Stat
                  label="Complete 5m flow"
                  value={d.pairs.filter((p) => p.flow?.covered).length}
                  sub="buy and sell balance"
                />
                <Stat
                  label="Last update"
                  value={d.at ? fmtAge(now - d.at) : 'warming up'}
                  tone={stale ? 'warn' : undefined}
                  sub={d.at ? 'ago' : 'collector starting'}
                />
              </StatGrid>
              <Tabs
                label="Trade monitor views"
                idPrefix="mon"
                value={tab}
                onChange={setTab}
                items={[
                  { id: 'pairs', label: 'Pairs and open trades', count: positions.length },
                  { id: 'exits', label: 'What-if exits', count: trials.length },
                ]}
              />
              <TabPanel id="pairs" value={tab} idPrefix="mon">
                <div className="mon-stack">
                  <Section
                    title="Pair heatmap"
                    hint="Rolling 24 h results. Click a pair to inspect it; click again to clear."
                  >
                    <Toolbar
                      end={
                        <span className="muted small">
                          Quick pick{' '}
                          <button type="button" className="btn btn-xs" onClick={() => quick('INITUSD')}>
                            INIT
                          </button>{' '}
                          <button type="button" className="btn btn-xs" onClick={() => quick('PARTIUSD')}>
                            PARTI
                          </button>
                        </span>
                      }
                    >
                      <label className="mon-field">
                        Colour by
                        <select
                          className="select select-sm"
                          value={metric}
                          onChange={(e) => setMetric(e.target.value as HeatMetric)}
                        >
                          <option value="paper">Paper closed net R · 24h</option>
                          <option value="shadow">Shadow closed net R · 24h</option>
                          <option value="open">Worst open trade · price R</option>
                          <option value="market">Market change · 24h</option>
                          <option value="flow">Buy/sell imbalance · 5m</option>
                        </select>
                      </label>
                      <label className="mon-field">
                        Find a pair
                        <input
                          className="input input-sm"
                          type="search"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder="INIT, PARTI, BTC…"
                        />
                      </label>
                      <label className="mon-field mon-check">
                        <input
                          type="checkbox"
                          checked={activeOnly}
                          onChange={(e) => setActiveOnly(e.target.checked)}
                        />{' '}
                        Observed pairs only
                      </label>
                    </Toolbar>
                    <Section variant="panel">
                      <PairHeatmap
                        pairs={pairs}
                        metric={metric}
                        selected={selected}
                        onSelect={select}
                        now={now}
                        stale={stale}
                      />
                      {!pairs.length && (
                        <EmptyState
                          title="No matching pairs"
                          hint="Clear the search box or untick Observed pairs only."
                          action={
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => {
                                setSearch('')
                                setActiveOnly(false)
                              }}
                            >
                              Clear filters
                            </button>
                          }
                        />
                      )}
                      <p className="small muted mon-legend">
                        <span className="gain">Green: positive</span> ·{' '}
                        <span className="loss">Red: negative</span> · Grey: no observations or closed trades.
                        Flow is buy/sell balance, not a profit forecast. Shadow excludes tracker and
                        experimental trades.
                      </p>
                    </Section>
                  </Section>
                  <Section
                    title={`${selected || 'All pairs'} · open trades`}
                    actions={
                      selected ? (
                        <button type="button" className="btn btn-sm" onClick={() => select('')}>
                          Show all pairs
                        </button>
                      ) : undefined
                    }
                  >
                    <Section variant="panel" pad={false}>
                      <DataTable
                        rows={positions}
                        rowKey={(p) => `${p.id}:${p.entryAt}`}
                        caption="Open trades"
                        filterKey={selected}
                        pageSize={25}
                        emptyLabel="No open positions here"
                        columns={[
                          {
                            key: 'pair',
                            header: 'Pair / scanner',
                            value: (p) => p.symbol,
                            render: (p) => (
                              <>
                                <Link to={`/trades/${p.id}/replay`}>
                                  {p.symbol} #{p.id}
                                </Link>
                                <div className="muted small">{p.scanner}</div>
                              </>
                            ),
                          },
                          { key: 'book', header: 'Book', value: (p) => evidenceBook(p.book, p.scope) },
                          {
                            key: 'side',
                            header: 'Side / TF',
                            value: (p) => p.side,
                            render: (p) => (
                              <>
                                {p.side} · {p.tf}
                              </>
                            ),
                          },
                          {
                            key: 'r',
                            header: 'Price R',
                            value: (p) => p.r,
                            numeric: true,
                            render: (p) => <span className={tone(p.r)}>{heatLabel(p.r, 'open')}</span>,
                          },
                          {
                            key: 'peak',
                            header: 'Observed peak',
                            value: (p) => p.peak,
                            numeric: true,
                            render: (p) => heatLabel(p.peak, 'open'),
                          },
                          {
                            key: 'state',
                            header: 'State',
                            value: (p) => p.state,
                            render: (p) => (
                              <>
                                {p.state.replaceAll('-', ' ')}
                                <div className="muted small">{p.reason}</div>
                              </>
                            ),
                          },
                          {
                            key: 'last',
                            header: 'History',
                            value: (p) => p.lastAt,
                            render: (p) => (
                              <>
                                {p.complete ? 'Since entry' : 'Partial coverage'}
                                <div className="muted small">{fmtAge(now - p.lastAt)} ago</div>
                              </>
                            ),
                          },
                        ]}
                      />
                    </Section>
                  </Section>
                </div>
              </TabPanel>
              <TabPanel id="exits" value={tab} idPrefix="mon">
                <div className="mon-stack">
                  <Callout tone="warn" title="Unproven controls, no execution.">
                    Frozen controls record what an earlier exit would have done. A result is comparable only
                    after both the what-if fill and the real trade have finished. More early exits do not mean
                    better performance.
                  </Callout>
                  {d.scannerExitStudy && <ScannerExitStudy study={d.scannerExitStudy} />}
                  {d.invalidationStudy && (
                    <Section
                      title="ARIA · prospective shadow comparison"
                      hint="Elliott Wave · 15m · never changes paper exits"
                    >
                      <p className="small muted">{d.invalidationStudy.description}</p>
                      <DataTable
                        rows={d.invalidationStudy.groups}
                        rowKey={(g) => g.policyId}
                        caption="ARIA signal-wick invalidation comparison"
                        emptyLabel="Waiting for a new eligible ARIA shadow trade. Earlier trades are not enrolled."
                        columns={[
                          {
                            key: 'policy',
                            header: 'Frozen policy',
                            render: (g) => <span title={g.policyId}>{g.policyId.slice(0, 10)}</span>,
                          },
                          {
                            key: 'coverage',
                            header: 'Covered / closed / enrolled',
                            render: (g) => `${g.covered} / ${g.closed} / ${g.enrolled}`,
                          },
                          { key: 'missing', header: 'Unavailable', render: (g) => g.unavailable },
                          {
                            key: 'delta',
                            header: 'Δ net R',
                            render: (g) => (g.covered ? heatLabel(g.deltaR, 'paper') : '—'),
                          },
                          {
                            key: 'stress',
                            header: 'Stress Δ R',
                            render: (g) => (g.covered ? heatLabel(g.stressDeltaR, 'paper') : '—'),
                          },
                          {
                            key: 'stops',
                            header: 'Full SLs before → after',
                            render: (g) => `${g.stopsBefore} → ${g.stopsAfter}`,
                          },
                          {
                            key: 'losses',
                            header: 'Losing trades before → after',
                            render: (g) => `${g.losersBefore} → ${g.losersAfter}`,
                          },
                          { key: 'cut', header: 'Winners cut short', render: (g) => g.winnersCut },
                        ]}
                      />
                      <p className="small muted">
                        Includes unchanged trades; policies stay separate. Stress adds delay and 5 bps adverse
                        execution. Better net profit and fewer full SLs must hold on new independent trades
                        before any paper change. These results never count toward promotion.
                      </p>
                    </Section>
                  )}
                  {d.replay?.entryInvalidationStudy && (
                    <Section title="Dedicated replay · ARIA, INIT and PARTI">
                      <p>
                        {d.replay.entryInvalidationStudy.lastError
                          ? `Capture needs attention: ${d.replay.entryInvalidationStudy.lastError}`
                          : d.replay.entryInvalidationStudy.ready
                            ? 'Recording observed market data and five-second trade samples.'
                            : 'Starting capture.'}
                      </p>
                      <p className="small muted">
                        {d.replay.entryInvalidationStudy.lastSyncAt
                          ? `Last saved ${fmtAge(now - d.replay.entryInvalidationStudy.lastSyncAt)} ago. `
                          : 'Awaiting first durable save. '}
                        {(d.replay.entryInvalidationStudy.bytes / 1024 ** 2).toFixed(1)} MiB sealed ·{' '}
                        {d.replay.entryInvalidationStudy.dropped} dropped events ·{' '}
                        {d.replay.entryInvalidationStudy.failures} capture errors. Retention targets 21 days
                        within 4 GiB. Missing observations remain explicit gaps.
                      </p>
                    </Section>
                  )}
                  <Section title="Totals" hint="Cover all pairs, whatever pair is selected.">
                    <Summary data={d} />
                    <details>
                      <summary>Control definitions and accounting</summary>
                      <ul>
                        {d.rules.map((r) => (
                          <li key={r.id}>
                            <b>{r.name}:</b> {r.description}
                          </li>
                        ))}
                      </ul>
                      <p className="small muted">
                        Fresh executable depth after latency; partial fills and costs retained. Unpriced or
                        interrupted trials have no claimed profit. Comparisons never count toward promotion.
                        No recovery prediction model is active. {d.retention}
                      </p>
                    </details>
                  </Section>
                  <Section
                    title={`${selected || 'All pairs'} · trials`}
                    hint="The list follows your pair selection."
                    actions={
                      selected ? (
                        <button type="button" className="btn btn-sm" onClick={() => select('')}>
                          Show all pairs
                        </button>
                      ) : undefined
                    }
                  >
                    <Section variant="panel" pad={false}>
                      <DataTable
                        rows={trials}
                        rowKey={(t) => t.id}
                        caption="Exit trials"
                        filterKey={selected}
                        pageSize={25}
                        emptyLabel="No what-if exits yet"
                        columns={[
                          {
                            key: 'trade',
                            header: 'Trade',
                            value: (t) => t.symbol,
                            render: (t) => (
                              <>
                                <Link to={`/trades/${t.position_id}/replay`}>
                                  {t.symbol} #{t.position_id}
                                </Link>
                                <div className="muted small">{fmtAge(now - t.trigger_at)} ago</div>
                              </>
                            ),
                          },
                          {
                            key: 'book',
                            header: 'Book / control',
                            value: (t) => evidenceBook(t.book, t.scope),
                            render: (t) => (
                              <>
                                {evidenceBook(t.book, t.scope)}
                                <div className="muted small">
                                  {d.rules.find((r) => r.id === t.rule)?.name ?? t.rule}
                                </div>
                              </>
                            ),
                          },
                          {
                            key: 'status',
                            header: 'Status',
                            value: (t) => t.status,
                            render: (t) => (
                              <>
                                {t.status === 'filled' && t.actual_net === null
                                  ? 'Filled · awaiting actual close'
                                  : t.status}
                                <div className="muted small">
                                  {t.error ??
                                    (t.market_filled < t.market_qty
                                      ? `${t.market_filled}/${t.market_qty} observed contracts`
                                      : '')}
                                </div>
                              </>
                            ),
                          },
                          { key: 'whatif', header: 'What-if', render: (t) => trialValue(t, t.net) },
                          { key: 'actual', header: 'Actual', render: (t) => trialValue(t, t.actual_net) },
                          {
                            key: 'difference',
                            header: 'Difference',
                            render: (t) => <span className={tone(t.delta)}>{trialValue(t, t.delta)}</span>,
                          },
                        ]}
                      />
                    </Section>
                  </Section>
                </div>
              </TabPanel>
            </>
          )
        }}
      </QueryState>
    </div>
  )
}
function Summary({ data }: { data: TradeMonitorView }) {
  return (
    <div className="table-wrap">
      <table className="table small">
        <thead>
          <tr>
            <th>Book / control</th>
            <th>Trials</th>
            <th>Resolved</th>
            <th>Unavailable</th>
            <th>Δ net R</th>
            <th>Δ cash</th>
            <th>Winners lost</th>
          </tr>
        </thead>
        <tbody>
          {data.summary.map((s) => (
            <tr key={`${s.book}:${s.scope}:${s.rule}`}>
              <td>
                {evidenceBook(s.book, s.scope)} · {data.rules.find((r) => r.id === s.rule)?.name}
                <div className="small muted">{s.scope}</div>
              </td>
              <td>{s.trials}</td>
              <td>{s.resolved}</td>
              <td>{s.unavailable}</td>
              <td className={tone(s.resolved ? s.deltaR : null)}>
                {s.resolved ? heatLabel(s.deltaR, 'paper') : '—'}
              </td>
              <td>{s.book === 0 && s.resolved ? `$${fmtPnl(s.deltaUsd)}` : '—'}</td>
              <td>{s.winnersLost}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function trialValue(trial: TradeMonitorView['trials'][number], value: number | null) {
  return value === null
    ? '—'
    : trial.book === 0
      ? fmtPnlUsd(value)
      : trial.risk > 0
        ? heatLabel(value / trial.risk, 'shadow')
        : 'Unknown risk'
}
