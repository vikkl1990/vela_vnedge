import { liveStatus } from '../lib/liveStatus'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useConfig, useExecution, useGates, useLearning, useMl, useRisk, useTapeAudit } from '../api/queries'
import type { GoLiveCheck, GoLiveVerdict, PaperConfig } from '../api/types'
import { Loading, PageTitle, Pill } from '../components/ui'
import { EmptyState, Section, Stat, StatGrid } from '../components/kit'
import { BookChip } from '../components/kit/books'
import { fmtPct } from '../lib/format'
import '../styles/pages/live.css'

/**
 * Live control. Read-only: it says whether real money is armed, which go-live checks stand in the way, what changes
 * when a trade leaves paper, and what the order engine does today. Nothing here can arm live, send an order or change
 * a risk limit; those stay in server configuration and in the top bar's Pause entries button.
 */

// The saved config carries more than the dashboard's narrow type names; these are the fields this page reads.
type PaperX = PaperConfig & {
  fillSource?: 'candles' | 'tape'
  skipScriptStops?: boolean
  marginPerTrade?: number
  maxStopLossPct?: number
  trailDistanceR?: number
}
type ExecX = { mode: string; allowProduction?: boolean }
type MlCfg = { minProb: number; useAsScore: boolean }

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const signed = (v: number, d = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`
const money = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
/** 10 -> "10", 0.5 -> "0.5": settings read back without trailing zeros. */
const plain = (v: number) => String(Number(v.toFixed(4)))

/** Where to go to fix a go-live check. Keys are the server's; anything unknown goes to the gates page. */
const FIX: Record<string, { to?: string; text: string }> = {
  trades: { to: '/learn', text: 'See the record on Learn' },
  risk: { to: '/settings', text: 'Review sizing in Settings' },
  expectancy: { to: '/learn', text: 'See the edge on Learn' },
  survival: { to: '/learn', text: 'See the simulation on Learn' },
  drawdown: { to: '/learn', text: 'See the simulation on Learn' },
  halts: { to: '/gates', text: 'See the gates' },
  alerts: { text: 'Set the alert target in server configuration' },
}
const fixFor = (key: string) => FIX[key] ?? { to: '/gates', text: 'See the gates' }

export function Live() {
  const learning = useLearning()
  const risk = useRisk()
  const gates = useGates()
  const config = useConfig()
  const execution = useExecution()
  const ml = useMl()
  const tape = useTapeAudit(30)

  const paper = config.data?.paper as PaperX | undefined
  const exec = config.data?.execution as ExecX | undefined
  const mlCfg: MlCfg | undefined = ml.data?.config ?? config.data?.ml

  return (
    <div className="page live-page">
      <PageTitle
        sub="Live is the only book with real money. Runtime connection status and readiness checks are shown separately. A passing checklist does not arm production."
        actions={<BookChip book="live" />}
      />
      <StatePanel status={execution.isError ? undefined : execution.data} golive={learning.data?.golive} goliveLoading={learning.isLoading} risk={risk.data} allowProduction={exec?.allowProduction} />
      <ChecksSection golive={learning.data?.golive} loading={learning.isLoading} failed={learning.isError} />
      <GatesSummary q={gates} />
      <ParitySection paper={paper} status={execution.data} mlCfg={mlCfg} tape={tape.data} configLoading={config.isLoading} />
      <EngineSection paper={paper} mlCfg={mlCfg} auc={ml.data?.global?.model?.auc} sizeScale={risk.data?.leverageMult} learning={learning.data} loading={config.isLoading} />
    </div>
  )
}

// ---------- 1. state ----------

function StatePanel({ status, golive, goliveLoading, risk, allowProduction }: {
  status: ReturnType<typeof useExecution>['data']
  golive: GoLiveVerdict | undefined
  goliveLoading: boolean
  risk: ReturnType<typeof useRisk>['data']
  allowProduction: boolean | undefined
}) {
  const live = liveStatus(status)
  const passes = golive?.checks.filter((c) => c.ok).length ?? 0
  const total = golive?.checks.length ?? 0
  const halted = risk?.halted === true
  return (
    <section className="live-state" aria-label="Live state">
      <div className="live-state-main">
        <span className="live-eyebrow">LIVE BOOK</span>
        <span className="live-state-word">{live.label}</span>
        <span className="live-state-line">
          {live.detail}
        </span>
      </div>

      <ol className="live-arm" aria-label="Arm path">
        <li className="live-arm-step">
          <span className="live-arm-head"><span className={`live-arm-n ${golive?.ok ? 'ok' : ''}`} aria-hidden>1</span><b>Go-live checks</b></span>
          <span className={`live-arm-val mono ${golive ? (golive.ok ? 'gain' : 'loss') : ''}`}>{golive ? `${passes} of ${total}` : goliveLoading ? 'loading' : 'not reported'}</span>
          <span className="live-arm-sub">{golive ? (golive.ok ? 'all checks pass' : 'all must pass') : 'sent with the learning view'}</span>
        </li>
        <li className="live-arm-step live-arm-locked">
          <span className="live-arm-head"><span className="live-arm-n" aria-hidden>2</span><b>Arm live</b></span>
          <span className="live-arm-val">Not in the dashboard</span>
          <span className="live-arm-sub">Arming is not available in the dashboard: production stays double-locked in server configuration.</span>
        </li>
      </ol>

      <div className="live-state-side">
        <div className="live-note">
          <b>The double lock.</b> The production host is chosen only when <code>execution.allowProduction</code> is true <em>and</em> the service runs with <code>DELTA_LIVE=1</code>. The mode cannot change while the bot runs; a restart applies it.
          {allowProduction !== undefined && <> Saved flag: <span className="mono">allowProduction {String(allowProduction)}</span>. The environment variable is not visible from here.</>}
        </div>
        <div className={`live-entries ${halted ? 'halted' : ''}`} role="status">
          <span className="live-entries-label">Entries</span>
          {!risk ? <span className="muted">not reported</span> : halted
            ? <span><b>Paused.</b> {risk.manualHalt ? `By hand: ${risk.manualHalt.reason}.` : risk.haltReason ? `${risk.haltReason}.` : ''} Resume from the top bar.</span>
            : <span><b>Running.</b> The kill switch is the Pause entries button in the top bar.</span>}
        </div>
      </div>
    </section>
  )
}

// ---------- 2. checks ----------

function ChecksSection({ golive, loading, failed }: { golive: GoLiveVerdict | undefined; loading: boolean; failed: boolean }) {
  if (!golive) {
    return (
      <Section title="Go-live checks">
        {loading ? <Loading kind="table" rows={5} cols={4} /> : <EmptyState title={failed ? 'The server did not answer.' : 'No go-live checks reported.'} hint="They come with the learning view. Until they load, nothing here says live is ready." />}
      </Section>
    )
  }
  const passes = golive.checks.filter((c) => c.ok).length
  const sim = golive.sim
  const byKey = (k: string) => golive.checks.find((c) => c.key === k)
  const tone = (c: GoLiveCheck | undefined): 'gain' | 'loss' | undefined => (c ? (c.ok ? 'gain' : 'loss') : undefined)
  return (
    <Section
      title="Go-live checks"
      hint="Each check shows what it needs, where it stands, and where to go to move it."
      actions={<span className={`live-count mono ${golive.ok ? 'gain' : 'loss'}`}>{passes} of {golive.checks.length} pass</span>}
    >
      <div className="panel"><div className="table-wrap">
        <table className="table live-table live-checks">
          <thead><tr><th scope="col">Check</th><th scope="col">Needs</th><th scope="col">Now</th><th scope="col">To fix</th></tr></thead>
          <tbody>
            {golive.checks.map((c) => {
              const fix = fixFor(c.key)
              return (
                <tr key={c.key} className={c.ok ? '' : 'live-fail'}>
                  <th scope="row" data-label="Check">
                    <span className={`live-mark ${c.ok ? 'ok' : 'no'}`}><span aria-hidden>{c.ok ? '✓' : '✕'}</span> {c.ok ? 'Pass' : 'Fail'}</span>
                    <span className="live-check-label">{c.label}</span>
                  </th>
                  <td className="mono small" data-label="Needs">{c.need}</td>
                  <td className={`mono live-now ${c.ok ? 'gain' : 'loss'}`} data-label="Now">{c.value}</td>
                  <td className="small" data-label="To fix">{c.ok ? <span className="muted">Nothing to do</span> : fix.to ? <Link to={fix.to}>{fix.text}</Link> : <span>{fix.text}</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div></div>
      {sim && (
        <div className="live-sim">
          <h3 className="live-sub-title">Simulated through the fleet&rsquo;s halts</h3>
          <StatGrid min={150}>
            <Stat label="Paths" value={`${sim.paths.toLocaleString('en-US')} × ${sim.days}d`} sub="block bootstrap of the account's R series" />
            <Stat label="Halt in" value={fmtPct(sim.breachPct)} tone={tone(byKey('survival'))} sub={`daily ${sim.dailyBreachPct.toFixed(1)}% · max loss ${sim.maxLossBreachPct.toFixed(1)}%`} />
            <Stat label="Drawdown, median" value={fmtPct(sim.dd50Pct)} />
            <Stat label="Drawdown, 95th" value={fmtPct(sim.dd95Pct)} tone={tone(byKey('drawdown'))} />
            <Stat label="Median end" value={`${signed(sim.medianEndPct)}%`} sub="equity change over the window" />
          </StatGrid>
        </div>
      )}
    </Section>
  )
}

// ---------- 3. gates ----------

function GatesSummary({ q }: { q: ReturnType<typeof useGates> }) {
  const d = q.data
  const blocking = d?.gates.filter((g) => g.state === 'blocking') ?? []
  const attention = d?.gates.filter((g) => g.state === 'attention') ?? []
  return (
    <Section title="Gates" hint="What stands between a setup and real money right now." actions={<Link to="/gates">Open the gates</Link>}>
      {!d ? (
        q.isLoading ? <Loading kind="kpi" rows={2} /> : <EmptyState title="The gates did not load." hint="Open the Gates page to see them." />
      ) : (
        <>
          <StatGrid min={150}>
            <Stat label="Blocking" value={d.summary.blocking} tone={d.summary.blocking ? 'loss' : 'muted'} sub="stopping entries now" />
            <Stat label="Needs you" value={d.summary.attention} tone={d.summary.attention ? 'warn' : 'muted'} sub="waiting on an operator" />
            <Stat label="Gates" value={d.gates.length} sub="in all" />
          </StatGrid>
          {(blocking.length > 0 || attention.length > 0) && (
            <p className="live-gate-names small">
              {blocking.length > 0 && <><b>Blocking:</b> {blocking.map((g) => g.name).join(', ')}. </>}
              {attention.length > 0 && <><b>Needs you:</b> {attention.map((g) => g.name).join(', ')}.</>}
            </p>
          )}
        </>
      )}
    </Section>
  )
}

// ---------- 4. what changes from paper ----------

function mlWord(m: MlCfg): string {
  const filter = m.minProb > 0
  if (filter && m.useAsScore) return `Skips entries under P(win) ${plain(m.minProb)} and scores size`
  if (filter) return `Skips entries under P(win) ${plain(m.minProb)}`
  if (m.useAsScore) return 'Score only: P(win) scales size, nothing is skipped'
  return 'Off'
}

function ParitySection({ paper, status, mlCfg, tape, configLoading }: {
  paper: PaperX | undefined
  status: ReturnType<typeof useExecution>['data']
  mlCfg: MlCfg | undefined
  tape: ReturnType<typeof useTapeAudit>['data']
  configLoading: boolean
}) {
  if (!paper) {
    return (
      <Section title="What changes from paper">
        {configLoading ? <Loading kind="table" rows={5} cols={3} /> : <EmptyState title="The saved settings did not load." hint="Without them this page does not guess what paper does." />}
      </Section>
    )
  }
  const exchange = <Link to="/exchange">see Exchange</Link>
  // Paper's own fills audited against Delta's prints: the account's market entries are the cleanest like-for-like row.
  const entry = tape?.fills.find((f) => f.book === 'account' && f.kind === 'market entry' && f.medianBps != null)
  const execNow = status ? (status.mode === 'paper' ? 'Nothing is attached to an exchange today.' : `Today: mode ${status.mode}${status.host ? ` on ${status.host}` : ''}.`) : null
  const rows: Array<{ k: string; paper: ReactNode; live: ReactNode }> = [
    {
      k: 'Fills',
      paper: paper.fillSource === 'tape' ? "Simulated on Delta's trade stream" : paper.fillSource === 'candles' ? 'Simulated on 1-minute candles' : 'Simulated (fill source not reported)',
      live: <>Real market orders on Delta India; the production host sends plain market orders only. {execNow} <Link to="/exchange">Exchange</Link></>,
    },
    {
      k: 'Stops',
      paper: 'Checked by the bot against prices',
      live: <>Production refuses resting stop and limit orders, so the bot closes with reduce-only market orders and must stay up. {exchange}</>,
    },
    {
      k: 'Fees',
      paper: <>Modelled: taker {plain(paper.feeRatePct)}%{paper.makerFeeRatePct !== undefined ? `, maker ${plain(paper.makerFeeRatePct)}%` : ''}{paper.feeTaxPct !== undefined ? `, tax ${plain(paper.feeTaxPct)}% on fees` : ''}. Delta&rsquo;s product rates win when known.</>,
      live: <>Charged by the exchange; {exchange}</>,
    },
    {
      k: 'Slippage',
      paper: (
        <>
          Fallback model {plain(paper.slippageBps)} bps.{' '}
          {entry ? <>Audited against the tape (30 days): market entries sit a median {entry.medianBps!.toFixed(1)} bps off the prints, {entry.n} fills.</> : <span className="muted">No audited market entries in the last 30 days.</span>}
        </>
      ),
      live: <>Whatever the real fill is; {exchange}</>,
    },
    {
      k: 'ML advice',
      paper: mlCfg ? mlWord(mlCfg) : <span className="muted">not reported</span>,
      live: <>The same global setting; there is no separate live switch. <Link to="/learn">Learn</Link></>,
    },
  ]
  return (
    <Section title="What changes from paper" hint="Paper is read from the saved settings. Where a live value cannot be verified from here, it points to Exchange.">
      <div className="panel"><div className="table-wrap">
        <table className="table live-table live-parity">
          <thead><tr><th scope="col"><span className="sr-only">Aspect</span></th><th scope="col"><span className="live-col paper">PAPER</span></th><th scope="col"><span className="live-col live">LIVE</span></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.k}>
                <th scope="row">{r.k}</th>
                <td className="small" data-label="Paper">{r.paper}</td>
                <td className="small" data-label="Live">{r.live}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div></div>
    </Section>
  )
}

// ---------- 5. smart execution ----------

function EngineSection({ paper, mlCfg, auc, sizeScale, learning, loading }: {
  paper: PaperX | undefined
  mlCfg: MlCfg | undefined
  auc: number | undefined
  sizeScale: number | undefined
  learning: ReturnType<typeof useLearning>['data']
  loading: boolean
}) {
  if (!paper) {
    return (
      <Section title="Smart execution">
        {loading ? <Loading kind="kpi" rows={4} /> : <EmptyState title="The saved settings did not load." hint="This panel only reports what the settings say." />}
      </Section>
    )
  }
  const minProb = mlCfg?.minProb ?? 0
  const filterOn = minProb > 0
  const scoreOn = mlCfg?.useAsScore === true
  const cur = learning?.current
  const exitEvidence = cur
    ? cur.trades > 0
      ? `${cur.trades} closed account trades under these settings, average ${signed(cur.avgR, 2)}R after costs.`
      : 'No closed account trades under these settings yet.'
    : 'Closed-trade evidence has not loaded.'

  let sizeRule: string
  if (paper.sizingMode === 'margin') sizeRule = `A fixed ${num(paper.marginPerTrade) ? money(paper.marginPerTrade) : 'margin'} per trade, at a leverage chosen from the scanner's own shadow record.`
  else if (paper.sizingMode === 'quality') sizeRule = `Notional is equity × leverage, scaled from ${plain(paper.minLeverage)}× to ${plain(paper.maxLeverage)}× by the signal's score.`
  else sizeRule = `Sized so the stop loses ${plain(paper.riskPerTradePct)}% of equity, up to ${plain(paper.maxLeverage)}× leverage.`
  const cap = num(paper.maxStopLossPct) && paper.maxStopLossPct > 0 ? `Modelled loss at the stop is capped at ${plain(paper.maxStopLossPct)}% of equity.` : 'No cap on modelled loss at the stop is set.'

  const trailAfter = paper.trailAfterR ?? 0
  const trail = trailAfter > 0
  let exitRule: string
  if (trail) {
    const gb = paper.trailGiveBackPct ?? 0
    exitRule = gb > 0
      ? `The trail arms at +${plain(trailAfter)}R and gives back ${plain(gb)}% of the peak.`
      : paper.trailDistanceR ? `The trail arms at +${plain(trailAfter)}R and follows ${plain(paper.trailDistanceR)}R behind the best price.` : `The trail arms at +${plain(trailAfter)}R.`
  } else {
    exitRule = `No trail is armed. Fallback targets sit at ${paper.fallbackRR.map((x) => `${plain(x)}R`).join(', ')}${paper.breakEvenAfterTp1 ? ', and the stop moves to break-even after the first' : ''}.`
  }

  const cards: Array<{ name: string; state: string; rule: ReactNode; evidence: ReactNode }> = [
    {
      name: 'Entry',
      state: filterOn ? 'Script signal, model skip filter on' : 'Script signal, no model filter',
      rule: `The script's confirmed signal opens the trade.${paper.skipScriptStops ? ' Entries whose stop the script placed itself are refused.' : ''}${filterOn ? ` A model skips signals under P(win) ${plain(minProb)}.` : ''}`,
      evidence: <>ML skip filter: {filterOn ? `on at ${plain(minProb)}` : 'off'}. {num(auc) ? <>Model held-out AUC {auc.toFixed(2)} (0.50 is no skill). <Link to="/learn">Learn</Link></> : 'No model score reported.'}</>,
    },
    {
      name: 'Size',
      state: `${paper.sizingMode === 'margin' ? 'Margin' : paper.sizingMode === 'quality' ? 'Quality' : 'Risk'} sizing`,
      rule: `${sizeRule} ${cap}`,
      evidence: `${num(sizeScale) ? `New positions are sized at ${Math.round(sizeScale * 100)}% of the rule right now.` : 'Current size scale not reported.'} P(win) as the sizing score: ${scoreOn ? 'on' : 'off'}.`,
    },
    {
      name: 'Exit',
      state: trail ? 'Trailing exit' : 'Fixed targets',
      rule: <>{exitRule}<span className="live-planned"> A replacement that runs each strategy&rsquo;s own exits is planned, not active.</span></>,
      evidence: <>{exitEvidence} <Link to="/learn">Where the R goes</Link></>,
    },
    {
      name: 'ML',
      state: filterOn ? (scoreOn ? 'Skip filter and score' : 'Skip filter') : scoreOn ? 'Score only' : 'Off',
      rule: !mlCfg ? 'The model settings are not reported.' : filterOn ? `Signals the model rates under ${plain(minProb)} P(win) are skipped${scoreOn ? ', and P(win) also scales size' : ''}.` : scoreOn ? 'P(win) scales size; no signal is skipped.' : 'The model advises nothing: no signal is skipped and size ignores it.',
      evidence: num(auc) ? `Held-out AUC ${auc.toFixed(2)}; 0.50 is no better than a coin.` : 'No model score reported.',
    },
  ]
  return (
    <Section title="Smart execution" hint="What the order engine does today, read from the saved settings. Planned work is labelled planned.">
      <div className="live-engine">
        {cards.map((c) => (
          <article key={c.name} className="live-card" aria-label={c.name}>
            <div className="live-card-head"><b>{c.name}</b><Pill tone="accent" title="This is how the engine runs now">CURRENT</Pill></div>
            <span className="live-card-state">{c.state}</span>
            <span className="live-card-rule">{c.rule}</span>
            <span className="live-card-evidence">{c.evidence}</span>
          </article>
        ))}
      </div>
    </Section>
  )
}
