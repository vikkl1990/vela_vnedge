import { useEffect, useRef } from 'react'

/** Keyboard shortcut → description, shown in the "?" help dialog. */
export interface Hotkey {
  keys: string
  label: string
  run: () => void
}

const CHORD_MS = 900

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * Tiny hotkeys helper. Supports single keys ("?") and two-key chords ("g o").
 * Ignored while typing in inputs, when a dialog is open, or with modifiers held.
 */
export function useHotkeys(list: Hotkey[]) {
  const ref = useRef(list)
  useEffect(() => {
    ref.current = list
  })
  useEffect(() => {
    let pending: { key: string; at: number } | null = null
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      if (document.querySelector('dialog[open]')) return
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      const now = Date.now()
      if (pending && now - pending.at > CHORD_MS) pending = null
      const chord = pending ? `${pending.key} ${key}` : null
      const hit = ref.current.find((h) => h.keys === chord) ?? (!pending ? ref.current.find((h) => h.keys === key) : undefined)
      if (hit) {
        e.preventDefault()
        pending = null
        hit.run()
        return
      }
      const isPrefix = ref.current.some((h) => h.keys.startsWith(`${key} `))
      pending = isPrefix ? { key, at: now } : null
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
