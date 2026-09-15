import { describe, expect, it } from 'vitest'
import { formatArea, formatClock, formatDuration, formatLength, parseLength } from './units'

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
