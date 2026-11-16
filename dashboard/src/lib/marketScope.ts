import { useSyncExternalStore } from 'react'
import { ASSET_GROUPS, isAssetGroup, type AssetGroup } from '../../../shared/assetClass.ts'

/**
 * The market scope: one asset class the reader has chosen to look at, remembered in this browser. It is a default, never a
 * hidden filter: a page that applies it says so on the page, and a page's own asset-class choice (in its URL) always wins.
 * An empty scope means every market.
 */
export type MarketScope = AssetGroup | ''
export const SCOPE_KEY = 'vnedge.marketScope'

/** Anything that is not a known asset class is no scope, so a stale or edited value can never hide every market. */
export function parseScope(raw: string | null | undefined): MarketScope {
  return raw && isAssetGroup(raw) ? raw : ''
}

export function scopeLabel(scope: MarketScope): string {
  return scope ? (ASSET_GROUPS.find((g) => g.key === scope)?.label ?? scope) : 'All markets'
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const browser = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readScope(store: Store | null = browser()): MarketScope {
  try {
    return parseScope(store?.getItem(SCOPE_KEY))
  } catch {
    return ''
  }
}

export function writeScope(scope: MarketScope, store: Store | null = browser()): void {
  try {
    if (scope) store?.setItem(SCOPE_KEY, scope)
    else store?.removeItem(SCOPE_KEY)
  } catch {
    /* private window or blocked storage: the scope lasts until the page closes */
  }
}

let current: MarketScope = readScope()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function setMarketScope(scope: MarketScope): void {
  if (scope === current) return
  current = scope
  writeScope(scope)
  emit()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  // another tab changed it
  const onStorage = (e: StorageEvent) => {
    if (e.key !== SCOPE_KEY && e.key !== null) return
    const next = readScope()
    if (next !== current) {
      current = next
      emit()
    }
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(l)
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

export function useMarketScope(): [MarketScope, (s: MarketScope) => void] {
  const scope = useSyncExternalStore(
    subscribe,
    () => current,
    () => '' as MarketScope,
  )
  return [scope, setMarketScope]
}

/**
 * The asset class a page should apply: its own choice from the URL when there is one (`all` means every class, on purpose),
 * otherwise the market scope. `fromScope` says the scope, not the reader's page choice, is why a list is narrowed.
 */
export function effectiveGroup(
  urlValue: string | null,
  scope: MarketScope,
): { group: MarketScope; fromScope: boolean } {
  if (urlValue !== null) return { group: urlValue === 'all' ? '' : parseScope(urlValue), fromScope: false }
  return { group: scope, fromScope: scope !== '' }
}
