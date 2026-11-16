/** Shared UI refresh rates; these never control engine timing. */
export const REFRESH = { live: 10_000, normal: 30_000, slow: 60_000 } as const

/** Polling stays as a recovery fallback. A healthy event stream keeps these caches current. */
export function streamFallback(query: { state: { dataUpdatedAt: number } }): number {
  return Date.now() - query.state.dataUpdatedAt < REFRESH.slow ? REFRESH.slow : REFRESH.live
}

/** Metadata and retrospective studies change less often than operational views. */
export const METADATA_REFRESH = 5 * REFRESH.slow
export const STUDY_REFRESH = 10 * REFRESH.slow
