/** Keep all selected chart contexts, without retaining previously visited markets/scripts. */
export function activeChartKeys(symbol: string, frames: string[], ids: string[], prefix = '') {
  return new Set(frames.flatMap((tf) => ids.map((id) => `${symbol}:${tf}:${prefix}${id}`)))
}

export function retainChartRecord<T>(
  previous: Record<string, T>,
  key: string,
  value: T,
  active: Set<string>,
) {
  const next = Object.fromEntries(Object.entries(previous).filter(([k]) => active.has(k)))
  if (active.has(key)) next[key] = value
  return next
}
