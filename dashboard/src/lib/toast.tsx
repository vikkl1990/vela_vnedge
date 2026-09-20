import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

export type ToastKind = 'info' | 'success' | 'error' | 'warn'
export interface Toast {
  id: number
  kind: ToastKind
  title: string
  detail?: string
}

interface ToastApi {
  push: (kind: ToastKind, title: string, detail?: string) => void
  success: (title: string, detail?: string) => void
  error: (title: string, detail?: string) => void
  info: (title: string, detail?: string) => void
  warn: (title: string, detail?: string) => void
}

const ToastCtx = createContext<ToastApi | null>(null)

/** Module-level emitter so non-React code (chart provider) can toast too. */
let externalPush: ToastApi['push'] | null = null
export function toastExternal(kind: ToastKind, title: string, detail?: string) {
  externalPush?.(kind, title, detail)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)
  const lastByTitle = useRef(new Map<string, number>())

  const push = useCallback<ToastApi['push']>((kind, title, detail) => {
    // de-dupe identical titles within 2 s (chart errors can fire repeatedly)
    const now = Date.now()
    const last = lastByTitle.current.get(title)
    if (last && now - last < 2000) return
    lastByTitle.current.set(title, now)
    const id = ++seq.current
    setToasts((t) => [...t.slice(-5), { id, kind, title, detail }])
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4000)
  }, [])

  useEffect(() => {
    externalPush = push
    return () => {
      externalPush = null
    }
  }, [push])

  const apiValue = useMemo<ToastApi>(
    () => ({
      push,
      success: (t, d) => push('success', t, d),
      error: (t, d) => push('error', t, d),
      info: (t, d) => push('info', t, d),
      warn: (t, d) => push('warn', t, d),
    }),
    [push],
  )

  return (
    <ToastCtx.Provider value={apiValue}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <div className="toast-title">{t.title}</div>
            {t.detail && <div className="toast-detail">{t.detail}</div>}
            <button
              className="toast-close"
              aria-label="Dismiss"
              onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx)
  if (!ctx) throw new Error('useToast outside ToastProvider')
  return ctx
}
