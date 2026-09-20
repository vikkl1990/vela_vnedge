import type { SSEEventMap, SSEEventName } from '../api/types'

type Handler<K extends SSEEventName> = (data: SSEEventMap[K]) => void

/**
 * Tiny typed event bus fed by the SSE connection. Non-React consumers (the Vela
 * data provider) subscribe here; React consumers use `useSSEEvent`.
 */
class SSEBus {
  private handlers = new Map<string, Set<(d: unknown) => void>>()

  on<K extends SSEEventName>(event: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    const h = handler as (d: unknown) => void
    set.add(h)
    return () => {
      set!.delete(h)
    }
  }

  emit<K extends SSEEventName>(event: K, data: SSEEventMap[K]): void {
    const set = this.handlers.get(event)
    if (!set) return
    for (const h of Array.from(set)) {
      try {
        h(data)
      } catch (e) {
        console.error(`[sse] handler for ${event} threw`, e)
      }
    }
  }
}

export const sseBus = new SSEBus()
