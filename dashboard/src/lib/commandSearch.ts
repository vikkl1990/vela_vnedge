/** Ranking for the command palette: pages, scanners and actions in one list. Pure, so it is unit-tested. */
export type PaletteKind = 'page' | 'scanner' | 'action'

export interface PaletteItem {
  id: string
  kind: PaletteKind
  title: string
  /** shown under the title; also searched */
  subtitle?: string
  /** extra words that find the item but are not shown */
  keywords?: string
  /** route to open; actions have `run` instead */
  to?: string
  /** a keyboard hint such as "g o" */
  hint?: string
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
const tokens = (q: string) =>
  norm(q)
    .split(/[\s/·,-]+/)
    .filter(Boolean)

/** Every character of `needle` appears in `hay` in order, with a small bonus for runs. 0 when it does not. */
function subsequence(hay: string, needle: string): number {
  let i = 0
  let run = 0
  let best = 0
  for (const c of hay) {
    if (c === needle[i]) {
      i++
      run++
      best = Math.max(best, run)
      if (i === needle.length) return 4 + best
    } else run = 0
  }
  return 0
}

/** How well one query token matches one field: whole-word start beats a substring beats a scattered match. */
function field(hay: string, t: string): number {
  if (!hay) return 0
  if (hay === t) return 100
  if (hay.startsWith(t)) return 80
  if (hay.split(/[\s/·,-]+/).some((w) => w.startsWith(t))) return 60
  if (hay.includes(t)) return 35
  return t.length >= 3 ? subsequence(hay, t) : 0
}

/** 0 means "does not match". Every query token must match something; title matches weigh most. */
export function scoreItem(query: string, item: PaletteItem): number {
  const ts = tokens(query)
  if (!ts.length) return 1
  const title = norm(item.title)
  const sub = norm(item.subtitle ?? '')
  const kw = norm(item.keywords ?? '')
  let total = 0
  for (const t of ts) {
    const s = Math.max(field(title, t) * 1.0, field(sub, t) * 0.5, field(kw, t) * 0.6)
    if (s === 0) return 0
    total += s
  }
  // pages and actions are the things people reach for; scanners are the long tail
  return total / ts.length + (item.kind === 'scanner' ? 0 : 4)
}

/**
 * Rank `items` for `query`. With no query the recently used items come first (in the order given), then pages and
 * actions in their listed order; scanners only appear once someone types.
 */
export function rankItems(
  items: PaletteItem[],
  query: string,
  opts: { limit?: number; recent?: string[] } = {},
): PaletteItem[] {
  const limit = opts.limit ?? 40
  const recent = opts.recent ?? []
  if (!tokens(query).length) {
    const byId = new Map(items.map((i) => [i.id, i]))
    const first = recent.map((id) => byId.get(id)).filter((i): i is PaletteItem => Boolean(i))
    const seen = new Set(first.map((i) => i.id))
    const rest = items.filter((i) => i.kind !== 'scanner' && !seen.has(i.id))
    return [...first, ...rest].slice(0, limit)
  }
  const recentRank = new Map(recent.map((id, i) => [id, recent.length - i]))
  return items
    .map((item, order) => ({ item, order, s: scoreItem(query, item) }))
    .filter((x) => x.s > 0)
    .sort(
      (a, b) =>
        b.s + (recentRank.get(b.item.id) ?? 0) * 0.5 - (a.s + (recentRank.get(a.item.id) ?? 0) * 0.5) ||
        a.order - b.order,
    )
    .slice(0, limit)
    .map((x) => x.item)
}

/** Remember an opened item, newest first, no duplicates, capped. */
export function pushRecent(recent: string[], id: string, cap = 6): string[] {
  return [id, ...recent.filter((x) => x !== id)].slice(0, cap)
}
