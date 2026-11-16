import { ASSET_GROUPS, ASSET_SECTORS } from '../../../shared/assetClass'
import { fmtInt, fmtPnl } from '../lib/format'
import type { ClassRow } from '../lib/assetClass'
import '../styles/asset-chip.css'

const tone = (v: number | null) => (v === null || v === 0 ? '' : v > 0 ? 'gain' : 'loss')
const avgR = (v: number | null) => (v === null ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`)

/**
 * Where the trades and the money come from, by asset class: majors, large-cap alts, alts, meme, stocks & metals, other.
 * One row per class that traded, in the fixed order of the classes, with each row's share of trades as a bar.
 */
export function AssetClassBreakdown({
  rows,
  book,
  kind = 'group',
  onChoose,
}: {
  rows: ClassRow[] | undefined
  /** Names the book in the empty message and the table's accessible label. */
  book: string
  kind?: 'group' | 'sector'
  onChoose?: (key: string) => void
}) {
  const order = (kind === 'group' ? ASSET_GROUPS : ASSET_SECTORS).map((x) => x.key as string)
  const label = (key: string) =>
    (kind === 'group' ? ASSET_GROUPS : ASSET_SECTORS).find((x) => x.key === key)?.label ?? key
  const used = (rows ?? [])
    .filter((r) => r.trades > 0)
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
  const total = used.reduce((n, r) => n + r.trades, 0)
  if (!used.length) return <p className="muted small">No closed {book} trades in this period.</p>
  return (
    <div
      className="class-breakdown"
      role="table"
      aria-label={`${book} results by ${kind === 'group' ? 'asset class' : 'sector'}`}
    >
      <div className="class-row class-row-head" role="row">
        <span role="columnheader">{kind === 'group' ? 'Class' : 'Sector'}</span>
        <span role="columnheader" className="class-share-heading">
          Share
        </span>
        <span role="columnheader" className="mono">
          R / trade
        </span>
        <span role="columnheader" className="mono">
          Net $
        </span>
      </div>
      {used.map((r) => {
        const s = r
        const name = (
          <span className="class-row-name">
            <span className="class-dot" aria-hidden="true" />
            <b>{label(r.key)}</b>
            <span className="small">{fmtInt(s.trades)}</span>
          </span>
        )
        return (
          <div key={r.key} className="class-row" role="row" data-group={kind === 'group' ? r.key : undefined}>
            {onChoose ? (
              <button
                className="link performance-group-link"
                onClick={() => onChoose(r.key)}
                title="Filter to this class"
              >
                {name}
              </button>
            ) : (
              name
            )}
            <div className="class-bar" aria-hidden="true">
              <span style={{ width: `${total ? (s.trades / total) * 100 : 0}%` }} />
            </div>
            <span className={`mono ${tone(s.avgR)}`}>{avgR(s.avgR)}</span>
            <span className={`mono ${tone(s.net)}`}>{fmtPnl(s.net)}</span>
          </div>
        )
      })}
    </div>
  )
}
