import { ASSET_GROUPS } from '../../../../shared/assetClass'
import { parseScope, scopeLabel, useMarketScope } from '../../lib/marketScope'
import '../../styles/market-scope.css'

/**
 * Which asset class the lists look at, set once for the pages that follow it (Journals, Performance, Radar, Signals).
 * It is lit while a class is chosen, so a narrowed list is never a surprise, and each page says when it applies it.
 */
export function MarketScopeSelect() {
  const [scope, setScope] = useMarketScope()
  return (
    <label
      className="market-scope"
      data-active={scope !== ''}
      title="Narrow Journals, Performance, Radar and Signals to one asset class. A page's own asset-class choice overrides it."
    >
      <span className="market-scope-label">Markets</span>
      <select
        className="select select-sm"
        aria-label={`Market scope: ${scopeLabel(scope)}`}
        value={scope}
        onChange={(e) => setScope(parseScope(e.target.value))}
      >
        <option value="">All markets</option>
        {ASSET_GROUPS.map((g) => (
          <option key={g.key} value={g.key} title={g.hint}>
            {g.label}
          </option>
        ))}
      </select>
    </label>
  )
}
