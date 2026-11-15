import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import '../styles/pages/rowmenu.css'

export interface MenuItem {
  key: string
  label: ReactNode
  onSelect?: () => void
  /** an in-app route */
  to?: string
  /** an external address, opened in a new tab */
  href?: string
  danger?: boolean
  disabled?: boolean
  title?: string
}

/**
 * A small action menu (WAI-ARIA menu button). The list is drawn in a portal so a table's scroll box never clips it.
 * Arrow keys move, Home/End jump, Escape closes and returns focus to the button.
 */
export function RowMenu({
  label,
  items,
  children,
}: {
  label: string
  items: MenuItem[]
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 })
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()

  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) btn.current?.focus()
  }, [])

  const toggle = () => {
    if (open) return close(true)
    const r = btn.current?.getBoundingClientRect()
    if (!r) return
    const est = Math.min(
      window.innerHeight - 16,
      items.length * (window.matchMedia('(max-width: 700px)').matches ? 44 : 32) + 10,
    )
    const top = r.bottom + 4 + est > window.innerHeight ? Math.max(8, r.top - est - 4) : r.bottom + 4
    setPos({ top, right: Math.max(8, window.innerWidth - r.right) })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    menu.current
      ?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')
      ?.focus({ preventScroll: true })
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) setOpen(false)
    }
    // A click can finish a browser-initiated scroll after the menu opens. Re-anchor
    // instead of discarding that click; scrolling inside the menu must remain usable.
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return
      const anchor = btn.current?.getBoundingClientRect()
      const panel = menu.current
      if (!anchor || !panel) return
      if (anchor.bottom < 0 || anchor.top > window.innerHeight) {
        setOpen(false)
        return
      }
      const height = panel.getBoundingClientRect().height
      const top =
        anchor.bottom + 4 + height > window.innerHeight
          ? Math.max(8, anchor.top - height - 4)
          : anchor.bottom + 4
      setPos({ top, right: Math.max(8, window.innerWidth - anchor.right) })
    }
    const onResize = () => setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  const onKeyDown = (e: React.KeyboardEvent) => {
    const els = Array.from(
      menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [],
    )
    const i = els.indexOf(document.activeElement as HTMLElement)
    let next = -1
    if (e.key === 'ArrowDown') next = (i + 1) % els.length
    else if (e.key === 'ArrowUp') next = (i - 1 + els.length) % els.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = els.length - 1
    else if (e.key === 'Escape') {
      e.preventDefault()
      return close(true)
    } else if (e.key === 'Tab') return close(false)
    if (next < 0 || !els.length) return
    e.preventDefault()
    els[next].focus()
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={children ? 'btn' : 'btn btn-xs rowmenu-btn'}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={children ? undefined : label}
        onClick={toggle}
      >
        {children ?? (
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="currentColor">
            <circle cx="3" cy="8" r="1.5" />
            <circle cx="8" cy="8" r="1.5" />
            <circle cx="13" cy="8" r="1.5" />
          </svg>
        )}
        {children && (
          <span aria-hidden className="rowmenu-caret">
            ▾
          </span>
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={id}
            role="menu"
            aria-label={label}
            className="rowmenu"
            style={{ top: pos.top, right: pos.right }}
            onKeyDown={onKeyDown}
          >
            {items.map((it) => {
              const cls = `rowmenu-item ${it.danger ? 'rowmenu-danger' : ''}`
              const common = {
                role: 'menuitem',
                className: cls,
                title: it.title,
                'aria-disabled': it.disabled || undefined,
                tabIndex: -1,
              } as const
              if (it.to && !it.disabled)
                return (
                  <Link key={it.key} {...common} to={it.to} onClick={() => close(false)}>
                    {it.label}
                  </Link>
                )
              if (it.href && !it.disabled)
                return (
                  <a
                    key={it.key}
                    {...common}
                    href={it.href}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => close(false)}
                  >
                    {it.label}
                  </a>
                )
              return (
                <button
                  key={it.key}
                  type="button"
                  {...common}
                  onClick={() => {
                    if (it.disabled) return
                    close(true)
                    it.onSelect?.()
                  }}
                >
                  {it.label}
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </>
  )
}
