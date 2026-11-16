/** Coalesce each query key within a bounded window, even during a continuous event burst. */
export function batchedInvalidation(notify: (key: readonly unknown[]) => void, delay = 400) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  return {
    request(key: readonly unknown[]) {
      const id = JSON.stringify(key)
      if (timers.has(id)) return
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id)
          notify(key)
        }, delay),
      )
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}
