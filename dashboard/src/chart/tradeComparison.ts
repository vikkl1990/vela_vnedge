import type { ScriptRun, StrategyTrade, TimelineMark } from '@luxalgo/vela'
import type { JournalRow } from '../api/journal'
import type { ChartScript } from './VelaChart'
import { tfMs } from '../lib/timeframes.ts'

export interface AuthorLedger {
  id: string
  title: string
  symbol: string
  tf: string
  contextKey: string
  sourceHash: string | null
  timezone: string
  kind: ScriptRun['kind']
  from: number | null
  through: number
  complete: boolean
  inputsChanged?: boolean
  updatedAt: number
  trades: readonly StrategyTrade[]
  error?: string
}

export const scriptContextKey = (script: ChartScript) =>
  JSON.stringify([
    script.sourceHash ?? script.source,
    script.inputs ?? {},
    script.timezone ?? 'UTC',
    script.readingHash ?? null,
  ])

/** Exclude forming-bar fills. A closing fill on the forming bar leaves a settled entry open. */
export function settledTrades(trades: readonly StrategyTrade[], through: number) {
  return trades
    .filter((t) => Number.isFinite(t.entry.time) && t.entry.time < through)
    .map((t) =>
      t.exit && t.exit.time >= through
        ? { ...t, exit: undefined, open: true, pnl: undefined, commission: undefined }
        : t,
    )
}

export interface TradeComparison {
  bot: JournalRow
  author?: StrategyTrade
  status:
    | 'same entry bar'
    | 'ambiguous'
    | 'no same-bar entry'
    | 'source changed'
    | 'source unknown'
    | 'outside loaded history'
    | 'chart inputs changed'
}

/** A conservative visual association, never an assertion of identical execution or policy. */
export function compareTrades(rows: JournalRow[], ledger: AuthorLedger): TradeComparison[] {
  const candidates = rows.filter(
    (r) =>
      (r.sourceScannerId ?? r.scannerId) === ledger.id &&
      r.symbol === ledger.symbol &&
      r.tf === ledger.tf &&
      r.status === 'closed',
  )
  const bar = (at: number) => Math.floor(at / tfMs(ledger.tf))
  return candidates.map((bot) => {
    if (ledger.inputsChanged) return { bot, status: 'chart inputs changed' }
    if (
      bot.entryAt === null ||
      ledger.from === null ||
      bot.entryAt < ledger.from ||
      bot.entryAt >= ledger.through
    )
      return { bot, status: 'outside loaded history' }
    if (!bot.sourceHash || !ledger.sourceHash) return { bot, status: 'source unknown' }
    if (bot.sourceHash !== ledger.sourceHash) return { bot, status: 'source changed' }
    const matches = ledger.trades.filter(
      (t) => t.side === bot.side && bar(t.entry.time) === bar(bot.entryAt!),
    )
    const botsInBar = candidates.filter(
      (r) => r.side === bot.side && r.entryAt !== null && bar(r.entryAt) === bar(bot.entryAt!),
    )
    if (matches.length > 1 || botsInBar.length > 1) return { bot, status: 'ambiguous' }
    return matches.length === 1
      ? { bot, author: matches[0], status: 'same entry bar' }
      : { bot, status: 'no same-bar entry' }
  })
}

const n = (v: number | null | undefined, digits = 2) => (v == null ? 'unknown' : v.toFixed(digits))

/** Fill facts, with no conversion of decisions or pending orders into fills. */
export function botTradeMarks(rows: JournalRow[]): TimelineMark[] {
  return rows.flatMap((row) => {
    if (row.status !== 'closed' || row.missingPosition) return []
    const fills = (row.fills ?? []).filter(
      (f) => f.qty > 0 && f.reason !== 'funding' && Number.isFinite(f.at),
    )
    // Legacy position endpoints remain useful but are labelled as such.
    if (!fills.some((f) => f.reason === 'entry') && row.entryAt !== null && row.entryPrice !== null)
      fills.unshift({
        at: row.entryAt,
        price: row.entryPrice,
        qty: row.qty ?? 0,
        reason: 'entry (position record)',
        fee: 0,
        pnl: 0,
      })
    if (
      row.exitAt !== null &&
      row.exitPrice !== null &&
      !fills.some((f) => f.at === row.exitAt && !f.reason.startsWith('entry'))
    )
      fills.push({
        at: row.exitAt,
        price: row.exitPrice,
        qty: 0,
        reason: `final exit (position record): ${row.exitReason ?? 'unknown'}`,
        fee: 0,
        pnl: 0,
      })
    return fills.map((fill, i) => {
      const entry = fill.reason.startsWith('entry')
      const final = !entry && fill.at === row.exitAt && i === fills.length - 1
      const detail = `${row.book} #${row.id} · ${row.scannerName} · ${row.tf}\n${row.side} · ${fill.reason}\nPrice ${fill.price} · contracts ${fill.qty}\n${fill.reason.includes('position record') ? 'Legacy position endpoint; fill-level fees unavailable' : `Fill fee $${n(fill.fee)} · ${fill.liquidity ?? 'liquidity unknown'}`}\nTrade net $${n(row.net)} · ${n(row.r)}R · commission $${n(row.commission)} · funding $${n(row.funding)}\nExit: ${row.exitReason ?? 'unknown'}\nPolicy ${row.policyId ?? 'unknown'}`
      return {
        id: `bot-${row.book}-${row.id}-${i}`,
        time: fill.at,
        group: 'bot-fills',
        title: `Bot ${entry ? 'entry' : final ? 'exit' : 'partial exit'} #${row.id}${final ? ` · ${n(row.r)}R` : ''}`,
        glyph: {
          color: entry ? '#1878f2' : (row.net ?? 0) >= 0 ? '#3fb950' : '#e5484d',
          letter: entry ? 'B' : final ? 'X' : 'P',
        },
        tooltip: detail,
        content: { text: detail },
      }
    })
  })
}

export function authorTradeMarks(ledgers: AuthorLedger[]): TimelineMark[] {
  return ledgers
    .filter((l) => l.complete && !l.error)
    .flatMap((l) =>
      l.trades.flatMap((t) =>
        [{ fill: t.entry, exit: false }, ...(t.exit ? [{ fill: t.exit, exit: true }] : [])].map(
          ({ fill, exit }) => {
            const text = `AUTHOR SIMULATION · ${l.title} · ${l.tf}\n${t.side} ${exit ? 'exit' : 'entry'} · ${fill.price}\nOrder ${fill.id} · ${fill.comment ?? ''}\nSource ${l.sourceHash ?? 'unknown'} · timezone ${l.timezone}\nLoaded chart history only. Script costs/size differ from bot; not promotion evidence.`
            return {
              id: `author-${l.id}-${l.tf}-${t.id}-${exit ? 'exit' : 'entry'}`,
              group: 'author-simulation',
              time: fill.time,
              title: `Author ${exit ? 'exit' : 'entry'} · ${l.title} · ${l.tf}`,
              glyph: { color: '#a78bfa', letter: exit ? 'x' : 'A' },
              tooltip: text,
              content: { text },
            }
          },
        ),
      ),
    )
}
