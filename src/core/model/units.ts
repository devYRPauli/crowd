/**
 * Unit formatting.
 *
 * The document is always metric; the imperial setting only changes how numbers
 * are displayed and parsed. Keeping the model in one unit removes a whole class
 * of rounding bugs, and lets a plan drawn in feet be opened in metres.
 */

import type { UnitSystem } from './types'

const FEET_PER_METRE = 3.280839895
const INCHES_PER_METRE = 39.37007874

export const metresToFeet = (m: number): number => m * FEET_PER_METRE

export const feetToMetres = (ft: number): number => ft / FEET_PER_METRE

/** e.g. `3.40 m` or `11' 2"`. */
export const formatLength = (metres: number, units: UnitSystem, precision = 2): string => {
  if (units === 'imperial') {
    const totalInches = metres * INCHES_PER_METRE
    const feet = Math.floor(totalInches / 12)
    const inches = totalInches - feet * 12
    if (feet === 0) return `${inches.toFixed(1)}"`
    return `${feet}' ${inches.toFixed(inches % 1 === 0 ? 0 : 1)}"`
  }
  if (Math.abs(metres) < 1) return `${(metres * 100).toFixed(0)} cm`
  return `${metres.toFixed(precision)} m`
}

export const formatArea = (squareMetres: number, units: UnitSystem): string => {
  if (units === 'imperial') {
    const squareFeet = squareMetres * FEET_PER_METRE * FEET_PER_METRE
    return `${squareFeet.toFixed(squareFeet < 100 ? 1 : 0)} ft²`
  }
  return `${squareMetres.toFixed(squareMetres < 10 ? 1 : 0)} m²`
}

export const formatDensity = (perSquareMetre: number, units: UnitSystem): string =>
  units === 'imperial'
    ? `${(perSquareMetre / (FEET_PER_METRE * FEET_PER_METRE)).toFixed(3)} /ft²`
    : `${perSquareMetre.toFixed(2)} /m²`

export const formatSpeed = (metresPerSecond: number, units: UnitSystem): string =>
  units === 'imperial'
    ? `${metresToFeet(metresPerSecond).toFixed(2)} ft/s`
    : `${metresPerSecond.toFixed(2)} m/s`

/** `1:23` for under an hour, `1:02:03` beyond. */
export const formatClock = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

/** `4 min 20 s`, `45 s`, `1 h 05 min`. */
export const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds)) return '—'
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return `${total} s`
  if (total < 3600) {
    const m = Math.floor(total / 60)
    const s = total % 60
    return s === 0 ? `${m} min` : `${m} min ${s} s`
  }
  const h = Math.floor(total / 3600)
  const m = Math.round((total % 3600) / 60)
  return `${h} h ${String(m).padStart(2, '0')} min`
}

/**
 * Parse a user-typed length. Accepts `3.4`, `3.4m`, `340cm`, `11'2"`, `11ft`,
 * and bare numbers in the document's unit. Returns metres, or null.
 */
export const parseLength = (text: string, units: UnitSystem): number | null => {
  const trimmed = text.trim().toLowerCase().replace(/\s+/g, '')
  if (!trimmed) return null

  const feetInches = trimmed.match(/^(-?[\d.]+)'(?:([\d.]+)")?$/)
  if (feetInches) {
    const feet = Number(feetInches[1])
    const inches = feetInches[2] ? Number(feetInches[2]) : 0
    if (!Number.isFinite(feet) || !Number.isFinite(inches)) return null
    return feetToMetres(feet + inches / 12)
  }

  const withUnit = trimmed.match(/^(-?[\d.]+)(mm|cm|m|ft|in|")?$/)
  if (!withUnit) return null
  const value = Number(withUnit[1])
  if (!Number.isFinite(value)) return null
  switch (withUnit[2]) {
    case 'mm':
      return value / 1000
    case 'cm':
      return value / 100
    case 'm':
      return value
    case 'ft':
      return feetToMetres(value)
    case 'in':
    case '"':
      return value / INCHES_PER_METRE
    default:
      return units === 'imperial' ? feetToMetres(value) : value
  }
}

export const formatNumber = (value: number, digits = 1): string => {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1000) return value.toFixed(0)
  return value.toFixed(digits)
}

export const formatPercent = (fraction: number, digits = 0): string =>
  `${(fraction * 100).toFixed(digits)}%`
