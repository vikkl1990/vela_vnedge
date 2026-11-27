import type {
  PreparedScript,
  ScriptingEngine,
  ExecutionRequest,
  ExecutionSession,
  EngineAlert,
} from '@luxalgo/vela/plugin'
import { chartHistoryText } from '../../../shared/chartVerification.ts'
import { signalMetadataText } from '../../../shared/signalMetadata.ts'
import { alertKey, labelKey, type ChartChannels } from '../../../shared/chartChannels.ts'

type Model = Parameters<Parameters<ScriptingEngine['execute']>[1]['onModel']>[0]
export interface ClosedProof {
  plots: Record<string, readonly { time: number; value: unknown }[]>
  history: { text: string; count: number; from: number | null }
  signalMetadata: string
  channels: ChartChannels
}

/** Script timezone and closed-run diagnostics share the installed bridge worker.
 * A verification session never renders, emits an app signal or writes trade evidence. */
export function withScriptTimezones(
  engine: ScriptingEngine,
  timezoneFor: (id: string) => string | undefined,
) {
  const ids = new WeakMap<PreparedScript, string>()
  const windows = new Map<string, () => ExecutionRequest['bars']>()
  const requests = new Map<string, ExecutionRequest>()
  const sources = new Map<string, string>()
  const proofs = new Map<string, { key: string; promise: Promise<ClosedProof | null> }>()
  const cancelProof = new Map<string, () => void>()
  let queue: Promise<unknown> = Promise.resolve()
  const wrapped: ScriptingEngine = {
    language: engine.language,
    capabilities: engine.capabilities,
    async prepare(source, id) {
      const prepared = await engine.prepare(source, id)
      ids.set(prepared, id)
      sources.set(id, source)
      return prepared
    },
    execute(request, handlers) {
      const id = ids.get(request.prepared),
        timezone = id ? timezoneFor(id) : undefined
      const effective = timezone
        ? {
            ...request,
            market: {
              ...request.market,
              symbolInfo: { ticker: request.market.symbol, ...request.market.symbolInfo, timezone },
            },
          }
        : request
      if (id) {
        windows.set(id, request.getBars ?? (() => request.bars))
        requests.set(id, effective)
      }
      const session = engine.execute(effective, handlers)
      return {
        ...session,
        stop() {
          session.stop()
          if (id && requests.get(id) === effective) {
            requests.delete(id)
            windows.delete(id)
            proofs.delete(id)
            cancelProof.get(id)?.()
            cancelProof.delete(id)
          }
        },
      }
    },
  }
  const closedProof = (
    id: string,
    through: number,
    inputs: Record<string, number | string | boolean>,
    inputBars?: ExecutionRequest['bars'],
  ): Promise<ClosedProof | null> => {
    const request = requests.get(id)
    if (!request) return Promise.resolve(null)
    const bars = (inputBars ?? request.getBars?.() ?? request.bars)
      .filter((b) => b.time <= through)
      .map((b) => ({ ...b }))
    if (!bars.length || bars.at(-1)?.time !== through) return Promise.resolve(null)
    const text = chartHistoryText(bars, through),
      key = JSON.stringify([through, inputs, text, request.market.symbolInfo])
    const cached = proofs.get(id)
    if (cached?.key === key) return cached.promise
    cancelProof.get(id)?.()
    const promise = queue.then(
      () =>
        new Promise<ClosedProof | null>((resolve) => {
          if (requests.get(id) !== request || proofs.get(id)?.key !== key) {
            resolve(null)
            return
          }
          let session: ExecutionSession | undefined,
            model: Model | null = null,
            done = false
          const alerts: EngineAlert[] = []
          let truncated = false
          const finish = (value: ClosedProof | null) => {
            if (done) return
            done = true
            clearTimeout(timer)
            try {
              session?.stop()
            } catch {
              /* The chart may already have destroyed its worker. */
            }
            cancelProof.delete(id)
            resolve(value)
          }
          const timer = setTimeout(() => finish(null), 20000)
          cancelProof.set(id, () => finish(null))
          try {
            session = engine.execute(
              { ...request, mode: 'static', historyState: 'complete', bars, getBars: () => bars, inputs },
              {
                onModel(value) {
                  model = value
                },
                onAlert(a) {
                  if (a.time === through || (a.time === 0 && bars[a.barIndex]?.time === through)) {
                    if (alerts.length < 300) alerts.push(a)
                    else truncated = true
                  }
                },
                onError() {
                  finish(null)
                },
                onDone() {
                  void (async () => {
                    if (done) return
                    const snapshot = await session?.getContext?.(['plots'])
                    if (!snapshot || done) {
                      finish(null)
                      return
                    }
                    const labels = (model as Model | null)?.labels ?? []
                    const source = sources.get(id) ?? ''
                    const hasLabels = /\blabel\.new\s*\(/.test(source)
                    const mixed = hasLabels && /\bplot(?:shape|char|arrow)\s*\(/.test(source)
                    finish({
                      plots: snapshot.plots,
                      history: { text, count: bars.length, from: bars[0]?.time ?? null },
                      signalMetadata: signalMetadataText(request.market.symbolInfo ?? {}),
                      channels: {
                        alerts: alerts.map((a) => alertKey(a, bars)).sort(),
                        labels: hasLabels
                          ? labels
                              .slice(-300)
                              .map((l) => labelKey(l, bars))
                              .sort()
                          : [],
                        labelsVerified: !mixed,
                        truncated: truncated || (hasLabels && labels.length >= 300),
                        ...(/\bstrategy\s*\(/.test(source)
                          ? { unavailable: 'Strategy-ledger channels unverified; inspect author comparison' }
                          : /\brequest\.(?:security|security_lower_tf|footprint)\s*\(/.test(source)
                            ? {
                                unavailable:
                                  'Secondary-series or footprint history unverified; outputs are advisory',
                              }
                            : {}),
                      },
                    })
                  })().catch(() => finish(null))
                },
              },
            )
          } catch {
            finish(null)
          }
        }),
    )
    proofs.set(id, { key, promise })
    queue = promise.catch(() => null)
    return promise
  }
  return {
    engine: wrapped,
    closedProof,
    firstBar: (id: string) => windows.get(id)?.()[0]?.time ?? null,
    history: (id: string, through: number) => {
      const bars = windows
        .get(id)?.()
        .filter((b) => b.time <= through)
      return bars ? { text: chartHistoryText(bars, through), count: bars.length } : null
    },
  }
}
