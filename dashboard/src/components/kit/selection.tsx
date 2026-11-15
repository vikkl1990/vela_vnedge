import { useId, useState, type ReactNode } from 'react'

export function ChipSelect({
  options,
  value,
  onChange,
  label,
  emptyLabel = 'inherit',
  disabled,
  compact,
}: {
  options: string[]
  value: string[]
  onChange: (next: string[]) => void
  label?: string
  emptyLabel?: string
  disabled?: boolean
  compact?: boolean
}) {
  const id = useId()
  const toggle = (o: string) => {
    if (disabled) return
    onChange(value.includes(o) ? value.filter((v) => v !== o) : [...value, o])
  }
  return (
    <div
      className={`chips ${compact ? 'chips-compact' : ''}`}
      role="group"
      aria-labelledby={label ? id : undefined}
    >
      {label && (
        <span id={id} className="chips-label">
          {label}
        </span>
      )}
      {options.map((o) => (
        <button
          key={o}
          type="button"
          className={`chip ${value.includes(o) ? 'chip-on' : ''}`}
          aria-pressed={value.includes(o)}
          onClick={() => toggle(o)}
          disabled={disabled}
        >
          {o}
        </button>
      ))}
      {value.length === 0 && <span className="muted small">{emptyLabel}</span>}
    </div>
  )
}

export function ToggleGroup<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly { value: T; label: ReactNode; ariaLabel?: string }[] | readonly T[]
  value: T
  onChange: (v: T) => void
  ariaLabel?: string
}) {
  const opts = (options as readonly (T | { value: T; label: ReactNode; ariaLabel?: string })[]).map((o) =>
    typeof o === 'string' ? { value: o, label: o, ariaLabel: undefined } : o,
  )
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {opts.map((o) => (
        <button
          key={o.value}

          type="button"
          aria-pressed={o.value === value}
          aria-label={o.ariaLabel}
          title={o.ariaLabel}
          className={`seg ${o.value === value ? 'seg-on' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function SymbolPicker({
  options,
  value,
  onChange,
  placeholder = 'add symbol…',
  disabled,
}: {
  options: string[]
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  disabled?: boolean
}) {
  const id = useId()
  const [text, setText] = useState('')
  const add = (raw: string) => {
    const v = raw.trim().toUpperCase()
    if (!v) return
    if (!value.includes(v)) onChange([...value, v])
    setText('')
  }
  const remove = (v: string) => onChange(value.filter((x) => x !== v))
  const suggestions = options.filter((o) => !value.includes(o)).slice(0, 200)
  return (
    <div className="chips" role="group">
      {value.map((v) => (
        <button
          key={v}
          type="button"
          className="chip chip-on"
          onClick={() => remove(v)}
          disabled={disabled}
          title="Remove"
          aria-label={`Remove ${v}`}
        >
          {v} ×
        </button>
      ))}
      <input
        className="input input-sm mono"
        list={id}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        aria-label="Add symbol"
        onChange={(e) => {
          const v = e.target.value
          // datalist pick fires a change with the full option value
          if (options.includes(v.toUpperCase())) add(v)
          else setText(v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add(text)
          }
        }}
        onBlur={() => text && add(text)}
      />
      <datalist id={id}>
        {suggestions.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      {value.length === 0 && <span className="muted small">none</span>}
    </div>
  )
}
