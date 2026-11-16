import { useQuery } from '@tanstack/react-query'
import { useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../api/client'
import {
  useEquity,
  useExecution,
  useHealth,
  useLearning,
  useLibrary,
  useMl,
  useMlYardstick,
  usePositions,
  useRisk,
  useScreenQueue,
  useStats,
} from '../../api/queries'
import { REFRESH } from '../../api/refreshPolicy'
import { quietShadowCount, screenMeanR } from '../../lib/bookEvidence'
import type { Book } from '../../lib/books'
import { useBook } from '../../lib/bookScope'
import { fmtMoney, fmtPct, fmtPnl, fmtR, pnlClass } from '../../lib/format'
import { liveStatus } from '../../lib/liveStatus'
import { aucEvidence, mlState } from '../../lib/mlPresentation'
import { Callout, Sparkline } from '../kit'
import { BookCard, BookDot } from '../kit/books'

/** The incubator, shared with the shell by query key so it is fetched once. */
function useIncubatorView() {
  return useQuery({
    queryKey: ['incubator'],
    queryFn: api.incubator,
    refetchInterval: REFRESH.slow,
    staleTime: 20_000,
  })
}

// ---------- Live status ----------

/** One sentence on whether anything can reach the exchange, with the way to the go-live checklist. */
export function LiveStatusStrip() {
  const execution = useExecution()
  const learning = useLearning()
  const live = liveStatus(execution.isError ? undefined : execution.data)
  const checks = learning.data?.golive?.checks ?? []
  const ok = checks.filter((c) => c.ok).length
  const armed = live.armed
  const link = (
    <Link to="/live" className="btn btn-sm">
      {checks.length ? `Go-live checklist, ${ok} of ${checks.length}` : 'Go-live checklist'}
    </Link>
  )
  return (
    <section aria-label="Live status">
      <Callout tone={armed ? 'info' : 'warn'} title={`Live: ${live.label.toLowerCase()}.`} actions={link}>
        {live.detail}
      </Callout>
    </section>
  )
}

// ---------- The four books ----------

export function BookCards() {
  const { scope } = useBook()
  const health = useHealth()
  const stats = useStats()
  const equity = useEquity()
  const risk = useRisk()
  const positions = usePositions()
  const learning = useLearning()
  const inc = useIncubatorView()
  const lib = useLibrary()
  const queue = useScreenQueue()

  const mode = health.data?.mode
  const execution = useExecution()
  const live = liveStatus(execution.isError ? undefined : execution.data)
  const l = learning.data
  const checks = l?.golive?.checks ?? []
  const s = stats.data
  const day = risk.data?.day
  const openRisk = (positions.data ?? []).reduce((a, p) => a + (p.riskAmount ?? 0), 0)
  const openRiskPct = s && s.equity > 0 ? (openRisk / s.equity) * 100 : null
  const eqSpark = useMemo(() => (equity.data ?? []).slice(-120).map((p) => p.equity), [equity.data])
  const shadowCurve = useMemo(() => (l?.shadow.curve ?? []).slice(-120).map((p) => p.cumR), [l?.shadow.curve])

  const pairs = inc.data?.pairs
  const openShadow = pairs ? pairs.reduce((a, p) => a + (p.openShadow ?? 0), 0) : null
  const shadowCells = l?.funnel.stages.shadow ?? inc.data?.counts.shadow ?? null

  const scripts = lib.data?.scripts
  const onLadder = scripts
    ? scripts.filter((x) =>
        ['candidate', 'shadow', 'proposed', 'live', 'demote_proposed'].some(
          (k) => (x.stages[k as keyof typeof x.stages] ?? 0) > 0,
        ),
      ).length
    : null
  const lastScreen = inc.data?.lastRun?.at

  const dim = (b: Book) => (scope !== 'all' && scope !== b ? 'home-card home-dim' : 'home-card')

  return (
    <section className="home-books" aria-label="The four books">
      <div className={dim('live')}>
        <BookCard
          book="live"
          state={live.label}
          headline={live.label}
          sub={live.detail}
          footer={<Link to="/live">Open the go-live checklist</Link>}
        >
          {checks.length > 0 && (
            <div
              className="home-segs"
              role="img"
              aria-label={`${checks.filter((c) => c.ok).length} of ${checks.length} go-live checks pass`}
              style={{ ['--segs' as string]: checks.length }}
            >
              {checks.map((c) => (
                <span
                  key={c.key}
                  className={c.ok ? 'on' : ''}
                  title={`${c.label}: ${c.ok ? 'passes' : 'does not pass'}`}
                />
              ))}
            </div>
          )}
        </BookCard>
      </div>

      <div className={dim('paper')}>
        <BookCard
          book="paper"
          state={!mode ? 'Unknown' : risk.data?.halted ? 'Halted' : mode === 'paper' ? 'Running' : 'Mirrored'}
          headline={s ? fmtMoney(s.equity, 2) : '–'}
          sub={
            s ? (
              <span>
                {day ? <span className={pnlClass(day.pnl)}>{fmtPnl(day.pnl)}</span> : '–'} today ·{' '}
                {s.openPositions} open · {openRiskPct == null ? '–' : fmtPct(openRiskPct)} of equity at the
                stops · edge{' '}
                <span className={l ? pnlClass(l.live.avgR) : ''}>{l ? fmtR(l.live.avgR) : '–'}</span> a trade
              </span>
            ) : (
              'Loading the account'
            )
          }
          footer={<Link to="/trades?book=paper">Paper trades and positions</Link>}
        >
          {eqSpark.length > 1 && (
            <div className="home-spark paper">
              <Sparkline values={eqSpark} tone="accent" />
            </div>
          )}
        </BookCard>
      </div>

      <div className={dim('shadow')}>
        <BookCard
          book="shadow"
          state={inc.data ? (inc.data.enabled ? 'Collecting' : 'Off') : '–'}
          headline={
            openShadow != null ? `${openShadow} open` : shadowCells != null ? `${shadowCells} cells` : '–'
          }
          sub={
            l
              ? `${l.shadow.trades} trades in ${l.shadow.windowDays ?? 30} days · ${fmtR(l.shadow.avgR)} a trade${shadowCells != null ? ` · ${shadowCells} cells watched` : ''} · never real money`
              : 'Research trades on live prices, never real money'
          }
          footer={<Link to="/strategies?book=shadow">Shadow evidence by strategy</Link>}
        >
          {shadowCurve.length > 1 && (
            <div className="home-spark shadow">
              <Sparkline values={shadowCurve} tone="muted" />
            </div>
          )}
        </BookCard>
      </div>

      <div className={dim('backtest')}>
        <BookCard
          book="backtest"
          state={queue.data ? (queue.data.running ? 'Running' : 'Idle') : '–'}
          headline={scripts ? `${scripts.length} catalogued` : '–'}
          sub={
            scripts
              ? `scripts in the library · ${onLadder} have a pair on the ladder (candidate, shadow or account)${lastScreen ? ` · last screen ${new Date(lastScreen).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}`
              : 'Replay on history'
          }
          footer={<Link to="/lab">Open the Lab</Link>}
        />
      </div>
    </section>
  )
}

// ---------- Promotion ladder ----------

function Stage({
  book,
  name,
  count,
  what,
  gate,
}: {
  book: Book
  name: string
  count: ReactNode
  what: ReactNode
  gate?: ReactNode
}) {
  return (
    <div className={`home-stage home-stage-${book}`}>
      <span className="home-stage-name">
        <BookDot book={book} />
        {name}
      </span>
      <span className="home-stage-count mono">{count}</span>
      <span className="home-stage-what">{what}</span>
      {gate && <span className="home-stage-gate">To climb: {gate}</span>}
    </div>
  )
}

export function PromotionLadder() {
  const learning = useLearning()
  const inc = useIncubatorView()
  const stages = learning.data?.funnel.stages ?? inc.data?.counts
  const cfg = inc.data?.config
  const checks = learning.data?.golive?.checks ?? []
  const num = (k: string) => (stages ? ((stages as Record<string, number | undefined>)[k] ?? 0) : null)
  const proposed = stages ? (num('proposed') ?? 0) + (num('demote_proposed') ?? 0) : null

  const pairs = inc.data?.pairs
  const now = learning.data?.at ?? 0
  const shadowQuiet = pairs && now > 0 ? quietShadowCount(pairs, now) : null
  const cand = inc.data?.candidates
  const candidateReasons = cand
    ? [
        [cand.counts.noSlot + cand.counts.capped + cand.counts.cohort, 'waiting for capacity'],
        [cand.counts.outside + cand.counts.refused, 'market checks'],
        [cand.counts.expired + cand.counts.stale + cand.counts.rescreen, 'need fresh screening'],
        [(cand.counts.cooldown ?? 0) + (cand.counts.unavailable ?? 0), 'cooldown or scanner unavailable'],
        [cand.counts.admissible, 'ready for admission'],
      ]
        .filter(([count]) => Number(count) > 0)
        .map(([count, label]) => `${count} ${label}`)
        .join(' · ')
    : ''

  const stuck: Array<{ key: string; dot: Book; text: ReactNode; to: string; cta: string }> = []
  if (proposed)
    stuck.push({
      key: 'proposed',
      dot: 'shadow',
      text: `${proposed} proposal${proposed === 1 ? ' waits' : 's wait'} for your decision`,
      to: '/decisions',
      cta: 'Decide',
    })
  if (shadowQuiet)
    stuck.push({
      key: 'quiet',
      dot: 'shadow',
      text: `${shadowQuiet} shadow cell${shadowQuiet === 1 ? ' has' : 's have'} taken no trade in 30 days`,
      to: '/strategies?book=shadow',
      cta: 'See why',
    })
  if (cand && cand.passed > 0)
    stuck.push({
      key: 'cand',
      dot: 'backtest',
      text: `${cand.passed} scanner/market/timeframe cells passed screening and await shadow: ${candidateReasons}`,
      to: '/incubator?section=candidates',
      cta: 'Review admission',
    })

  return (
    <section className="home-panel" aria-label="Promotion ladder">
      <div className="home-panel-head">
        <h2>Promotion ladder</h2>
        <Link to="/strategies" className="home-link">
          All strategies
        </Link>
      </div>
      <div className="home-stages">
        <Stage
          book="backtest"
          name="BACKTEST"
          count={num('candidate') ?? '–'}
          what="candidate cells; screen freshness checked on admission"
          gate={
            cfg
              ? `${cfg.screen.minTrades}+ trades, profit factor ${cfg.screen.minProfitFactor}+, ${cfg.screen.minWindowsUp} of ${cfg.screen.slices} windows up, after ${cfg.screen.stressBps} bps of stress`
              : undefined
          }
        />
        <Stage
          book="shadow"
          name="SHADOW"
          count={num('shadow') ?? '–'}
          what={proposed ? `collecting live evidence, ${proposed} proposed` : 'collecting live evidence'}
          gate={
            cfg
              ? `Default gate; timeframe and policy checks also apply: ${cfg.gate.minTrades} trades over ${cfg.gate.minDays}+ days, profit factor ${cfg.gate.minPfR}+, ${cfg.gate.minPositiveWeeksPct}% positive weeks, ${fmtR(cfg.gate.minAvgR)} a trade`
              : undefined
          }
        />
        <Stage
          book="paper"
          name="PAPER"
          count={num('live') ?? '–'}
          what="account allocations; not a fill count"
          gate={checks.length ? `all ${checks.length} go-live checks pass` : undefined}
        />
        <Stage book="live" name="LIVE" count="–" what="strategy-level live evidence not reported" />
      </div>
      <div className="home-stuck">
        <div className="home-stuck-title">Where strategies are stuck</div>
        {stuck.length === 0 && (
          <div className="home-stuck-row muted">
            {stages
              ? 'Nothing is waiting on a decision, and no shadow cell has been quiet for 30 days.'
              : 'Loading the ladder'}
          </div>
        )}
        {stuck.map((r) => (
          <div key={r.key} className="home-stuck-row">
            <BookDot book={r.dot} />
            <span className="home-stuck-text">{r.text}</span>
            <Link to={r.to} className="home-link">
              {r.cta}
            </Link>
          </div>
        ))}
      </div>
    </section>
  )
}

// ---------- Reality gap ----------

interface GapRow {
  key: string
  book: Book
  label: string
  value: number | null
  tip?: string
}

export function RealityGap() {
  const learning = useLearning()
  const inc = useIncubatorView()
  const l = learning.data

  const screens = (inc.data?.pairs ?? [])
    .map((p) => p.screen)
    .filter((x): x is NonNullable<typeof x> => !!x && x.pass && Number.isFinite(x.avgR))
  const screenAvg = screenMeanR(screens)

  const rows: GapRow[] = [
    {
      key: 'backtest',
      book: 'backtest',
      label: 'Backtest screen',
      value: screenAvg,
      tip:
        screenAvg == null
          ? 'No pair has passed its screen yet, so there is no screen average to show.'
          : `Trade-weighted screen R over ${screens.length} pairs that passed it`,
    },
    {
      key: 'shadow',
      book: 'shadow',
      label: 'Shadow, forward',
      value: l && l.shadow.trades > 0 ? l.shadow.avgR : null,
      tip: l ? `${l.shadow.trades} shadow trades in ${l.shadow.windowDays ?? 30} days` : undefined,
    },
    {
      key: 'paper',
      book: 'paper',
      label: 'Paper, available history',
      value: l && l.live.trades > 0 ? l.live.avgR : null,
      tip: l ? `${l.live.trades} paper trades` : undefined,
    },
    {
      key: 'real',
      book: 'paper',
      label: 'Paper, matched real prints',
      value: null,
      tip: 'Unavailable: the aggregate tape audit does not match every entry and exit to the same closed-trade cohort. Aggregate fill slippage cannot be subtracted from book profit.',
    },
  ]
  const max = Math.max(0, ...rows.map((r) => (r.value == null ? 0 : Math.abs(r.value))))
  return (
    <section className="home-panel" aria-label="Book evidence">
      <div className="home-panel-head">
        <h2>Book evidence</h2>
      </div>
      <p className="home-note">
        These populations and time windows differ. Screen results cover passed pairs, shadow covers its
        forward window, and paper covers the available account history. These are not matched strategy
        comparisons.
      </p>
      <div className="home-gap">
        {rows.map((r) => {
          const w = r.value == null || max === 0 ? 0 : Math.max(3, (Math.abs(r.value) / max) * 100)
          const tone = r.value == null ? 'muted' : r.value >= 0 ? 'gain' : 'loss'
          return (
            <div className="home-gap-row" key={r.key} title={r.tip}>
              <span className="home-gap-label">
                <BookDot book={r.book} />
                {r.label}
              </span>
              <div className="home-gap-track" aria-hidden>
                <div className={`home-gap-bar ${tone}`} style={{ width: `${w}%` }} />
              </div>
              <span className={`home-gap-val mono ${tone}`}>{r.value == null ? 'n/a' : fmtR(r.value)}</span>
            </div>
          )
        })}
      </div>
      <p className="home-note">
        Tape-adjusted profit needs matched closed trades with every fill audited.{' '}
        <Link to="/exchange">Review execution and tape evidence</Link>.
      </p>
    </section>
  )
}

// ---------- ML advisor ----------

export function MlAdvisor() {
  const ml = useMl()
  const yard = useMlYardstick()
  const m = ml.data
  const model = m?.global?.model ?? null
  const auc = model?.auc ?? null
  const state = mlState(ml.isError ? undefined : m?.config)
  return (
    <section className="home-panel home-ml" aria-label="ML advisor">
      <div className="home-panel-head">
        <h2>ML advisor</h2>
        <span className="home-ml-pill">{state.label}</span>
      </div>
      <p className="home-note">{state.detail}</p>
      <div className="home-auc">
        <span className="home-auc-num mono">{auc != null ? auc.toFixed(2) : '–'}</span>
        <span className="home-auc-text">
          {auc == null ? (
            ml.isLoading ? (
              'Loading the model.'
            ) : ml.isError ? (
              'Model data is unavailable.'
            ) : (
              'No global model is reported.'
            )
          ) : (
            <>AUC on the time-ordered held-out test sample. {aucEvidence(auc)}</>
          )}
        </span>
      </div>
      {m && model && (
        <span className="home-note">
          Evaluation dataset: {m.samples.toLocaleString('en-US')} samples
          {m.trainedAt ? ` on ${new Date(m.trainedAt).toISOString().slice(0, 10)}` : ''},{' '}
          {model.holdout.toLocaleString('en-US')} held out for testing.
        </span>
      )}
      <span className="home-note">
        A profitable gate needs a frozen forward evaluation. AUC alone does not switch any setting.
        {yard.data?.call?.text ? ` Yardstick: ${yard.data.call.text}` : ''}
      </span>
      <Link to="/lab#ml" className="home-link">
        Open the ML workbench
      </Link>
    </section>
  )
}
