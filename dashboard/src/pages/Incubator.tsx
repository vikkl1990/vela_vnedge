import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthGate'
import type { IncubatorPair, IncubatorView } from '../api/types'
import { BookBadge, ConfirmDialog, Empty, KpiTile, PageTitle, Panel, Pill, QueryState } from '../components/ui'
import { Clocks, Evidence, Funnel, Need } from '../components/incubatorBits'
import { ScreenQueuePanel } from '../components/ScreenQueuePanel'
import { OverlapPanel } from '../components/OverlapPanel'
import { clockRank, gateFor, gateMinimums, pf, r } from '../lib/incubatorLogic'
import { fmtNum, timeAgo, fmtR } from '../lib/format'

/**
 * The incubator: disabled scanner/market pairs are screened daily, the promising ones trade in a
 * shadow book on live data, and the ones that prove themselves there wait here for approval.
 */
export default function Incubator() {
  const qc = useQueryClient()
  const auth = useAuth()
  const q = useQuery({ queryKey: ['incubator'], queryFn: api.incubator, refetchInterval: 60_000, staleTime: 20_000 })
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['incubator'] }); void qc.invalidateQueries({ queryKey: ['scanners'] }) }
  const decide = useMutation({ mutationFn: api.incubatorDecide, onSuccess: invalidate })
  const evaluate = useMutation({ mutationFn: api.incubatorEvaluate, onSuccess: invalidate })
  const [confirm, setConfirm] = useState<{ pair: IncubatorPair; action: 'approve' | 'reject' | 'demote' } | null>(null)
  const [renderedAt] = useState(() => Date.now())

  return (
    <>
      <PageTitle pre="New edges," accent="proven" post="before they trade." sub="Disabled scanners are screened every day on every liquid market. The promising ones trade in a shadow book on live data; only what proves itself there is proposed to you." />
      <QueryState {...q} data={q.data} empty="Incubator unavailable." onRetry={() => q.refetch()}>
        {(d) => {
          const by = (st: IncubatorPair['stage']) => d.pairs.filter((p) => p.stage === st)
          const decisions = [...by('proposed'), ...by('demote_proposed')]
          const shadow = by('shadow').sort((a, b) => (b.stats?.trades ?? 0) - (a.stats?.trades ?? 0))
          const candidates = by('candidate').filter((p) => p.screen?.pass).sort((a, b) => (b.screen!.profitFactor - 1) * Math.sqrt(b.screen!.trades) - (a.screen!.profitFactor - 1) * Math.sqrt(a.screen!.trades))
          const now = d.lastRun?.at ?? renderedAt
          const live = by('live').sort((a, b) => clockRank(b, d.config.demote, now) - clockRank(a, d.config.demote, now) || (b.stats?.trades ?? 0) - (a.stats?.trades ?? 0))
          const g = d.config.gate
          // grouped the way the gate judges: by cohort (scanner × timeframe) in cohort mode, one pair at a time in pair mode
          const byCohort = g.pool === 'cohort'
          const cohorts = (() => {
            const groups = new Map<string, IncubatorPair[]>()
            for (const p of [...shadow, ...by('proposed')]) { const k = byCohort ? `${p.scannerId}|${p.tf}` : `pair:${p.id}`; groups.set(k, [...(groups.get(k) ?? []), p]) }
            return [...groups.entries()].map(([k, ps]) => {
              const trades = ps.reduce((a, p) => a + (p.stats?.trades ?? 0), 0)
              const netR = ps.reduce((a, p) => a + (p.stats?.netR ?? 0), 0)
              const days = Math.max(0, ...ps.map((p) => p.stats?.days ?? 0))
              const pos = ps.filter((p) => (p.stats?.trades ?? 0) >= 3 && (p.stats?.avgR ?? 0) > 0).length
              const judged = ps.filter((p) => (p.stats?.trades ?? 0) >= 3).length
              const gate = ps.find((p) => p.gate)?.gate ?? null
              const rate = days > 0 ? trades / days : 0
              // decision 196: the minimums of this timeframe, as the judge applies them (4h needs 45 days, not 14)
              const gg = gateFor(g, ps[0].tf)
              const need = Math.max(0, gg.minTrades - trades)
              const eta = need === 0 ? Math.max(0, gg.minDays - days) : rate > 0 ? Math.max(need / rate, gg.minDays - days) : Infinity
              return { k, gg, symbol: ps[0].symbol, scanner: ps[0].scannerName, scannerId: ps[0].scannerId, tf: ps[0].tf, members: ps.sort((a, b) => (b.stats?.trades ?? 0) - (a.stats?.trades ?? 0)), trades, avgR: trades ? netR / trades : 0, days, pos, judged, gate, eta }
            }).sort((a, b) => Number(b.gate?.decision === 'propose') - Number(a.gate?.decision === 'propose') || a.eta - b.eta || b.trades - a.trades)
          })()
          return (
            <>
              <div className="kpi-grid">
                <KpiTile label="Waiting for you" value={decisions.length} tone={decisions.length ? 'accent' : 'neutral'} sub="proposals to approve or reject" />
                <KpiTile label="Shadow book" value={`${shadow.length + by('proposed').length}`} sub={`cap ${d.config.maxShadow} · ${d.runner.entries} shadow entries since restart`} hint={shadow.length + by('proposed').length > d.config.maxShadow ? 'Over the cap: pairs admitted by hand or carried over from the live fleet stay until they are judged' : undefined} />
                <KpiTile label="Candidates" value={candidates.length} sub={candidateLine(d.candidates, d.lastAdmit)} hint={candidateHint(d.candidates)} />
                <KpiTile label="In the account" value={`${d.fleet}/${d.config.promote.maxFleet}`} sub={`${d.promotionsThisWeek}/${d.config.promote.maxPerWeek} promotions this week`} />
                {(() => {
                  const died = d.lastStart && (!d.lastRun || d.lastRun.at < d.lastStart.at) && Date.now() - d.lastStart.at > 7 * 3600_000
                  const stale = d.lastRun && Date.now() - d.lastRun.at > 2 * 86400_000
                  return (
                    <KpiTile
                      label="Last screen"
                      value={d.lastRun ? timeAgo(d.lastRun.at) : 'never'}
                      tone={died || stale ? 'loss' : 'neutral'}
                      sub={died ? `a run started ${timeAgo(d.lastStart!.at)} and never finished — see the service log` : d.lastRun ? `slice ${d.lastRun.slice} · ${d.lastRun.runs} runs · ${d.lastRun.passed} passed${d.lastRun.truncated ? ` · ${d.lastRun.truncated} scripts not reached` : ''}` : 'the daily job has not run yet'}
                    />
                  )
                })()}
              </div>

              <Panel
                title="Waiting for your decision"
                right={auth.canTrade ? <button className="btn btn-sm" onClick={() => evaluate.mutate()} disabled={evaluate.isPending}>{evaluate.isPending ? 'Judging…' : 'Re-judge now'}</button> : null}
              >
                {decisions.length === 0 ? (
                  <Empty label="Nothing to decide." hint={`A shadow pair is proposed after ${gateMinimums(g)} with PF ≥ ${g.minPfR}, ≥${g.minPositiveWeeksPct}% of weeks positive and ≥${g.minAvgR}R per trade. A live pair is proposed for demotion when its last ${d.config.demote.window} trades fall below PF ${d.config.demote.maxPfR}.`} />
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <caption className="sr-only">Pairs waiting for approval</caption>
                      <thead><tr><th scope="col">Proposal</th><th scope="col">Scanner</th><th scope="col">Market</th><th scope="col">Evidence</th><th scope="col">Signals 14d</th><th scope="col">Since</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                      <tbody>
                        {decisions.map((p) => (
                          <tr key={p.id}>
                            <td>{p.stage === 'proposed' ? <Pill tone="ok">Promote</Pill> : <Pill tone="danger">Demote</Pill>}</td>
                            <td><Link to={`/scanners/${p.scannerId}`}>{p.scannerName}</Link></td>
                            <td className="mono">{p.symbol} · {p.tf}</td>
                            <td>{p.stage === 'proposed' ? <div className="small"><Evidence s={p.gate?.stats ?? p.stats} g={gateFor(g, p.tf)} />{p.gate?.cohort && <div className="muted">{p.gate.cohort}{p.gate.stats?.positiveMarkets !== undefined ? ` · ${p.gate.stats.positiveMarkets}/${p.gate.stats.marketsJudged} markets positive` : ''}</div>}</div> : <div className="small">{p.gate?.reasons?.[0] ?? 'the gate proposes demotion'}</div>}{p.gate?.strategyComparison && <div className="small"><Pill tone={p.gate.strategyComparison.preferred === 'script' ? 'ok' : 'muted'}>{p.gate.strategyComparison.preferred === 'script' ? 'own exits' : 'fleet exits'}</Pill> <span className="muted">{p.gate.strategyComparison.reason}</span></div>}{p.market && !p.market.allowed && <div className="small"><Pill tone="danger" title={p.market.reasons.join(' · ')}>market out today</Pill> <span className="muted">{p.market.reasons.join(' · ').slice(0, 90)}</span></div>}<Evidence s={p.stats} g={g} />{p.gate?.overlapPct !== undefined && <div className="muted small">{p.gate.overlapPct.toFixed(0)}% of entries overlap a live pair</div>}</td>
                            <td className="small"><Funnel f={p.funnel} /></td>
                            <td className="muted small">{timeAgo(p.since)}</td>
                            <td className="nowrap">
                              {auth.canTrade ? (
                                <>
                                  <button className="btn btn-sm btn-primary" onClick={() => setConfirm({ pair: p, action: 'approve' })}>{p.stage === 'proposed' ? 'Promote' : 'Demote'}</button>{' '}
                                  <button className="btn btn-sm" onClick={() => setConfirm({ pair: p, action: 'reject' })}>{p.stage === 'proposed' ? 'Reject' : 'Keep live'}</button>
                                </>
                              ) : <span className="muted small">needs trade access</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {decide.isError && <div className="auth-error mt" role="alert">{(decide.error as Error).message}</div>}
              </Panel>

              <Panel title={<span>In the account ({live.length}) <BookBadge book="account" generic /></span>}>
                {live.length === 0 ? <Empty label="The incubator has not synced the fleet yet." /> : (
                  <div className="table-wrap">
                    <table className="table">
                      <caption className="sr-only">Live pairs and their recent record</caption>
                      <thead><tr><th scope="col">Scanner</th><th scope="col">Market</th><th scope="col">Live record</th><th scope="col" title="Entry signals in the last 14 days: opened, or the gate that refused them (decision 112)">Signals 14d</th><th scope="col" title="The demotion clocks: days the market has been out, days since the last account trade, cost-rule starvation">Clock</th><th scope="col">Health</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                      <tbody>
                        {live.map((p) => (
                          <tr key={p.id}>
                            <td><Link to={`/scanners/${p.scannerId}`}>{p.scannerName}</Link></td>
                            <td className="mono">{p.symbol} · {p.tf}{p.market && !p.market.allowed && <> <Pill tone="warn">market out</Pill></>}</td>
                            <td className="small">{p.stats ? `${p.stats.trades} trades · PF ${pf(p.stats.pfR)} · ${r(p.stats.netR)} · win ${p.stats.winRatePct.toFixed(0)}%` : '—'}
                              {p.stats && p.stats.trades > 0 && p.stats.avgLossR ? <span className="muted" title="Decision 186: the payoff shape — average winner over average loser, and the share of trades that ever reached +1R"> · W/L {(p.stats.avgWinR! / p.stats.avgLossR).toFixed(2)}{p.stats.reached1RPct !== undefined ? ` · +1R ${p.stats.reached1RPct.toFixed(0)}%` : ''}</span> : null}</td>
                            <td className="small"><Funnel f={p.funnel} /></td>
                            <td className="small"><Clocks p={p} cfg={d.config.demote} now={now} /></td>
                            <td className="small">{(p.stats?.trades ?? 0) < d.config.demote.minTrades ? <span className="muted">collecting ({p.stats?.trades ?? 0}/{d.config.demote.minTrades})</span> : <Pill tone="ok">healthy</Pill>}</td>
                            <td className="num">{auth.isAdmin && <button className="btn btn-xs" onClick={() => setConfirm({ pair: p, action: 'demote' })}>To shadow</button>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>

              <Panel title={<span>Brewing in the shadow book ({shadow.length}) <BookBadge book="shadow" short /></span>} right={<span className="muted small">{byCohort ? `grouped by cohort, the unit the gate judges · a verdict needs ${gateMinimums(g)} and half the markets positive` : `one row per pair, the unit the gate judges · a verdict needs ${gateMinimums(g)}`}</span>}>
                {shadow.length === 0 ? <Empty label="No shadow pairs yet." hint="The daily screen admits its best candidates here." /> : (
                  <div className="table-wrap">
                    <table className="table">
                      <caption className="sr-only">Shadow pairs and their progress toward the promotion gate</caption>
                      <thead><tr><th scope="col">{byCohort ? 'Cohort · market' : 'Pair'}</th><th scope="col">Progress</th><th scope="col" title="Entry signals in the last 14 days: opened, or the gate that refused them (decision 112)">Signals 14d</th><th scope="col">Gate</th><th scope="col">Open</th></tr></thead>
                      <tbody>
                        {cohorts.map((c) => (
                          <Fragment key={c.k}>
                            <tr className="cohort-row">
                              <th scope="rowgroup" colSpan={1}><Link to={`/scanners/${c.scannerId}`} className="strong">{c.scanner}</Link> <span className="mono muted">{c.tf}</span> <span className="muted small">· {byCohort ? `${c.members.length} markets` : <span className="mono">{c.symbol}</span>}</span>{!byCohort && c.members[0].stage === 'proposed' && <> <Pill tone="ok">proposed</Pill></>}{!byCohort && c.members[0].market && !c.members[0].market.allowed && <> <Pill tone="warn" title={c.members[0].market.reasons.join(' · ')}>market out</Pill></>}{c.gate?.strategyComparison && <> <Pill tone={c.gate.strategyComparison.preferred === 'script' ? 'ok' : 'muted'} title={c.gate.strategyComparison.reason}>{c.gate.strategyComparison.preferred === 'script' ? 'own exits' : 'fleet exits'}</Pill></>}</th>
                              <td className="small"><Need have={c.trades} need={c.gg.minTrades} /> trades · <Need have={c.days} need={c.gg.minDays} /> days · <span className={`mono ${c.trades ? (c.avgR >= 0 ? 'gain' : 'loss') : 'muted'}`}>{c.trades ? fmtR(c.avgR) : '–'}</span>/trade · {byCohort ? (c.judged ? `${c.pos}/${c.judged} markets +` : 'no market judged') : `PF ${pf(c.members[0].stats?.pfR)}`}</td>
                              <td className="small muted">{c.members.reduce((a, p) => a + (p.funnel?.entries ?? 0), 0)} signals · {c.members.reduce((a, p) => a + (p.funnel?.opened ?? 0), 0)} opened</td>
                              <td className="small"><Pill tone={c.gate?.decision === 'propose' ? 'ok' : c.gate?.decision === 'retire' ? 'danger' : 'muted'}>{c.gate?.decision ?? 'brewing'}</Pill> <span className="muted mono">{c.eta === Infinity ? 'no trades yet' : c.eta <= 0 ? 'now' : `~${Math.ceil(c.eta)}d`}</span>{c.gate?.decision === 'brewing' && c.gate.reasons.length > 0 && <div className="muted">{c.gate.reasons.join('; ')}</div>}</td>
                              <td className="mono">{c.members.reduce((a, p) => a + (p.openShadow ?? 0), 0) || ''}</td>
                            </tr>
                            {byCohort && c.members.map((p) => (
                              <tr key={p.id} className="cohort-member">
                                <td className="mono">{p.symbol}{p.stage === 'proposed' && <> <Pill tone="ok">proposed</Pill></>}{p.market && !p.market.allowed && <> <Pill tone="warn" title={p.market.reasons.join(' · ')}>market out</Pill></>}</td>
                                <td><Evidence s={p.stats} g={c.gg} /></td>
                                <td className="small"><Funnel f={p.funnel} /></td>
                                <td className="muted small">{p.gate?.market ? `${p.gate.market.trades} trades · ${r(p.gate.market.avgR)}` : ''}</td>
                                <td className="mono">{p.openShadow || ''}</td>
                              </tr>
                            ))}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>

              <Panel title={`Candidates from the screen (${candidates.length})`}>
                {candidates.length === 0 ? <Empty label="No candidates waiting." hint={`The screen passes a pair with ≥${d.config.screen.minTrades} backtest trades, PF ≥ ${d.config.screen.minProfitFactor}, ≥${d.config.screen.minWindowsUp}/8 windows up and a profit at ${d.config.screen.stressBps} bps of cost. It is a filter only: luck passes it too, which is why candidates must still prove themselves in the shadow book.`} /> : (
                  <div className="table-wrap">
                    <table className="table">
                      <caption className="sr-only">Pairs that passed the backtest screen</caption>
                      <thead><tr><th scope="col">Scanner</th><th scope="col">Market</th><th scope="col">Trades</th><th scope="col">PF</th><th scope="col">Windows up</th><th scope="col">Avg R</th><th scope="col">Screened</th></tr></thead>
                      <tbody>
                        {candidates.slice(0, 50).map((p) => (
                          <tr key={p.id}>
                            <td><Link to={`/scanners/${p.scannerId}`}>{p.scannerName}</Link></td>
                            <td className="mono">{p.symbol}</td>
                            <td className="mono">{p.screen!.trades}</td>
                            <td className="mono">{fmtNum(p.screen!.profitFactor)}</td>
                            <td className="mono">{p.screen!.windowsUp}/8</td>
                            <td className="mono">{r(p.screen!.avgR)}</td>
                            <td className="muted small">{timeAgo(p.screen!.at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>

              <Panel title="Daily hunt" right={<span className="muted small">{d.lastHunt?.auto ? 'auto-promotion ON: gate proposals go live within the weekly and fleet limits' : 'auto-promotion off: proposals wait for your click'}</span>}>
                {!d.lastHunt ? (
                  <p className="muted small">No hunt yet. The screen runs daily; when it finishes the shadow book is judged here and, with auto-promotion on, gate proposals go live.</p>
                ) : (
                  <div className="small">
                    <p><b>{timeAgo(d.lastHunt.at)}</b> by {d.lastHunt.actor}{d.lastHunt.screen ? <> · screen slice {d.lastHunt.screen.slice}: {d.lastHunt.screen.runs} runs, {d.lastHunt.screen.passed} passed, {d.lastHunt.screen.newCandidates} new candidates, {d.lastHunt.screen.quarantined} quarantined, {d.lastHunt.screen.minutes} min</> : null}</p>
                    <p>admitted to shadow <b>{d.lastHunt.admitted.length}</b> · proposed <b>{d.lastHunt.proposed.length}</b> · promoted <b className={d.lastHunt.promoted.length ? 'gain' : ''}>{d.lastHunt.promoted.length}</b> · retired {d.lastHunt.retired.length} · brewing {d.lastHunt.brewing} · free slots {d.lastHunt.free}</p>
                    {d.lastHunt.promoted.map((p) => <p key={p} className="mono gain">+ LIVE {p}</p>)}
                    {d.lastHunt.blocked.map((b) => <p key={b} className="mono muted">! {b}</p>)}
                    {d.lastHunt.admitted.slice(0, 8).map((p) => <p key={p} className="mono muted">→ shadow {p}</p>)}
                  </div>
                )}
              </Panel>

              <ScreenQueuePanel />

              <OverlapPanel />

              <Panel title="History">
                {d.events.length === 0 ? <Empty label="No moves yet." /> : (
                  <ul className="plain-list small">
                    {d.events.slice(0, 60).map((e) => (
                      <li key={e.id}>
                        <span className="muted mono">{new Date(e.at).toLocaleString()}</span> · <span className="mono">{e.scannerId} {e.symbol}</span> · {e.from ?? 'new'} → <strong>{e.to}</strong> <span className="muted">by {e.actor}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              <ConfirmDialog
                open={confirm !== null}
                title={confirm ? (confirm.action === 'demote' ? `Move ${confirm.pair.scannerName} on ${confirm.pair.symbol} ${confirm.pair.tf} to the shadow book?` : confirm.action === 'approve' ? (confirm.pair.stage === 'proposed' ? `Promote ${confirm.pair.scannerName} on ${confirm.pair.symbol} ${confirm.pair.tf}?` : `Demote ${confirm.pair.scannerName} on ${confirm.pair.symbol} ${confirm.pair.tf}?`) : confirm.pair.stage === 'proposed' ? `Reject ${confirm.pair.scannerName} on ${confirm.pair.symbol} ${confirm.pair.tf}?` : `Keep ${confirm.pair.scannerName} on ${confirm.pair.symbol} ${confirm.pair.tf} live?`) : ''}
                body={confirm && (confirm.action === 'demote' ? <p>The market leaves this scanner's live list now (the scanner is switched off when it was its last market). Open positions keep running their exits. The pair keeps trading in the shadow book and must pass the gate again to come back.</p> : confirm.action === 'approve'
                  ? confirm.pair.stage === 'proposed'
                    ? 'It starts trading in the account from the next signal. Open shadow positions finish in the shadow book.'
                    : 'It stops taking new live trades and goes back to the shadow book to prove itself again. Open live positions run to their exits.'
                  : confirm.pair.stage === 'proposed'
                    ? `It is retired and not screened again for ${d.config.cooldownDays} days.`
                    : 'It stays live; the demotion check runs again tomorrow.')}
                confirmLabel={confirm?.action === 'demote' ? 'Move to shadow' : confirm?.action === 'approve' ? (confirm.pair.stage === 'proposed' ? 'Promote' : 'Demote') : confirm?.pair.stage === 'proposed' ? 'Reject' : 'Keep live'}
                danger={confirm?.action === 'demote' || (confirm?.action === 'approve' && confirm.pair.stage === 'demote_proposed')}
                busy={decide.isPending}
                onConfirm={() => { if (confirm) decide.mutate({ id: confirm.pair.id, action: confirm.action }, { onSettled: () => setConfirm(null) }) }}
                onCancel={() => setConfirm(null)}
              />
            </>
          )
        }}
      </QueryState>
    </>
  )
}

/**
 * Decision 157: what the candidates that passed their screen wait for, right now — admission runs after every market-gate
 * refresh and every ten minutes, so "waiting" names the rule that holds each one, not a slot.
 */
function candidateLine(c: IncubatorView['candidates'], last: IncubatorView['lastAdmit']): string {
  if (!c) return 'passed the screen'
  const k = c.counts
  const parts = [
    k.admissible ? `${k.admissible} enter at the next admission` : null,
    k.outside + k.refused ? `${k.outside + k.refused} market out today` : null,
    k.expired + k.rescreen ? `${k.expired + k.rescreen} await a re-screen` : null,
    k.stale ? `${k.stale} screen too old` : null,
    k.capped ? `${k.capped} scanner at its cap` : null,
    k.noSlot ? `${k.noSlot} wait for a slot` : null,
    k.cohort ? `${k.cohort} wait for their cohort` : null,
  ].filter(Boolean)
  const tail = last ? ` · last admitted ${timeAgo(last.at)}` : ''
  return (parts.length ? parts.join(' · ') : 'none waiting') + tail
}
function candidateHint(c: IncubatorView['candidates']): string | undefined {
  if (!c) return undefined
  const k = c.counts
  return [
    `Admission runs after every market-gate refresh (hourly) and every 10 minutes; the nightly hunt judges and promotes.`,
    `Market out today: ${k.outside} outside the gate's universe, ${k.refused} refused by it.`,
    `Awaiting a re-screen: ${k.expired} screened on the previous engine, ${k.rescreen} strategies screened before the fill fix.`,
    `Screen older than the candidate window: ${k.stale}. Scanner at its per-timeframe cap: ${k.capped}. ${c.free} shadow slots free.`,
  ].join('\n')
}

