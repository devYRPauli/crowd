/**
 * Small UI primitives.
 *
 * Numeric fields deserve special mention: they accept a typed expression in
 * either unit system ("3.4", "340cm", "11'2\"") and only commit on blur or
 * Enter, so a half-typed value never reaches the document and never lands in
 * the undo history. Escape throws the draft away through a flag rather than
 * by clearing it: the blur it ends in runs the commit from the render that
 * still holds the draft, and clearing it first committed what Escape was
 * meant to discard.
 */

import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { formatLength, parseLength } from '../../core/model/units'
import type { UnitSystem } from '../../core/model/types'
import { CloseIcon } from './icons'

/**
 * A labelled control. The label names the control it wraps, which a span
 * beside it did not: a screen reader announced every box in the inspector as
 * an unnamed text field.
 */
export const Field = ({
  label,
  children,
  hint,
}: {
  label: string
  children: ReactElement<{ id?: string }>
  hint?: string
}) => {
  const id = useId()
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {cloneElement(children, { id })}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  )
}

/**
 * A figure as people write one: "1,200" pasted from a spreadsheet, or "600 s"
 * with the unit printed beside the box. Anything else is refused. Stripping
 * everything but digits read "1,5" as fifteen, "2 hours" as two minutes and
 * "1e3" as thirteen.
 */
const readFigure = (text: string, unit: string | undefined): number | null => {
  const match = /^\s*([+-]?[\d.,]+(?:e[+-]?\d+)?)\s*(.*?)\s*$/i.exec(text)
  if (!match) return null
  const [, figure, written] = match
  if (written !== '' && written.toLowerCase() !== unit?.toLowerCase()) return null
  if (figure.includes(',') && !/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(figure)) return null
  const parsed = Number(figure.replaceAll(',', ''))
  return Number.isFinite(parsed) ? parsed : null
}

export const NumberInput = ({
  value,
  onCommit,
  min,
  max,
  step = 1,
  suffix,
  disabled,
  id,
}: {
  value: number
  onCommit: (value: number) => void
  min?: number
  max?: number
  step?: number
  suffix?: string
  disabled?: boolean
  id?: string
}) => {
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const cancelled = useRef(false)
  const display = draft ?? (Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '')

  const commit = () => {
    const discard = cancelled.current
    cancelled.current = false
    if (draft === null) return
    setDraft(null)
    if (discard) return
    // An emptied box is not a request for zero, and `Number('')` is 0: selecting
    // the headcount, hitting Delete and clicking away used to set the crowd to
    // nobody and run an empty venue. The field springs back to what the
    // document holds.
    if (draft.trim() === '') return
    const parsed = readFigure(draft, suffix)
    if (parsed === null) {
      setInvalid(true)
      setTimeout(() => setInvalid(false), 900)
      return
    }
    let next = parsed
    if (min !== undefined) next = Math.max(min, next)
    if (max !== undefined) next = Math.min(max, next)
    if (next !== value) onCommit(next)
  }

  return (
    <div style={{ position: 'relative' }}>
      <input
        id={id}
        className={`input is-mono${invalid ? ' is-invalid' : ''}`}
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
            cancelled.current = true
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
  id,
}: {
  value: number
  units: UnitSystem
  onCommit: (metres: number) => void
  min?: number
  max?: number
  disabled?: boolean
  id?: string
}) => {
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const cancelled = useRef(false)

  const commit = () => {
    const discard = cancelled.current
    cancelled.current = false
    if (draft === null) return
    setDraft(null)
    if (discard) return
    const parsed = parseLength(draft, units)
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
      id={id}
      className={`input is-mono${invalid ? ' is-invalid' : ''}`}
      type="text"
      disabled={disabled}
      value={draft ?? formatLength(value, units)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          cancelled.current = true
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
  id,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  disabled?: boolean
  id?: string
}) => (
  <select
    id={id}
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
  onRelease,
  label,
  format,
  disabled,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  /**
   * The drag or key press is over. A slider reports every tick, so an edit it
   * makes is one undo step only if it coalesces while it runs and is sealed
   * here.
   */
  onRelease?: () => void
  label: string
  format?: (value: number) => string
  disabled?: boolean
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
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerUp={onRelease}
        onKeyUp={onRelease}
        onBlur={onRelease}
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
  // The focus effect runs once, for as long as the dialog is open, and reads
  // the latest close through a ref. It depended on `onClose`, which the shell
  // makes afresh every render, so an autosave behind an open dialog moved focus
  // off the control somebody was on and back to the dialog frame.
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close.current()
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
  }, [])

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
