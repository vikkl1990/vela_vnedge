import type { PreparedScript, ScriptingEngine } from '@luxalgo/vela/plugin'
import { chartHistoryText } from '../../../shared/chartVerification.ts'

/** Execution metadata is per script, not the display clock or a shared provider mutation. */
export function withScriptTimezones(
  engine: ScriptingEngine,
  timezoneFor: (id: string) => string | undefined,
) {
  const ids = new WeakMap<PreparedScript, string>()
  const windows = new Map<string, () => Parameters<typeof chartHistoryText>[0]>()
  const wrapped: ScriptingEngine = {
    language: engine.language,
    capabilities: engine.capabilities,
    async prepare(source, id) {
      const prepared = await engine.prepare(source, id)
      ids.set(prepared, id)
      return prepared
    },
    execute(request, handlers) {
      const id = ids.get(request.prepared)
      const timezone = id ? timezoneFor(id) : undefined
      if (id) windows.set(id, request.getBars ?? (() => request.bars))
      return engine.execute(
        timezone
          ? {
              ...request,
              market: {
                ...request.market,
                symbolInfo: { ticker: request.market.symbol, ...request.market.symbolInfo, timezone },
              },
            }
          : request,
        handlers,
      )
    },
  }
  return {
    engine: wrapped,
    firstBar: (id: string) => windows.get(id)?.()[0]?.time ?? null,
    history: (id: string, through: number) => {
      const bars = windows
        .get(id)?.()
        .filter((b) => b.time <= through)
      return bars ? { text: chartHistoryText(bars, through), count: bars.length } : null
    },
  }
}
