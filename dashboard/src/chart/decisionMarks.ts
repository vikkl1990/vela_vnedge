import type { TimelineMark } from '@luxalgo/vela'
import type { Signal } from '../api/types'

/** Journal facts at decision time, not freshly calculated indicator signals. Text content is escaped by Vela. */
export function decisionMarks(signals: Signal[]): TimelineMark[] {
  return signals.filter(s => s.kind !== 'info' && Number.isFinite(s.at) && Number.isFinite(s.barTime)).map(s => {
    const rejected = s.action.startsWith('rejected')
    const pending = s.action.startsWith('pending')
    const opened = s.action === 'opened' || s.action === 'reversed'
    return {
      id: `signal-${s.id}`, time: s.at, group: 'bot-decisions',
      title: `${s.scannerName} · ${s.tf}`,
      glyph: { color: rejected ? '#e5484d' : pending ? '#d29922' : opened ? '#3fb950' : '#a89cff', letter: rejected ? '×' : pending ? 'P' : opened ? 'E' : s.kind === 'exit' ? 'X' : '·' },
      tooltip: `${s.kind} ${s.side ?? ''} · ${s.action}`,
      content: { text: `Journal #${s.id}\n${s.symbol} ${s.tf} · ${s.kind} ${s.side ?? ''}\nAction: ${s.action}\nPrice: ${s.price ?? 'not published'} · SL: ${s.sl ?? 'not published'} · TP: ${(s.tp ?? []).join(', ')}\nSignal bar opened: ${new Date(s.barTime).toISOString()}\nDecision: ${new Date(s.at).toISOString()}\n${s.summary || s.message || ''}` },
    }
  })
}
