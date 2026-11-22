import type { Position } from '../api/types/trading.ts'
import type { PositionEvent } from '../api/types/events.ts'

/** A stream delta can update a loaded snapshot, but cannot create a complete one. */
export function mergePositionEvent(
  previous: Position[] | undefined,
  event: PositionEvent,
): Position[] | undefined {
  if (!previous) return undefined
  const index = previous.findIndex((position) => position.id === event.position.id)
  if (event.type === 'closed' || event.type === 'voided') {
    return index < 0 ? previous : previous.filter((position) => position.id !== event.position.id)
  }
  if (index < 0) return [event.position, ...previous]
  const next = previous.slice()
  // Origin is immutable admission metadata. Older stream payloads omit it;
  // an omission must not erase the last verified HTTP receipt.
  const prior = previous[index]
  const updated = { ...event.position }
  if (updated.fleetSource === undefined && prior.fleetSource !== undefined)
    updated.fleetSource = prior.fleetSource
  if (updated.entrySizeScale === undefined && prior.entrySizeScale !== undefined)
    updated.entrySizeScale = prior.entrySizeScale
  next[index] = updated
  return next
}
