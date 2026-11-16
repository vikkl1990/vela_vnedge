import { scopeLabel, setMarketScope, type MarketScope } from '../lib/marketScope'
import '../styles/market-scope.css'

/**
 * Said on a page whose list is narrowed by the market scope rather than by anything the reader chose on that page, with the
 * way out. Rendered only when the scope is the reason, so it never repeats a filter the page already shows.
 */
export function MarketScopeNote({ scope, shown, of }: { scope: MarketScope; shown?: number; of?: number }) {
  if (!scope) return null
  return (
    <div className="scope-note" role="status">
      <span>
        Showing <b>{scopeLabel(scope)}</b> only, from your market scope
        {shown !== undefined && of !== undefined ? ` · ${shown} of ${of}` : ''}.
      </span>
      <button type="button" className="btn btn-xs" onClick={() => setMarketScope('')}>
        Show all markets
      </button>
    </div>
  )
}
