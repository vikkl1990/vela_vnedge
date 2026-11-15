import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { pushRecent, rankItems, type PaletteItem } from '../../lib/commandSearch'
import { IconCornerDownLeft, IconSearch } from '../Icons'

const RECENT_KEY = 'vnedge.palette.recent'
const KIND_LABEL: Record<PaletteItem['kind'], string> = {
  page: 'Pages',
  action: 'Actions',
  scanner: 'Scanners',
}
const KIND_ORDER: Array<PaletteItem['kind']> = ['page', 'action', 'scanner']

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * ⌘K / Ctrl+K: jump to any page or scanner, or run a shell action, from the keyboard. Actions that change anything
 * (pause entries, reset the paper account) only open the same confirmation dialog as their buttons.
 */
export function CommandPalette({
  open,
  onClose,
  items,
  actions,
}: {
  open: boolean
  onClose: () => void
  items: PaletteItem[]
  actions: Record<string, () => void>
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const listId = useId()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [recent, setRecent] = useState<string[]>(readRecent)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      setQuery('')
      setActive(0)
      setRecent(readRecent())
      d.showModal()
      requestAnimationFrame(() => input.current?.focus())
    }
    if (!open && d.open) d.close()
  }, [open])

  const results = useMemo(() => {
    const ranked = rankItems(items, query, { recent, limit: 40 })
    // while typing, group by kind (pages, actions, scanners) and keep the ranking inside each group
    return query.trim()
      ? [...ranked].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
      : ranked
  }, [items, query, recent])
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (item: PaletteItem) => {
    const next = pushRecent(recent, item.id)
    setRecent(next)
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
    onClose()
    if (item.to) navigate(item.to)
    else actions[item.id]?.()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(results.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const it = results[active]
      if (it) choose(it)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(Math.max(0, results.length - 1))
    }
  }

  // a heading sits above the first row of each group, computed from the previous row so render stays pure
  const rows = results.map((it, i) => {
    const heading = !query && recent.includes(it.id) ? 'Recent' : KIND_LABEL[it.kind]
    const prev = results[i - 1]
    const prevHeading = prev ? (!query && recent.includes(prev.id) ? 'Recent' : KIND_LABEL[prev.kind]) : null
    return { it, i, heading, showHeading: heading !== prevHeading }
  })
  return (
    <dialog
      ref={ref}
      className="palette"
      aria-label="Command palette"
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <div className="palette-box" onKeyDown={onKeyDown}>
        <div className="palette-input">
          <IconSearch size={17} />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            placeholder="Search pages, scanners and actions…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
          />
          <kbd className="palette-esc">esc</kbd>
        </div>
        <div className="palette-list" role="listbox" id={listId} ref={listRef} aria-label="Results">
          {results.length === 0 && <div className="palette-empty">Nothing matches “{query}”.</div>}
          {rows.map(({ it, i, heading, showHeading }) => (
            <div key={it.id}>
              {showHeading && (
                <div className="palette-heading" role="presentation">
                  {heading}
                </div>
              )}
              <div
                id={`${listId}-${i}`}
                data-idx={i}
                role="option"
                aria-selected={i === active}
                className={`palette-item ${i === active ? 'on' : ''}`}
                onMouseMove={() => setActive(i)}
                onClick={() => choose(it)}
              >
                <span className="palette-title">{it.title}</span>
                {it.subtitle && <span className="palette-sub">{it.subtitle}</span>}
                {it.hint && <kbd className="palette-hint">{it.hint}</kbd>}
              </div>
            </div>
          ))}
        </div>
        <div className="palette-foot" aria-hidden>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>
              <IconCornerDownLeft size={11} />
            </kbd>{' '}
            open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
          <span className="palette-count">
            {results.length}
            {query ? ' found' : ' shown'}
          </span>
        </div>
      </div>
    </dialog>
  )
}
