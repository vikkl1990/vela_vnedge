import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { useEquity, usePositions } from '../api/queries'
import type { FunnelStage, ScannerOverview, TradingOverview } from '../api/tradingOverview'
import { EquityChart } from '../components/charts'
import { DataTable, type Column } from '../components/DataTable'
import { Callout, Pill, QueryState, RouteHeader, Section, Stat, StatGrid, ToggleGroup } from '../components/kit'
import { PaperPositions } from '../components/PaperPositions'
import { fmtInt, fmtMoney, fmtNum, fmtPct, fmtPnl, fmtProfitFactor, fmtR, pnlClass } from '../lib/format'
import '../styles/pages/trading.css'

/**
 * The landing page for the account as it trades now: what it has made, how every entry signal was decided, how each
 * scanner is doing live beside its backtest, and the rules that decide entries. One request (/api/trading/overview),
 * read from the state the engine keeps, so nothing here can disagree with the engine.
 */
const WINDOWS = [
  { value: '1', label: '24h' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
] as const
type WindowValue = (typeof WINDOWS)[number]['value']

const tone = (v: number | null | undefined) => (v == null || v === 0 ? 'muted' : v > 0 ? 'gain' : 'loss')
const pf = (v: number | null, trades: number) => (trades === 0 ? '–' : v === null ? '∞' : fmtProfitFactor(v))

export function Trading() {
  const [win, setWin] = useState<WindowValue>('7')
  const q = useQuery({
    queryKey: ['trading-overview', win],
    queryFn: () => api.tradingOverview(Number(win)),
    refetchInterval: 15_000,
    staleTime: 10_000,
  })
  const equity = useEquity()
  const positions = usePositions()
  return (
    <div className="page trading">
      <RouteHeader
        sub="The paper account as it trades now: results, how each entry signal was decided, and the rules that decide them."
        actions={<ToggleGroup ariaLabel="Window" options={WINDOWS} value={win} onChange={setWin} />}
      />
      <QueryState {...q} data={q.data} onRetry={() => q.refetch()}>
        {(o) => (
          <>
            <AccountStats o={o} />
            <Section
              variant="panel"
              title="Equity"
              hint={`Started at ${fmtMoney(o.account.initialEquity, 0)} · peak ${fmtMoney(o.account.peakEquity, 2)}`}
              actions={
                <Link to="/analytics" className="btn btn-xs">
                  Performance →
                </Link>
              }
            >
              <EquityChart data={equity.data ?? []} baseline={o.account.initialEquity} height={200} />
            </Section>
            <div className="grid-2-1">
              <Funnel o={o} />
              <Rules o={o} />
            </div>
            <Scanners o={o} />
            <Section
              variant="panel"
              title={`Open positions (${o.account.openPositions})`}
              actions={
                <Link to="/trades" className="btn btn-xs">
                  Journal →
                </Link>
              }
            >
              <PaperPositions query={positions} compact />
            </Section>
          </>
        )}
      </QueryState>
    </div>
  )
}

function AccountStats({ o }: { o: TradingOverview }) {
  const w = o.window
  const total = o.account.equity - o.account.initialEquity
  const winRate = w.trades ? (w.wins / w.trades) * 100 : null
  const label = o.days < 1.5 ? '24h' : `${Math.round(o.days)} days`
  return (
    <StatGrid min={170}>
      <Stat
        label="Equity"
        value={fmtMoney(o.account.equity)}
        tone={tone(total)}
        sub={`${fmtPnl(total)} since start · ${o.account.mode}`}
      />
      <Stat label={`P&L, ${label}`} value={fmtPnl(w.pnl)} tone={tone(w.pnl)} sub={`net of ${fmtMoney(w.fees)} fees`} />
      <Stat
        label="Closed trades"
        value={fmtInt(w.trades)}
        sub={`${fmtNum(w.perDay, 1)} a day · ${fmtInt(w.opened)} opened`}
      />
      <Stat
        label="Win rate"
        value={winRate === null ? '–' : fmtPct(winRate, 0)}
        tone={winRate === null ? 'muted' : undefined}
        sub={`${w.wins} won · ${w.trades - w.wins} lost`}
      />
      <Stat label="Profit factor" value={pf(w.profitFactor, w.trades)} tone={w.trades ? tone((w.profitFactor ?? 2) - 1) : 'muted'} sub="gross won ÷ gross lost" />
      <Stat label="Average R" value={w.avgR === null ? '–' : fmtR(w.avgR)} tone={tone(w.avgR)} sub="net of fees, per trade" />
      <Stat
        label="Drawdown"
        value={fmtPct(o.account.drawdownPct, 1)}
        tone={o.account.drawdownPct > 5 ? 'warn' : 'muted'}
        sub={`worst ${fmtPct(o.account.maxDrawdownPct, 1)} · ${o.account.openPositions} open`}
      />
    </StatGrid>
  )
}

const STAGE_TONE: Record<FunnelStage, string> = {
  opened: 'gain', cost: 'accent', trend: 'accent', burst: 'warn', cooldown: 'warn', caps: 'warn', regime: 'warn', risk: 'loss', ignored: 'muted', other: 'muted',
}

export function Funnel({ o }: { o: TradingOverview }) {
  const f = o.funnel
  const max = Math.max(1, ...f.stages.map((s) => s.n))
  return (
    <Section
      variant="panel"
      title="Entry signals and what decided them"
      hint={`${fmtInt(f.fired)} entry signals fired · ${fmtInt(f.stages.find((s) => s.stage === 'opened')?.n ?? 0)} opened`}
      actions={
        <Link to="/signals" className="btn btn-xs">
          Signals →
        </Link>
      }
    >
      {f.fired === 0 ? (
        <div className="state muted">No entry signals in this window yet.</div>
      ) : (
        <ul className="funnel" aria-label="Entry signal outcomes">
          {f.stages.map((s) => (
            <li key={s.stage} className="funnel-row" title={s.example ?? undefined}>
              <span className="funnel-label">{s.label}</span>
              <span className="funnel-track" aria-hidden>
                <span className={`funnel-bar tone-bg-${STAGE_TONE[s.stage]}`} style={{ width: `${(s.n / max) * 100}%` }} />
              </span>
              <span className="funnel-n mono">{fmtInt(s.n)}</span>
              <span className="funnel-pct mono muted">{fmtPct((s.n / f.fired) * 100, 0)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

export function Rules({ o }: { o: TradingOverview }) {
  const p = o.policy
  const r = p.risk
  const rows: Array<[string, string]> = [
    ['Scanners', `${p.scanners} on ${p.markets} markets · ${p.timeframes.join(', ') || '–'}`],
    ['Cost rule', p.costRatio > 0 ? `stop ≥ ${p.costRatio}× round-trip fees` : 'off'],
    [
      'Trend gate',
      p.trendGate
        ? `${p.trendGate.mode} EMA${p.trendGate.emaLen}${p.trendGate.tf ? ` on ${p.trendGate.tf}` : ''}${p.trendGate.tfs ? ` · ${p.trendGate.tfs.join(', ')} signals only` : ''}`
        : 'off',
    ],
    ['Reversals', p.allowReversal ? 'an opposite signal closes the trade' : 'off: exits by stop, targets or script'],
    ['Sizing', `${p.sizing}${p.sizing === 'risk' ? ` · ${p.riskPerTradePct}% of equity a trade` : ''}`],
    ['Exits', `stop ${p.fallbackAtrSl}× ATR when the script gives none · targets ${p.tpSplit.map((x) => Math.round(x * 100)).join('/')}%${p.breakEvenAfterTp1 ? ' · breakeven after the first' : ''}`],
    ['Positions', `${r.maxPositionsTotal} total · ${r.maxPositionsPerSymbol} a market · ${r.perScannerMaxPositions} a scanner`],
    ['Pacing', `${r.reentryCooldownMinutes} min after a stop · one entry a side per ${r.burstWindowSec}s`],
    ['Loss limits', `−${r.maxDailyLossPct}% a day · −${r.maxWeeklyLossPct}% a week`],
    ['Regime', `${r.minAtrPct > 0 ? `ATR ≥ ${r.minAtrPct}%` : 'no ATR floor'} · weekends ${r.noWeekend ? 'off' : 'on'}`],
  ]
  return (
    <Section
      variant="panel"
      title="Rules in force"
      actions={
        <Link to="/gates" className="btn btn-xs">
          Gates →
        </Link>
      }
    >
      <dl className="rules">
        {rows.map(([k, v]) => (
          <div key={k} className="rules-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </Section>
  )
}

/** Live beside backtest: a scanner whose live average R sits well under its backtest is the first to question. */
function verdict(s: ScannerOverview): { text: string; tone: 'ok' | 'warn' | 'danger' | 'muted' } {
  if (s.live.trades < 20) return { text: `${s.live.trades} of 20 trades`, tone: 'muted' }
  const live = s.live.avgR ?? 0
  const bt = s.backtest?.avgR ?? null
  if (live < 0) return { text: 'losing live', tone: 'danger' }
  if (bt !== null && live < bt / 2) return { text: 'below backtest', tone: 'warn' }
  return { text: 'on track', tone: 'ok' }
}

function Scanners({ o }: { o: TradingOverview }) {
  const columns: Column<ScannerOverview>[] = [
    {
      key: 'name',
      header: 'Scanner',
      value: (s) => s.name,
      render: (s) => (
        <Link to={`/scanners/${encodeURIComponent(s.id)}`}>
          {s.name}
          <span className="muted"> · {s.markets} markets · {s.timeframes.join(', ')}</span>
        </Link>
      ),
      mobile: 'primary',
    },
    { key: 'fired', header: 'Signals', numeric: true, value: (s) => s.fired, render: (s) => `${fmtInt(s.opened)} / ${fmtInt(s.fired)}`, title: 'Opened / fired in the window' },
    { key: 'trades', header: 'Trades', numeric: true, value: (s) => s.live.trades, render: (s) => `${s.live.trades}${s.open ? ` +${s.open} open` : ''}` },
    { key: 'pnl', header: 'P&L', numeric: true, value: (s) => s.live.pnl, render: (s) => <span className={pnlClass(s.live.pnl)}>{fmtPnl(s.live.pnl)}</span> },
    { key: 'pf', header: 'PF', numeric: true, value: (s) => s.live.profitFactor ?? 0, render: (s) => pf(s.live.profitFactor, s.live.trades) },
    { key: 'avgR', header: 'Avg R', numeric: true, value: (s) => s.live.avgR ?? 0, render: (s) => <span className={pnlClass(s.live.avgR)}>{s.live.avgR === null ? '–' : fmtR(s.live.avgR)}</span> },
    {
      key: 'bt',
      header: 'Backtest R',
      numeric: true,
      title: 'Average R of the cached backtest on the same cells, net of fees',
      value: (s) => s.backtest?.avgR ?? null,
      render: (s) => (s.backtest?.avgR == null ? '–' : <span className={pnlClass(s.backtest.avgR)}>{fmtR(s.backtest.avgR)}</span>),
    },
    {
      key: 'pace',
      header: 'Trades a day',
      numeric: true,
      title: 'Live beside backtest',
      value: (s) => s.live.perDay,
      render: (s) => `${fmtNum(s.live.perDay, 1)} / ${s.backtest?.perDay == null ? '–' : fmtNum(s.backtest.perDay, 1)}`,
    },
    {
      key: 'verdict',
      header: 'Status',
      value: (s) => verdict(s).text,
      render: (s) => {
        const v = verdict(s)
        return <Pill tone={v.tone}>{v.text}</Pill>
      },
    },
  ]
  const losing = o.scanners.filter((s) => verdict(s).tone === 'danger')
  return (
    <Section variant="panel" title="Scanners: live beside backtest" hint="A verdict needs at least 20 closed trades." pad={false}>
      {losing.length > 0 && (
        <Callout tone="warn" title={`${losing.map((s) => s.name).join(', ')} losing live`}>
          Over 20 trades with a negative average R. Consider switching it off in Scanners.
        </Callout>
      )}
      <DataTable columns={columns} rows={o.scanners} rowKey={(s) => s.id} defaultSort={{ key: 'pnl', dir: 'desc' }} pageSize={0} emptyLabel="No scanners enabled." />
    </Section>
  )
}
