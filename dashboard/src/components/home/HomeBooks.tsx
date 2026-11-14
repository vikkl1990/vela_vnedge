import { useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { useEquity, useHealth, useLearning, useLibrary, useMl, useMlYardstick, usePositions, useRisk, useScreenQueue, useStats, useTapeAudit } from '../../api/queries'
import type { Book } from '../../lib/books'
import { useBook } from '../../lib/bookScope'
import { fmtMoney, fmtPct, fmtPnl, fmtR, pnlClass } from '../../lib/format'
import { Callout, Sparkline } from '../kit'
import { BookCard, BookDot } from '../kit/books'

/** The incubator, shared with the shell by query key so it is fetched once. */
function useIncubatorView() {
  return useQuery({ queryKey: ['incubator'], queryFn: api.incubator, refetchInterval: 60_000, staleTime: 20_000 })
}

const DAY = 86_400_000

// ---------- Live status ----------

/** One sentence on whether anything can reach the exchange, with the way to the go-live checklist. */
/** Fewest audited fills before 'paper at real prints' is shown. */
const MIN_AUDITED_FILLS = 20

export function LiveStatusStrip() {
  const health = useHealth()
  const learning = useLearning()
  const mode = health.data?.mode
  const checks = learning.data?.golive?.checks ?? []
  const ok = checks.filter((c) => c.ok).length
  const armed = mode === 'live'
  const link = (
    <Link to="/live" className="btn btn-sm">{checks.length ? `Go-live checklist, ${ok} of ${checks.length}` : 'Go-live checklist'}</Link>
  )
  if (!mode) return null
  return (
    <section aria-label="Live status">
      <Callout tone={armed ? 'info' : 'warn'} title={armed ? 'Live is armed.' : 'Live is off.'} actions={link}>
        {armed
          ? 'Orders reach the exchange with real money. Every trade in the Live book is real.'
          : `Paper trades on Delta India prices and nothing reaches the exchange.${checks.length ? ` Live opens when all ${checks.length} go-live checks pass.` : ''}`}
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
  const armed = mode === 'live'
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
  const onLadder = scripts ? scripts.filter((x) => ['candidate', 'shadow', 'proposed', 'live', 'demote_proposed'].some((k) => (x.stages[k as keyof typeof x.stages] ?? 0) > 0)).length : null
  const lastScreen = inc.data?.lastRun?.at

  const dim = (b: Book) => (scope !== 'all' && scope !== b ? 'home-card home-dim' : 'home-card')

  return (
    <section className="home-books" aria-label="The four books">
      <div className={dim('live')}>
        <BookCard
          book="live"
          state={armed ? 'Armed' : 'Off'}
          headline={armed ? 'Armed' : 'Not armed'}
          sub={checks.length ? `${checks.filter((c) => c.ok).length} of ${checks.length} go-live checks pass. ${armed ? 'Orders reach the exchange.' : 'No order can reach the exchange.'}` : armed ? 'Orders reach the exchange.' : 'No order can reach the exchange.'}
          footer={<Link to="/live">Open the go-live checklist</Link>}
        >
          {checks.length > 0 && (
            <div className="home-segs" role="img" aria-label={`${checks.filter((c) => c.ok).length} of ${checks.length} go-live checks pass`} style={{ ['--segs' as string]: checks.length }}>
              {checks.map((c) => <span key={c.key} className={c.ok ? 'on' : ''} title={`${c.label}: ${c.ok ? 'passes' : 'does not pass'}`} />)}
            </div>
          )}
        </BookCard>
      </div>

      <div className={dim('paper')}>
        <BookCard
          book="paper"
          state={risk.data?.halted ? 'Halted' : mode === 'paper' || !mode ? 'Running' : 'Mirrored'}
          headline={s ? fmtMoney(s.equity, 2) : '–'}
          sub={s ? (
            <span>
              {day ? <span className={pnlClass(day.pnl)}>{fmtPnl(day.pnl)}</span> : '–'} today · {s.openPositions} open · {openRiskPct == null ? '–' : fmtPct(openRiskPct)} of equity at the stops · edge{' '}
              <span className={l ? pnlClass(l.live.avgR) : ''}>{l ? fmtR(l.live.avgR) : '–'}</span> a trade
            </span>
          ) : 'Loading the account'}
          footer={<Link to="/trades?book=paper">Paper trades and positions</Link>}
        >
          {eqSpark.length > 1 && <div className="home-spark paper"><Sparkline values={eqSpark} tone="accent" /></div>}
        </BookCard>
      </div>

      <div className={dim('shadow')}>
        <BookCard
          book="shadow"
          state={inc.data ? (inc.data.enabled ? 'Collecting' : 'Off') : '–'}
          headline={openShadow != null ? `${openShadow} open` : shadowCells != null ? `${shadowCells} cells` : '–'}
          sub={l ? `${l.shadow.trades} trades in ${l.shadow.windowDays ?? 30} days · ${fmtR(l.shadow.avgR)} a trade${shadowCells != null ? ` · ${shadowCells} cells watched` : ''} · never real money` : 'Research trades on live prices, never real money'}
          footer={<Link to="/strategies?book=shadow">Shadow evidence by strategy</Link>}
        >
          {shadowCurve.length > 1 && <div className="home-spark shadow"><Sparkline values={shadowCurve} tone="muted" /></div>}
        </BookCard>
      </div>

      <div className={dim('backtest')}>
        <BookCard
          book="backtest"
          state={queue.data ? (queue.data.running ? 'Running' : 'Idle') : '–'}
          headline={scripts ? String(scripts.length) : '–'}
          sub={scripts ? `scripts in the library · ${onLadder} have a pair on the ladder (candidate, shadow or live)${lastScreen ? ` · last screen ${new Date(lastScreen).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}` : 'Replay on history'}
          footer={<Link to="/lab">Open the Lab</Link>}
        />
      </div>
    </section>
  )
}

// ---------- Promotion ladder ----------

function Stage({ book, name, count, what, gate }: { book: Book; name: string; count: ReactNode; what: ReactNode; gate?: ReactNode }) {
  return (
    <div className={`home-stage home-stage-${book}`}>
      <span className="home-stage-name"><BookDot book={book} />{name}</span>
      <span className="home-stage-count mono">{count}</span>
      <span className="home-stage-what">{what}</span>
      {gate && <span className="home-stage-gate">To climb: {gate}</span>}
    </div>
  )
}

export function PromotionLadder() {
  const learning = useLearning()
  const inc = useIncubatorView()
  const health = useHealth()
  const stages = learning.data?.funnel.stages ?? inc.data?.counts
  const cfg = inc.data?.config
  const checks = learning.data?.golive?.checks ?? []
  const armed = health.data?.mode === 'live'
  const num = (k: string) => (stages ? ((stages as Record<string, number | undefined>)[k] ?? 0) : null)
  const proposed = stages ? (num('proposed') ?? 0) + (num('demote_proposed') ?? 0) : null

  const pairs = inc.data?.pairs
  const now = learning.data?.at ?? 0
  const shadowQuiet = pairs?.filter((p) => p.stage === 'shadow' && (p.lastTradeAt != null ? now - p.lastTradeAt > 30 * DAY : (p.stats?.trades ?? 0) === 0)).length ?? null
  const cand = inc.data?.candidates
  const blocked = cand ? Math.max(0, cand.passed - cand.counts.admissible) : null

  const stuck: Array<{ key: string; dot: Book; text: ReactNode; to: string; cta: string }> = []
  if (proposed) stuck.push({ key: 'proposed', dot: 'shadow', text: `${proposed} proposal${proposed === 1 ? ' waits' : 's wait'} for your decision`, to: '/decisions', cta: 'Decide' })
  if (shadowQuiet) stuck.push({ key: 'quiet', dot: 'shadow', text: `${shadowQuiet} shadow cell${shadowQuiet === 1 ? ' has' : 's have'} taken no trade in 30 days`, to: '/strategies?book=shadow', cta: 'See why' })
  if (cand && cand.passed > 0) stuck.push({ key: 'cand', dot: 'backtest', text: `${cand.passed} pair${cand.passed === 1 ? '' : 's'} passed the backtest screen and ${cand.passed === 1 ? 'is' : 'are'} not in the shadow book${blocked ? `; ${blocked} blocked, ${cand.counts.admissible} can be admitted now` : ''}`, to: '/strategies?book=backtest', cta: 'See why' })

  return (
    <section className="home-panel" aria-label="Promotion ladder">
      <div className="home-panel-head">
        <h2>Promotion ladder</h2>
        <Link to="/strategies" className="home-link">All strategies</Link>
      </div>
      <div className="home-stages">
        <Stage
          book="backtest" name="BACKTEST" count={num('candidate') ?? '–'} what="pairs passed the screen"
          gate={cfg ? `${cfg.screen.minTrades}+ trades, profit factor ${cfg.screen.minProfitFactor}+, ${cfg.screen.minWindowsUp} of ${cfg.screen.slices} windows up, after ${cfg.screen.stressBps} bps of stress` : undefined}
        />
        <Stage
          book="shadow" name="SHADOW" count={num('shadow') ?? '–'} what={proposed ? `collecting live evidence, ${proposed} proposed` : 'collecting live evidence'}
          gate={cfg ? `${cfg.gate.minTrades} trades over ${cfg.gate.minDays}+ days, profit factor ${cfg.gate.minPfR}+, ${cfg.gate.minPositiveWeeksPct}% positive weeks, ${fmtR(cfg.gate.minAvgR)} a trade` : undefined}
        />
        <Stage
          book="paper" name="PAPER" count={num('live') ?? '–'} what="trading the paper account"
          gate={checks.length ? `all ${checks.length} go-live checks pass` : undefined}
        />
        <Stage book="live" name="LIVE" count={armed ? (num('live') ?? '–') : 0} what={armed ? 'real money' : 'real money, not armed'} />
      </div>
      <div className="home-stuck">
        <div className="home-stuck-title">Where strategies are stuck</div>
        {stuck.length === 0 && <div className="home-stuck-row muted">{stages ? 'Nothing is waiting on a decision, and no shadow cell has been quiet for 30 days.' : 'Loading the ladder'}</div>}
        {stuck.map((r) => (
          <div key={r.key} className="home-stuck-row">
            <BookDot book={r.dot} />
            <span className="home-stuck-text">{r.text}</span>
            <Link to={r.to} className="home-link">{r.cta}</Link>
          </div>
        ))}
      </div>
    </section>
  )
}

// ---------- Reality gap ----------

interface GapRow { key: string; book: Book; label: string; value: number | null; tip?: string }

export function RealityGap() {
  const learning = useLearning()
  const inc = useIncubatorView()
  const tape = useTapeAudit(30)
  const l = learning.data

  const screens = (inc.data?.pairs ?? []).map((p) => p.screen).filter((x): x is NonNullable<typeof x> => !!x && x.pass && Number.isFinite(x.avgR))
  const screenAvg = screens.length ? screens.reduce((a, x) => a + x.avgR, 0) / screens.length : null

  // Slip in R per paper trade: every audited account fill's mean slip, over the paper trades of the same 30 days.
  const slip = useMemo(() => {
    const fills = tape.data?.fills.filter((f) => f.book === 'account' && f.meanR != null) ?? []
    if (!fills.length || !l?.live.daily) return null
    const cutoff = new Date(l.at - 30 * DAY).toISOString().slice(0, 10)
    const trades = l.live.daily.filter((d) => d.day >= cutoff).reduce((a, d) => a + d.n, 0)
    if (trades <= 0) return null
    const watched = (f: (typeof fills)[number]) => Math.max(0, f.n - f.noPrints - (f.late ?? 0) - (f.unobserved ?? 0))
    const n = fills.reduce((a, f) => a + watched(f), 0)
    // a handful of audited fills says nothing about the average: below this the figure stays n/a
    if (n < MIN_AUDITED_FILLS) return null
    return { perTrade: fills.reduce((a, f) => a + (f.meanR as number) * watched(f), 0) / trades, fills: n, trades }
  }, [tape.data, l])

  const rows: GapRow[] = [
    { key: 'backtest', book: 'backtest', label: 'Backtest screen', value: screenAvg, tip: screenAvg == null ? 'No pair has passed its screen yet, so there is no screen average to show.' : `Mean of the screen's average R over ${screens.length} pairs that passed it` },
    { key: 'shadow', book: 'shadow', label: 'Shadow, forward', value: l && l.shadow.trades > 0 ? l.shadow.avgR : null, tip: l ? `${l.shadow.trades} shadow trades in ${l.shadow.windowDays ?? 30} days` : undefined },
    { key: 'paper', book: 'paper', label: 'Paper', value: l && l.live.trades > 0 ? l.live.avgR : null, tip: l ? `${l.live.trades} paper trades` : undefined },
    {
      key: 'real', book: 'paper', label: 'Paper, real prints',
      value: l && l.live.trades > 0 && slip != null ? l.live.avgR - slip.perTrade : null,
      tip: slip != null ? `Paper average R minus the mean slippage of ${fmtR(slip.perTrade)} a trade measured against Delta's real prints (audited account fills of the last 30 days, over that window's paper trades). Unaudited fills count as zero slip, so the true figure may be lower.` : 'n/a: the tape audit has no audited account fills in the last 30 days, or no paper trades in that window, so the slippage cannot be measured.',
    },
  ]
  const max = Math.max(0, ...rows.map((r) => (r.value == null ? 0 : Math.abs(r.value))))
  const bt = rows[0].value, real = rows[3].value
  return (
    <section className="home-panel" aria-label="The reality gap">
      <div className="home-panel-head"><h2>The reality gap</h2></div>
      <p className="home-note">The same strategies measured four ways, in R per trade. A backtest only counts once it survives each step down.</p>
      <div className="home-gap">
        {rows.map((r) => {
          const w = r.value == null || max === 0 ? 0 : Math.max(3, (Math.abs(r.value) / max) * 100)
          const tone = r.value == null ? 'muted' : r.value >= 0 ? 'gain' : 'loss'
          return (
            <div className="home-gap-row" key={r.key} title={r.tip}>
              <span className="home-gap-label"><BookDot book={r.book} />{r.label}</span>
              <div className="home-gap-track" aria-hidden><div className={`home-gap-bar ${tone}`} style={{ width: `${w}%` }} /></div>
              <span className={`home-gap-val mono ${tone}`}>{r.value == null ? 'n/a' : fmtR(r.value)}</span>
            </div>
          )
        })}
      </div>
      {slip != null && <p className="home-note">Real prints: slippage from {slip.fills} audited fill{slip.fills === 1 ? '' : 's'} over {slip.trades} paper trade{slip.trades === 1 ? '' : 's'} in the last 30 days. A small sample moves it a lot.</p>}
      {bt != null && real != null && (
        <div className="home-callout">Screens promise {fmtR(bt)}. Real prints deliver {fmtR(real)}. Everything in the Lab is judged against this gap.</div>
      )}
    </section>
  )
}

// ---------- ML advisor ----------

const MODES = ['Off', 'Advise', 'Size', 'Gate'] as const

export function MlAdvisor() {
  const ml = useMl()
  const yard = useMlYardstick()
  const m = ml.data
  const model = m?.global?.model ?? null
  const auc = model?.auc ?? null
  const asScore = m?.config?.useAsScore === true
  const current: (typeof MODES)[number] = asScore ? 'Gate' : 'Off'
  return (
    <section className="home-panel home-ml" aria-label="ML advisor">
      <div className="home-panel-head">
        <h2>ML advisor</h2>
        <span className="home-ml-pill">{asScore ? 'In use' : auc != null && auc < 0.55 ? 'Off, no skill yet' : 'Off'}</span>
      </div>
      <div className="home-modes" role="list" aria-label="Advisor modes" title="The configuration has one switch today: the model score is either used or not. Off and Gate are the two states it can be in.">
        {MODES.map((x) => (
          <div key={x} role="listitem" className={`home-mode ${x === current ? 'on' : ''}`} aria-current={x === current ? 'true' : undefined}>{x}</div>
        ))}
      </div>
      <div className="home-auc">
        <span className="home-auc-num mono">{auc != null ? auc.toFixed(2) : '–'}</span>
        <span className="home-auc-text">
          {auc == null ? (ml.isLoading ? 'Loading the model.' : 'No model has been trained yet.') : <>out-of-sample AUC on weeks it never saw.{auc < 0.55 ? ' A coin flip.' : ''}</>}
        </span>
      </div>
      {m && model && (
        <span className="home-note">
          Trained on {m.samples.toLocaleString('en-US')} trades{m.trainedAt ? ` on ${new Date(m.trainedAt).toISOString().slice(0, 10)}` : ''}, tested on {model.holdout.toLocaleString('en-US')} it did not see.
        </span>
      )}
      <span className="home-note">It unlocks only when it beats taking every signal on weeks it never saw.{yard.data?.call?.text ? ` Yardstick: ${yard.data.call.text}` : ''}</span>
      <Link to="/lab#ml" className="home-link">Open the ML workbench</Link>
    </section>
  )
}
