import { useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { IconChevronDown, IconKeyboard, IconLogOut, IconMoon, IconRows, IconSun } from '../Icons'
import { ACCOUNT_PAGES } from './nav'

export type AccountUser = { username: string; displayName?: string | null; roleLabel: string }

/** The signed-in user's menu: profile, users, appearance, shortcuts, the paper reset and sign-out. */
export function AccountMenu({
  user,
  isAdmin,
  theme,
  onToggleTheme,
  density,
  onToggleDensity,
  onShowKeys,
  onResetPaper,
  onSignOut,
}: {
  user: AccountUser
  isAdmin: boolean
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  density: 'comfortable' | 'compact'
  onToggleDensity: () => void
  onShowKeys: () => void
  /** only passed when the user may trade on a paper account */
  onResetPaper?: () => void
  onSignOut: () => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        root.current?.querySelector<HTMLButtonElement>('.account-trigger')?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const name = user.displayName || user.username
  const close = () => setOpen(false)
  const run = (fn: () => void) => () => {
    close()
    fn()
  }
  return (
    <div className="account-menu" ref={root}>
      <button
        type="button"
        className="account-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={`${user.username} · ${user.roleLabel}`}
      >
        <span className="account-avatar" aria-hidden>
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="account-name-text hide-narrow">{name}</span>
        <IconChevronDown size={14} />
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Account">
          <div className="menu-head">
            <span className="account-avatar account-avatar-lg" aria-hidden>
              {name.slice(0, 1).toUpperCase()}
            </span>
            <span className="menu-head-text">
              <b>{name}</b>
              <span className="muted small">{user.roleLabel}</span>
            </span>
          </div>
          <div className="menu-sep" role="separator" />
          {ACCOUNT_PAGES.filter((p) => !p.adminOnly || isAdmin).map((p) => (
            <NavLink key={p.to} to={p.to} role="menuitem" className="menu-item" onClick={close}>
              {p.label}
              <span className="menu-hint">{p.blurb}</span>
            </NavLink>
          ))}
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" className="menu-item" onClick={run(onToggleTheme)}>
            {theme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />}{' '}
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
            <kbd className="menu-kbd">t</kbd>
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={run(onToggleDensity)}>
            <IconRows size={15} /> {density === 'compact' ? 'Comfortable density' : 'Compact density'}
            <kbd className="menu-kbd">d</kbd>
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={run(onShowKeys)}>
            <IconKeyboard size={15} /> Keyboard shortcuts<kbd className="menu-kbd">?</kbd>
          </button>
          {onResetPaper && (
            <>
              <div className="menu-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="menu-item menu-item-danger"
                onClick={run(onResetPaper)}
              >
                Reset paper account…
              </button>
            </>
          )}
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" className="menu-item" onClick={run(onSignOut)}>
            <IconLogOut size={15} /> Sign out
          </button>
        </div>
      )}
    </div>
  )
}
