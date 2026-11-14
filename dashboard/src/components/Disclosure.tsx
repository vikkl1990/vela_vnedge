import { useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'

/** Secondary research loads only when opened; a bookmarked section opens directly. */
export function Disclosure({ id, title, hint, children }: { id: string; title: string; hint: string; children: ReactNode }) {
  const { hash } = useLocation()
  const [expanded, setExpanded] = useState<{ hash: string; open: boolean } | null>(null)
  const open = expanded?.hash === hash ? expanded.open : hash === `#${id}`
  return <section className="disclosure panel" id={id}>
    <button className="disclosure-toggle" aria-expanded={open} aria-controls={`${id}-content`} onClick={() => setExpanded({ hash, open: !open })}>
      <span><strong>{title}</strong><span className="muted small">{hint}</span></span><span aria-hidden>{open ? '−' : '+'}</span>
    </button>
    {open && <div id={`${id}-content`} className="disclosure-content">{children}</div>}
  </section>
}
