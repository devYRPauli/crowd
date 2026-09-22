/**
 * Small UI primitives.
 *
 * Numeric fields deserve special mention: they accept a typed expression in
 * either unit system ("3.4", "340cm", "11'2\"") and only commit on blur or
 * Enter, so a half-typed value never reaches the document and never lands in
 * the undo history.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { formatLength, parseLength } from '../../core/model/units'
import type { UnitSystem } from '../../core/model/types'
import { CloseIcon } from './icons'

export const Field = ({
  label,
  children,
  hint,
}: {
  label: string
  children: ReactNode
  hint?: string
}) => (
  <div className="field">
    <span className="field-label">{label}</span>
    {children}
    {hint ? <span className="hint">{hint}</span> : null}
  </div>
)

export const NumberInput = ({
  value,
  onCommit,
  min,
  max,
  step = 1,
  suffix,
  disabled,
}: {
  value: number
  onCommit: (value: number) => void
  min?: number
  max?: number
  step?: number
  suffix?: string
  disabled?: boolean
}) => {
  const [draft, setDraft] = useState<string | null>(null)
  const display = draft ?? (Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '')

  const commit = () => {
    if (draft === null) return
    const cleaned = draft.replace(/[^\d.\-+]/g, '')
    setDraft(null)
    // An emptied box is not a request for zero, and `Number('')` is 0: selecting
    // the headcount, hitting Delete and clicking away used to set the crowd to
    // nobody and run an empty venue. A draft with no number left in it is
    // discarded like any other unreadable one, and the field springs back to
    // what the document holds.
    if (cleaned === '') return
    const parsed = Number(cleaned)
    if (!Number.isFinite(parsed)) return
    let next = parsed
    if (min !== undefined) next = Math.max(min, next)
    if (max !== undefined) next = Math.min(max, next)
    if (next !== value) onCommit(next)
  }

  return (
    <div style={{ position: 'relative' }}>
      <input
        className="input is-mono"
        type="text"
        inputMode="decimal"
        value={display}
        disabled={disabled}
        step={step}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur()
          } else if (event.key === 'Escape') {
            setDraft(null)
            event.currentTarget.blur()
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault()
            const delta = (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? step * 10 : step)
            let next = value + delta
            if (min !== undefined) next = Math.max(min, next)
            if (max !== undefined) next = Math.min(max, next)
            setDraft(null)
            onCommit(Math.round(next * 1000) / 1000)
          }
        }}
      />
      {suffix ? (
        <span
          style={{
            position: 'absolute',
            right: 8,
            top: 0,
            lineHeight: '28px',
            fontSize: 11,
            color: 'var(--text-faint)',
            pointerEvents: 'none',
          }}
        >
          {suffix}
        </span>
      ) : null}
    </div>
  )
}

/** A length field that speaks both unit systems. */
export const LengthInput = ({
  value,
  units,
  onCommit,
  min = 0.01,
  max,
  disabled,
}: {
  value: number
  units: UnitSystem
  onCommit: (metres: number) => void
  min?: number
  max?: number
  disabled?: boolean
}) => {
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)

  const commit = () => {
    if (draft === null) return
    const parsed = parseLength(draft, units)
    setDraft(null)
    if (parsed === null) {
      setInvalid(true)
      setTimeout(() => setInvalid(false), 900)
      return
    }
    const clamped = Math.min(max ?? Infinity, Math.max(min, parsed))
    if (Math.abs(clamped - value) > 1e-6) onCommit(clamped)
  }

  return (
    <input
      className={`input is-mono${invalid ? ' is-invalid' : ''}`}
      type="text"
      disabled={disabled}
      value={draft ?? formatLength(value, units)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          setDraft(null)
          event.currentTarget.blur()
        }
      }}
    />
  )
}

export const Select = <T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  disabled?: boolean
}) => (
  <select
    className="select"
    value={value}
    disabled={disabled}
    onChange={(event) => onChange(event.target.value as T)}
  >
    {options.map((option) => (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    ))}
  </select>
)

