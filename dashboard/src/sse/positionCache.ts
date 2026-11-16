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
  next[index] = event.position
  return next
}
