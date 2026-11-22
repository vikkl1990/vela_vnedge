import type { IncubatorView } from '../api/types'
import { stageGuide } from '../lib/stageGuide'

/** What each incubator stage means and how a pair moves through them, from the live settings (decision 324). */
export function StageGuide({ config }: { config: IncubatorView['config'] }) {
  return (
    <details className="stage-guide">
      <summary>What these stages mean</summary>
      <dl>
        {stageGuide(config).map((s) => (
          <div key={s.id}>
            <dt>{s.label}</dt>
            <dd>
              {s.what} <span className="muted">{s.how}</span>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  )
}