export const Checkbox = ({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  disabled?: boolean
}) => (
  <label className="checkbox">
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
    <span>{label}</span>
  </label>
)

export const Slider = ({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  format,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  label: string
  format?: (value: number) => string
}) => {
  const id = useId()
  return (
    <div className="field">
      <label
        className="field-label"
        htmlFor={id}
        style={{ display: 'flex', justifyContent: 'space-between' }}
      >
        <span>{label}</span>
        <span style={{ fontFamily: 'var(--font-mono)', textTransform: 'none', letterSpacing: 0 }}>
          {format ? format(value) : value}
        </span>
      </label>
      <input
        id={id}
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  )
}

export const Segmented = <T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string; title?: string }>
  onChange: (value: T) => void
}) => (
  <div className="segmented" role="group">
    {options.map((option) => (
      <button
        key={option.value}
        type="button"
        title={option.title}
        className={option.value === value ? 'is-active' : ''}
        onClick={() => onChange(option.value)}
      >
        {option.label}
      </button>
    ))}
  </div>
)

export const Modal = ({
  title,
  onClose,
  children,
  footer,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      // Keep Tab inside the dialog. Without this, tabbing walks out into the
      // editor behind it, which a keyboard or screen-reader user cannot see.
      if (event.key !== 'Tab' || !ref.current) return
      const focusable = ref.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || active === ref.current)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    ref.current?.focus()
    return () => {
      window.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [onClose])

  return (
    <div
      className="scrim"
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="modal"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="btn is-ghost is-icon" onClick={onClose} aria-label="Close">
            <CloseIcon width={16} height={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  )
}

export const Stat = ({
  value,
  label,
  delta,
}: {
  value: string
  label: string
  delta?: { text: string; tone: 'better' | 'worse' | 'same' }
}) => (
  <div className="stat">
    <div className="value">{value}</div>
    <div className="label">{label}</div>
    {delta ? <div className={`delta is-${delta.tone}`}>{delta.text}</div> : null}
  </div>
)

/** A compact line chart drawn as an inline SVG path. */
export const Sparkline = ({
  series,
  height = 92,
  color = 'var(--accent)',
  fill = true,
  label,
}: {
  series: Array<{ x: number; y: number }>
  height?: number
  color?: string
  fill?: boolean
  label?: string
}) => {
  const width = 300
  if (series.length < 2) {
    return <div className="hint">{label ? `${label}: not enough data yet.` : 'No data yet.'}</div>
  }
  let minX = Infinity
  let maxX = -Infinity
  let maxY = 0
  for (const point of series) {
    if (point.x < minX) minX = point.x
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }
  if (maxX - minX < 1e-6) maxX = minX + 1
  if (maxY <= 0) maxY = 1
  const px = (x: number) => ((x - minX) / (maxX - minX)) * width
  const py = (y: number) => height - 4 - (y / maxY) * (height - 12)
  const path = series
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`)
    .join(' ')
  const area = `${path} L${width},${height} L0,${height} Z`

  // The peak sits outside the SVG: the plot stretches to fill its box, and text
  // drawn inside it stretched with it, badly so across the wide timeline track.
  return (
    <div className="chart" style={{ height }} role="img" aria-label={label}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        {fill ? <path d={area} fill={color} opacity={0.14} /> : null}
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={1.6}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span className="chart-peak">{maxY >= 100 ? maxY.toFixed(0) : maxY.toFixed(1)}</span>
    </div>
  )
}

/** Runs `callback` after `delay` ms of quiet. */
export const useDebounced = <T,>(value: T, delay: number): T => {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

export const useResizeObserver = (
  ref: React.RefObject<HTMLElement | null>,
  onResize: (rect: DOMRectReadOnly) => void,
) => {
  const callback = useCallback(onResize, [onResize])
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) callback(entry.contentRect)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, callback])
}
