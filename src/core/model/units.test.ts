import { describe, expect, it } from 'vitest'
import {
  feetToMetres,
  formatArea,
  formatClock,
  formatDuration,
  formatLength,
  metresToFeet,
  parseLength,
} from './units'
import { DOOR_HEIGHTS, DOOR_WIDTHS, WALL_HEIGHTS, WINDOW_WIDTHS } from './standards'

describe('formatLength', () => {
  it('shows centimetres below a metre', () => {
    expect(formatLength(0.45, 'metric')).toBe('45 cm')
  })
  it('shows metres above a metre', () => {
    expect(formatLength(3.456, 'metric')).toBe('3.46 m')
  })
  it('shows feet and inches', () => {
    expect(formatLength(1, 'imperial')).toBe('3\' 3.4"')
  })
})

describe('parseLength', () => {
  it('reads bare numbers in the document unit', () => {
    expect(parseLength('3.4', 'metric')).toBeCloseTo(3.4, 6)
    expect(parseLength('10', 'imperial')).toBeCloseTo(3.048, 4)
  })
  it('reads explicit units regardless of the document unit', () => {
    expect(parseLength('340cm', 'imperial')).toBeCloseTo(3.4, 6)
    expect(parseLength('12 in', 'metric')).toBeCloseTo(0.3048, 4)
  })
  it('reads feet and inches', () => {
    expect(parseLength(`6'6"`, 'metric')).toBeCloseTo(1.9812, 4)
  })
  it('rejects nonsense', () => {
    expect(parseLength('wide', 'metric')).toBeNull()
    expect(parseLength('', 'metric')).toBeNull()
  })
})

describe('time formatting', () => {
  it('formats a clock', () => {
    expect(formatClock(75)).toBe('1:15')
    expect(formatClock(3725)).toBe('1:02:05')
  })
  it('formats durations in words', () => {
    expect(formatDuration(45)).toBe('45 s')
    expect(formatDuration(120)).toBe('2 min')
    expect(formatDuration(3900)).toBe('1 h 05 min')
  })
})

describe('formatArea', () => {
  it('switches unit with the document', () => {
    expect(formatArea(24, 'metric')).toBe('24 m²')
    expect(formatArea(10, 'imperial')).toBe('108 ft²')
    expect(formatArea(2, 'imperial')).toBe('21.5 ft²')
  })
})

describe('imperial lengths a supplier would recognise', () => {
  it('never writes a length as the foot below plus twelve inches', () => {
    // A 3'0" door displayed as 2' 12.0", and so did the 5'0" and 8'0" pairs and
    // the 8, 9 and 10 foot wall heights. The formatter took the feet first and
    // rounded the inches afterwards, so a length a hair under a whole foot —
    // which every one of these is, because the metric value is rounded to the
    // millimetre — rolled the inches up to twelve without carrying the foot.
    // Carrying real stock sizes is most of the point of this product, and no
    // supplier writes a door that way.
    for (const table of [DOOR_WIDTHS, DOOR_HEIGHTS, WINDOW_WIDTHS, WALL_HEIGHTS]) {
      for (const size of table) {
        expect(formatLength(size.metres, 'imperial')).not.toMatch(/\b12(\.\d+)?"/)
      }
    }
  })

  it('renders every stock size as the name it is sold under', () => {
    // The `imperial` label is what a supplier calls it; the formatter should
    // agree, once both are written the same way.
    const plain = (text: string) => text.replace(/\s+/g, '').replace(/pair$/, '')
    for (const size of [...DOOR_WIDTHS, ...DOOR_HEIGHTS, ...WALL_HEIGHTS]) {
      expect(plain(formatLength(size.metres, 'imperial'))).toBe(plain(size.imperial))
    }
  })

  it('converts by the definition of an inch, not an approximation of it', () => {
    // An inch is 25.4 mm exactly, so a whole number of feet round-trips.
    expect(feetToMetres(3)).toBeCloseTo(0.9144, 12)
    expect(metresToFeet(0.9144)).toBeCloseTo(3, 12)
    expect(formatLength(feetToMetres(3), 'imperial')).toBe('3\' 0"')
  })
})
