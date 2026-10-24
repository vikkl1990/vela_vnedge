import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { useHealth } from '../api/queries'
import { useAuth } from '../auth/AuthGate'
import type { IncubatorPair } from '../api/types'
import { Clocks, Evidence, Funnel } from '../components/incubatorBits'
import { clockRank } from '../lib/incubatorLogic'
import { ConfirmDialog, Empty, PageTitle, Panel, Pill, QueryState } from '../components/ui'
import { timeAgo } from '../lib/format'
import { gateMinimums } from '../lib/incubatorLogic'

/**
 * Decision 121: the operator's queue. Everything that waits for a decision, ranked, each with its evidence and its
 * controls on the same card: the gate's proposals, the live cells whose demotion clock is about to run out, and the
 * faults the attention line raises. One screen, on a phone or a desktop, instead of the long pages it is drawn from.
 */
type Action = 'approve' | 'reject' | 'demote'

export function Decisions() {
  const qc = useQueryClient()
  const auth = useAuth()
  const health = useHealth()
  const q = useQuery({ queryKey: ['incubator'], queryFn: api.incubator, refetchInterval: 60_000, staleTime: 20_000 })
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['incubator'] }); void qc.invalidateQueries({ queryKey: ['scanners'] }) }
  const decide = useMutation({ mutationFn: api.incubatorDecide, onSuccess: invalidate })
  const [confirm, setConfirm] = useState<{ pair: IncubatorPair; action: Action } | null>(null)
  const [renderedAt] = useState(() => Date.now())
  const attention = health.data?.attention ?? []
  const d = q.data
  const now = d?.lastRun?.at ?? renderedAt

  const cards = useMemo(() => {
    if (!d) return { proposals: [] as IncubatorPair[], clocks: [] as Array<{ p: IncubatorPair; rank: number }> }
    const proposals = d.pairs.filter((p) => p.stage === 'proposed' || p.stage === 'demote_proposed').sort((a, b) => Number(b.stage === 'demote_proposed') - Number(a.stage === 'demote_proposed') || a.since - b.since)
    const clocks = d.pairs.filter((p) => p.stage === 'live').map((p) => ({ p, rank: clockRank(p, d.config.demote, now) })).filter((x) => x.rank > 0).sort((a, b) => b.rank - a.rank || (b.p.funnel?.entries ?? 0) - (a.p.funnel?.entries ?? 0))
    return { proposals, clocks }
  }, [d, now])

  const total = cards.proposals.length + cards.clocks.filter((c) => c.rank === 2).length + attention.length
  return (
    <div className="page">
      <PageTitle pre="What waits" accent="for you," post="ranked." sub="Every decision with its evidence and its controls on one card: the gate's proposals first, then the live cells whose clock is about to run out, then what needs attention. The Incubator holds the full tables." />
      <QueryState {...q} data={d} empty="Incubator unavailable." onRetry={() => q.refetch()}>
        {(v) => (
          <>
            <div className="stat-strip" role="list">
              <span role="listitem"><span className="stat-k">To decide</span> <span className={`mono ${total ? 'warn' : ''}`}>{total}</span></span>
              <span role="listitem"><span className="stat-k">Proposals</span> <span className="mono">{cards.proposals.length}</span></span>
              <span role="listitem"><span className="stat-k">Clocks due</span> <span className="mono">{cards.clocks.filter((c) => c.rank === 2).length}</span> <span className="muted">· {cards.clocks.filter((c) => c.rank === 1).length} half way</span></span>
              <span role="listitem"><span className="stat-k">Attention</span> <span className="mono">{attention.length}</span></span>
              <span role="listitem" className="muted">last judged {v.lastRun ? timeAgo(v.lastRun.at) : 'never'} · <Link to="/incubator">Incubator</Link> · <Link to="/gates">Gates</Link></span>
            </div>

            {total === 0 && cards.clocks.length === 0 && <Empty label="Nothing waits for you." hint="Proposals appear when a cohort clears the gate; a live cell appears when a demotion clock passes half way; faults appear from the attention line." />}

            {attention.length > 0 && (
              <Panel title={`Needs attention (${attention.length})`}>
                <div className="decision-cards">
                  {attention.map((it) => (
                    <article key={it.key} className="decision-card urgent">
                      <div className="dc-head"><b>Fault</b><Pill tone="danger">attention</Pill></div>
                      <div className="small">{it.text}</div>
                      <div className="dc-actions"><Link to={it.href} className="btn btn-sm">Open</Link></div>
                    </article>
                  ))}
                </div>
              </Panel>
            )}

            <Panel title={`Proposals (${cards.proposals.length})`} right={<span className="muted small">promote, reject, or confirm a demotion</span>}>
              {cards.proposals.length === 0 ? <p className="muted small">No proposal waits. The gate proposes {v.config.gate.pool === 'cohort' ? 'a cohort' : 'a pair'} after {gateMinimums(v.config.gate)} with PF ≥ {v.config.gate.minPfR} and ≥{v.config.gate.minAvgR}R per trade.</p> : (
                <div className="decision-cards">
                  {cards.proposals.map((p) => (
                    <article key={p.id} className={`decision-card ${p.stage === 'demote_proposed' ? 'soon' : ''}`}>
                      <div className="dc-head">
                        <span><Link to={`/scanners/${p.scannerId}`} className="strong">{p.scannerName}</Link> <span className="mono">{p.symbol} {p.tf}</span></span>
                        <Pill tone={p.stage === 'proposed' ? 'ok' : 'danger'}>{p.stage === 'proposed' ? 'promote?' : 'demote?'}</Pill>
                      </div>
                      <div className="small">{p.stage === 'proposed' ? <Evidence s={p.gate?.stats ?? p.stats} g={v.config.gate} /> : <span>{p.gate?.reasons?.[0] ?? 'the gate proposes demotion'}</span>}</div>
                      {p.gate?.cohort && <div className="muted small">{p.gate.cohort}{p.gate.stats?.positiveMarkets !== undefined ? ` · ${p.gate.stats.positiveMarkets}/${p.gate.stats.marketsJudged} markets positive` : ''}</div>}
                      <div className="small"><Funnel f={p.funnel} /></div>
                      {p.gate?.strategyComparison && <div className="small"><Pill tone={p.gate.strategyComparison.preferred === 'script' ? 'ok' : 'muted'}>{p.gate.strategyComparison.preferred === 'script' ? 'own exits' : 'fleet exits'}</Pill> <span className="muted">{p.gate.strategyComparison.reason}</span></div>}
                      {p.market && !p.market.allowed && <div className="small"><Pill tone="danger">market out today</Pill> <span className="muted">{p.market.reasons.join(' · ').slice(0, 120)}</span></div>}
                      <div className="dc-head"><span className="muted small">waiting {timeAgo(p.since)}</span>
                        <div className="dc-actions">
                          {auth.canTrade ? (
                            <>
                              <button className="btn btn-sm btn-primary" onClick={() => setConfirm({ pair: p, action: 'approve' })}>{p.stage === 'proposed' ? 'Promote' : 'Demote'}</button>
                              <button className="btn btn-sm" onClick={() => setConfirm({ pair: p, action: 'reject' })}>{p.stage === 'proposed' ? 'Reject' : 'Keep live'}</button>
                            </>
                          ) : <span className="muted small">needs trade access</span>}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </Panel>

            <Panel title={`Live cells on a clock (${cards.clocks.length})`} right={<span className="muted small">market out {v.config.demote.marketOutDays ?? '–'} d · silent {v.config.demote.silentDays ?? '–'} d · cost-starved {v.config.demote.costStarvedRefusals ?? '–'} refusals</span>}>
              {cards.clocks.length === 0 ? <p className="muted small">No live cell is near a demotion.</p> : (
                <div className="decision-cards">
                  {cards.clocks.map(({ p, rank }) => (
                    <article key={p.id} className={`decision-card ${rank === 2 ? 'urgent' : 'soon'}`}>
                      <div className="dc-head">
                        <span><Link to={`/scanners/${p.scannerId}`} className="strong">{p.scannerName}</Link> <span className="mono">{p.symbol} {p.tf}</span></span>
                        <span><Clocks p={p} cfg={v.config.demote} now={now} /></span>
                      </div>
                      <div className="small">{p.stats ? `${p.stats.trades} account trades · ${p.stats.netR >= 0 ? '+' : ''}${p.stats.netR.toFixed(1)}R` : 'no account trade yet'}{p.market && !p.market.allowed ? <span className="muted"> · {p.market.reasons.join(' · ').slice(0, 100)}</span> : null}</div>
                      <div className="small"><Funnel f={p.funnel} /></div>
                      <div className="dc-actions">
                        {auth.isAdmin ? <button className="btn btn-sm" onClick={() => setConfirm({ pair: p, action: 'demote' })}>To shadow now</button> : <span className="muted small">the gate proposes it when the clock runs out</span>}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </Panel>

            <ConfirmDialog
              open={confirm !== null}
              title={confirm ? (confirm.action === 'demote' ? `Move ${confirm.pair.scannerName} on ${confirm.pair.symbol} to the shadow book?` : confirm.action === 'approve' ? (confirm.pair.stage === 'proposed' ? `Promote ${confirm.pair.scannerName} on ${confirm.pair.symbol}?` : `Demote ${confirm.pair.scannerName} on ${confirm.pair.symbol}?`) : confirm.pair.stage === 'proposed' ? `Reject ${confirm.pair.scannerName} on ${confirm.pair.symbol}?` : `Keep ${confirm.pair.scannerName} on ${confirm.pair.symbol} live?`) : ''}
              body={confirm && (confirm.action === 'demote' ? <p>The market leaves this scanner's live list now. Open positions keep running their exits. The pair keeps trading in the shadow book.</p> : <p>{confirm.action === 'approve' ? (confirm.pair.stage === 'proposed' ? 'It starts trading in the account from the next signal.' : 'It stops taking new live trades and goes back to the shadow book to prove itself again.') : confirm.pair.stage === 'proposed' ? `It is retired and not screened again for ${v.config.cooldownDays} days.` : 'It stays live; the demotion check runs again tomorrow.'}</p>)}
              confirmLabel={confirm?.action === 'demote' ? 'Move to shadow' : confirm?.action === 'approve' ? (confirm.pair.stage === 'proposed' ? 'Promote' : 'Demote') : confirm?.pair.stage === 'proposed' ? 'Reject' : 'Keep live'}
              danger={confirm?.action === 'demote' || (confirm?.action === 'approve' && confirm.pair.stage === 'demote_proposed')}
              busy={decide.isPending}
              onConfirm={() => { if (confirm) decide.mutate({ id: confirm.pair.id, action: confirm.action }, { onSettled: () => setConfirm(null) }) }}
              onCancel={() => setConfirm(null)}
            />
            {decide.isError && <div className="auth-error mt" role="alert">{(decide.error as Error).message}</div>}
          </>
        )}
      </QueryState>
    </div>
  )
}
