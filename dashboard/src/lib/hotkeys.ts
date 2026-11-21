import { useEffect, useRef } from 'react'

/** Keyboard shortcut → description, shown in the "?" help dialog. */
export interface Hotkey {
  keys: string
  label: string
  run: () => void
}

const CHORD_MS = 900

/**
 * Whether a single key was pressed straight after the first key of a chord ("g" of "g k"). Another component's single-key
 * shortcut (j and k in the journal) must stand down then, or `g k` would open Gates and step a list at the same time.
 */
export function followsChordPrefix(
  prev: { key: string; at: number } | null,
  now: number,
  isPrefix: (key: string) => boolean,
): boolean {
  return prev !== null && now - prev.at <= CHORD_MS && isPrefix(prev.key)
}

// Every mounted list, and the key pressed before the current one, shared so separate hooks can see each other's chords.
const lists = new Set<{ current: Hotkey[] }>()
let lastKey: { key: string; at: number } | null = null
let keyBefore: { key: string; at: number } | null = null
let tracking = false
const anyPrefix = (key: string) => [...lists].some((l) => l.current.some((h) => h.keys.startsWith(`${key} `)))
/** Registered before any hook's own listener, so each of them reads the previous key, not the current one. */
function trackKeys() {
  if (tracking) return
  tracking = true
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    keyBefore = lastKey
    lastKey = { key: e.key.length === 1 ? e.key.toLowerCase() : e.key, at: Date.now() }
  })
}

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
    trackKeys()
    lists.add(ref)
    let pending: { key: string; at: number } | null = null
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      if (document.querySelector('dialog[open]')) return
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      const now = Date.now()
      if (pending && now - pending.at > CHORD_MS) pending = null
      const chord = pending ? `${pending.key} ${key}` : null
      // a single key stands down right after any hook's chord prefix, so "g k" never also steps a list
      const single = !pending && !followsChordPrefix(keyBefore, now, anyPrefix)
      const hit =
        ref.current.find((h) => h.keys === chord) ??
        (single ? ref.current.find((h) => h.keys === key) : undefined)
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
    return () => {
      window.removeEventListener('keydown', onKey)
      lists.delete(ref)
    }
  }, [])
}
