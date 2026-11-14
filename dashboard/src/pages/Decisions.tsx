import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { useHealth } from '../api/queries'
import { useAuth } from '../auth/AuthGate'
import type { IncubatorPair } from '../api/types'
import { Clocks, Evidence, Funnel } from '../components/incubatorBits'
import { clockRank } from '../lib/incubatorLogic'
import { ConfirmDialog, PageTitle, Pill, QueryState } from '../components/ui'
import { Callout, EmptyState, Section, Stat, StatGrid } from '../components/kit'
import '../styles/pages/decisions.css'
import { timeAgo } from '../lib/format'
import { gateFor, gateMinimums } from '../lib/incubatorLogic'

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
    const proposals = d.pairs.filter((p) => p.stage === 'proposed' || p.stage === 'demote_proposed').sort((a, b) => Number(b.stage === 'demote_proposed') - Number(a.stage === 'demote_proposed') || (a.proposedAt ?? Number.MAX_SAFE_INTEGER) - (b.proposedAt ?? Number.MAX_SAFE_INTEGER))
    const clocks = d.pairs.filter((p) => p.stage === 'live').map((p) => ({ p, rank: clockRank(p, d.config.demote, now) })).filter((x) => x.rank > 0).sort((a, b) => b.rank - a.rank || (b.p.funnel?.entries ?? 0) - (a.p.funnel?.entries ?? 0))
    return { proposals, clocks }
  }, [d, now])

  const due = cards.clocks.filter((c) => c.rank === 2).length
  const half = cards.clocks.filter((c) => c.rank === 1).length
  const total = cards.proposals.length + due + attention.length
  return (
    <div className="page decisions-page">
      <PageTitle
        sub="Everything that waits for a decision, with its evidence and controls on the same card. Proposals first, then live cells whose clock is running out, then faults."
        actions={<><Link to="/incubator" className="btn btn-sm">Incubator</Link><Link to="/gates" className="btn btn-sm">Gates</Link></>}
      />
      <QueryState {...q} data={d} empty="Incubator unavailable." onRetry={() => q.refetch()}>
        {(v) => (
          <>
            <StatGrid min={170}>
              <Stat label="To decide" value={total} tone={total ? 'warn' : 'muted'} sub={`last judged ${v.lastRun ? timeAgo(v.lastRun.at) : 'never'}`} />
              <Stat label="Proposals" value={cards.proposals.length} tone={cards.proposals.length ? 'accent' : 'muted'} sub="promote, reject or demote" />
              <Stat label="Clocks due" value={due} tone={due ? 'warn' : 'muted'} sub={`${half} more half way`} />
              <Stat label="Faults" value={attention.length} tone={attention.length ? 'loss' : 'muted'} sub="from the attention line" />
            </StatGrid>

            {total === 0 && (
              <Callout tone="ok" title="Nothing waits for you.">
                Proposals appear when a cohort clears the gate, a live cell shows up when its demotion clock passes half way, and faults come from the attention line.
              </Callout>
            )}

            {attention.length > 0 && (
              <Section title={`Faults (${attention.length})`} hint="Something is wrong and needs a person.">
                <div className="dq-list">
                  {attention.map((it) => (
                    <article key={it.key} className="dq-card dq-urgent">
                      <div className="dq-head">
                        <b className="dq-title">Fault</b>
                        <Pill tone="danger">needs attention</Pill>
                      </div>
                      <p className="dq-text">{it.text}</p>
                      <div className="dq-foot"><span /><div className="dq-actions"><Link to={it.href} className="btn btn-sm btn-primary">Open</Link></div></div>
                    </article>
                  ))}
                </div>
              </Section>
            )}

            <Section title={`Proposals (${cards.proposals.length})`} hint="Promote, reject, or confirm a demotion.">
              {cards.proposals.length === 0 ? (
                <EmptyState title="No proposal waits" hint={`The gate proposes ${v.config.gate.pool === 'cohort' ? 'a cohort' : 'a pair'} after ${gateMinimums(v.config.gate)} with PF ≥ ${v.config.gate.minPfR} and ≥ ${v.config.gate.minAvgR}R per trade.`} />
              ) : (
                <div className="dq-list">
                  {cards.proposals.map((p) => {
                    const promote = p.stage === 'proposed'
                    return (
                      <article key={p.id} className={`dq-card ${promote ? '' : 'dq-soon'}`}>
                        <div className="dq-head">
                          <span className="dq-title"><Link to={`/scanners/${p.scannerId}`} className="strong">{p.scannerName}</Link> <span className="mono dq-market">{p.symbol} {p.tf}</span></span>
                          <Pill tone={promote ? 'ok' : 'danger'}>{promote ? 'Promote?' : 'Demote?'}</Pill>
                        </div>
                        <div className="dq-evidence">
                          <div className="small">{promote ? <Evidence s={p.gate?.stats ?? p.stats} g={gateFor(v.config.gate, p.tf)} /> : <span>{p.gate?.reasons?.[0] ?? 'The gate proposes demotion.'}</span>}</div>
                          {p.gate?.cohort && <div className="muted small">{p.gate.cohort}{p.gate.stats?.positiveMarkets !== undefined ? ` · ${p.gate.stats.positiveMarkets}/${p.gate.stats.marketsJudged} markets positive` : ''}</div>}
                          <div className="small"><Funnel f={p.funnel} pair={p} /></div>
                          {p.gate?.strategyComparison && <div className="small"><Pill tone={p.gate.strategyComparison.preferred === 'script' ? 'ok' : 'muted'}>{p.gate.strategyComparison.preferred === 'script' ? 'own exits' : 'fleet exits'}</Pill> <span className="muted">{p.gate.strategyComparison.reason}</span></div>}
                          {p.market && !p.market.allowed && <div className="small"><Pill tone="danger">market out today</Pill> <span className="muted">{p.market.reasons.join(' · ').slice(0, 120)}</span></div>}
                        </div>
                        <div className="dq-foot">
                          <span className="muted small">{p.proposedAt ? `Proposed ${timeAgo(p.proposedAt)}` : 'Proposal time unavailable'} · evidence since {new Date(p.since).toISOString().slice(0, 10)}</span>
                          <div className="dq-actions">
                            {auth.canTrade ? (
                              <>
                                <button type="button" className={`btn btn-sm ${promote ? 'btn-primary' : 'btn-danger'}`} onClick={() => setConfirm({ pair: p, action: 'approve' })}>{promote ? 'Promote' : 'Demote'}</button>
                                <button type="button" className="btn btn-sm" onClick={() => setConfirm({ pair: p, action: 'reject' })}>{promote ? 'Reject' : 'Keep live'}</button>
                              </>
                            ) : <span className="muted small">Needs trade access</span>}
                          </div>
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </Section>

            <Section title={`Live cells on a clock (${cards.clocks.length})`} hint={`Clocks count time without an account trade, not time without signals. Market out ${v.config.demote.marketOutDays ?? '–'} d · no account trade ${v.config.demote.silentDays ?? '–'} d · cost-starved ${v.config.demote.costStarvedRefusals ?? '–'} refusals. Scanner faults need recovery before judging signal quality.`}>
              {cards.clocks.length === 0 ? (
                <EmptyState title="No live cell is near a demotion" hint="A cell appears here once a clock passes half way." />
              ) : (
                <div className="dq-list">
                  {cards.clocks.map(({ p, rank }) => (
                    <article key={p.id} className={`dq-card ${rank === 2 ? 'dq-urgent' : 'dq-soon'}`}>
                      <div className="dq-head">
                        <span className="dq-title"><Link to={`/scanners/${p.scannerId}`} className="strong">{p.scannerName}</Link> <span className="mono dq-market">{p.symbol} {p.tf}</span></span>
                        <Pill tone={rank === 2 ? 'danger' : 'warn'}>{rank === 2 ? 'Clock due' : 'Half way'}</Pill>
                      </div>
                      <div className="dq-evidence">
                        <div className="small"><Clocks p={p} cfg={v.config.demote} now={now} /></div>
                        <div className="small">{p.stats ? `${p.stats.trades} account trades · ${p.stats.netR >= 0 ? '+' : ''}${p.stats.netR.toFixed(1)}R` : 'No account trade yet'}{p.market && !p.market.allowed ? <span className="muted"> · {p.market.reasons.join(' · ').slice(0, 100)}</span> : null}</div>
                        <div className="small"><Funnel f={p.funnel} pair={p} /></div>
                      </div>
                      <div className="dq-foot">
                        <span />
                        <div className="dq-actions">
                          {auth.isAdmin ? <button type="button" className="btn btn-sm" onClick={() => setConfirm({ pair: p, action: 'demote' })}>To shadow now</button> : <span className="muted small">The gate proposes it when the clock runs out.</span>}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </Section>

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
            {decide.isError && <Callout tone="danger" title="The decision did not go through">{(decide.error as Error).message}</Callout>}
          </>
        )}
      </QueryState>
    </div>
  )
}
