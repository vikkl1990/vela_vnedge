import type { FleetSource } from '../api/paperFleet'
import { sourceLabel, sourceTitle } from '../lib/fleet'

/** Where a paper trade came from: the account's own list, or a shadow copy at the pilot size. Unverified historical origins are labelled explicitly. */
export function SourceTag({
  source,
  scale,
}: {
  source: FleetSource | null | undefined
  scale?: number | null
}) {
  if (!source) return null
  return (
    <span className={source === 'own' ? 'pill pill-accent' : 'pill'} title={sourceTitle(source, scale)}>
      {sourceLabel(source, scale)}
    </span>
  )
}
