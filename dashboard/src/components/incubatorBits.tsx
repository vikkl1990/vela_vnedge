import type { IncubatorPair, IncubatorStats, IncubatorView } from '../api/types'
import { Pill } from './ui'
import { pf, r } from '../lib/incubatorLogic'


/** Progress toward one gate requirement, e.g. "22/30". Green once met. */
export function Need({ have, need, fmt = (x: number) => x.toFixed(0) }: { have: number; need: number; fmt?: (x: number) => string }) {
  const met = have >= need
  return <span className={`mono ${met ? 'gain' : 'muted'}`} title={met ? 'met' : 'not yet'}>{fmt(have)}/{fmt(need)}</span>
}

export function Evidence({ s, g }: { s: IncubatorStats | null; g: IncubatorView['config']['gate'] }) {
  if (!s) return <span className="muted">—</span>
  return (
    <span className="small">
      <Need have={s.trades} need={g.minTrades} /> trades · <Need have={s.days} need={g.minDays} /> days · PF <span className={`mono ${(s.pfR ?? 99) >= g.minPfR ? 'gain' : ''}`}>{pf(s.pfR)}</span> · {r(s.avgR)}/trade · {s.positiveWeeks}/{s.weeks} weeks up · win {s.winRatePct.toFixed(0)}%
    </span>
  )
}


/** Decision 112: the last 14 days of a cell's entry signals — opened, or the gate that refused them. */
export function Funnel({ f }: { f: IncubatorPair['funnel'] }) {
  if (!f) return <span className="muted">—</span>
  if (!f.entries) return <span className="muted">no signals</span>
  const parts = [
    ['regime', f.regime],
    ['cost', f.cost],
    ['market', f.market],
    ['quote', f.quote],
    ['other', f.other],
  ].filter(([, n]) => (n as number) > 0) as Array<[string, number]>
  return (
    <span>
      <span className="mono">{f.entries}</span> signals · <span className={f.opened ? 'gain' : 'loss'}>{f.opened} opened</span>
      {parts.length > 0 && <span className="muted"> · refused: {parts.map(([k, n]) => `${n} ${k}`).join(', ')}</span>}
    </span>
  )
}

/** The demotion clocks a live cell is on (decisions 106, 109, 112), or "none". */
export function Clocks({ p, cfg, now }: { p: IncubatorPair; cfg: IncubatorView['config']['demote']; now: number }) {
  const items: Array<{ text: string; tone: 'warn' | 'danger' }> = []
  const out = (p.gate as { marketOutDays?: number } | null)?.marketOutDays ?? 0
  if (p.market && !p.market.allowed) items.push({ text: `market out ${Math.floor(out)}/${cfg.marketOutDays ?? '–'} d`, tone: out >= (cfg.marketOutDays ?? Infinity) ? 'danger' : 'warn' })
  const silentDays = cfg.silentDaysByTf?.[p.tf] ?? cfg.silentDays
  if (!p.accountHolding && silentDays) {
    const last = p.lastTradeAt ?? p.since
    const days = Math.floor((now - last) / 86_400_000)
    if (days >= Math.max(1, Math.floor(silentDays / 2))) items.push({ text: `no account trade ${days}/${silentDays} d`, tone: days >= silentDays ? 'danger' : 'warn' })
  }
  if (!p.accountHolding && now - p.since >= (cfg.costStarvedDays ?? 14) * 86_400_000 && (p.lastTradeAt ?? 0) < now - (cfg.costStarvedDays ?? 14) * 86_400_000 && cfg.costStarvedRefusals && p.funnel && p.funnel.opened === 0 && p.funnel.cost > 0) items.push({ text: `cost-starved ${p.funnel.cost}/${cfg.costStarvedRefusals}`, tone: p.funnel.cost >= cfg.costStarvedRefusals ? 'danger' : 'warn' })
  if (!items.length) return <span className="muted">none</span>
  return <>{items.map((it) => <Pill key={it.text} tone={it.tone}>{it.text}</Pill>)}</>
}

