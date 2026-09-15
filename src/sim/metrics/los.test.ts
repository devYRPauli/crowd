import { describe, expect, it } from 'vitest'
import {
  losFor,
  weidmannFlow,
  weidmannSpeed,
  crowdSafetyLevel,
  QUEUE_LOS,
  WALKWAY_LOS,
} from './los'

describe('Fruin level of service', () => {
  it('uses the published walkway breakpoints', () => {
    expect(losFor(0.2, 'walkway').level).toBe('A')
    expect(losFor(0.35, 'walkway').level).toBe('B')
    expect(losFor(0.6, 'walkway').level).toBe('C')
    expect(losFor(0.9, 'walkway').level).toBe('D')
    expect(losFor(1.5, 'walkway').level).toBe('E')
    expect(losFor(3.0, 'walkway').level).toBe('F')
  })

  it('is more forgiving in a queue than on a walkway', () => {
    expect(losFor(1.0, 'queue').level).toBe('B')
    expect(losFor(1.0, 'walkway').level).toBe('D')
  })

  it('derives densities from the published area modules', () => {
    expect(WALKWAY_LOS[0].maxDensity).toBeCloseTo(1 / 3.24, 6)
    expect(QUEUE_LOS[0].maxDensity).toBeCloseTo(1 / 1.21, 6)
  })

  it('flags crowd-safety thresholds independently of level of service', () => {
    expect(crowdSafetyLevel(3.5)).toBe('safe')
    expect(crowdSafetyLevel(4.2)).toBe('warn')
    expect(crowdSafetyLevel(5.4)).toBe('critical')
  })
})

describe('Weidmann speed-density relation', () => {
  // Reference values from v(p) = 1.34 * (1 - exp(-1.913 * (1/p - 1/5.4))).
  const cases: Array<[number, number]> = [
    [0.5, 1.298],
    [1.0, 1.058],
    [1.5, 0.807],
    [2.0, 0.606],
    [3.0, 0.331],
    [4.0, 0.156],
    [5.0, 0.037],
  ]

  it.each(cases)('matches the published curve at %f persons/m2', (density, expected) => {
    expect(weidmannSpeed(density)).toBeCloseTo(expected, 2)
  })

  it('peaks in specific flow near 1.22 persons per metre per second', () => {
    let peak = 0
    let peakDensity = 0
    for (let d = 0.05; d < 5.4; d += 0.001) {
      const flow = weidmannFlow(d)
      if (flow > peak) {
        peak = flow
        peakDensity = d
      }
    }
    expect(peak).toBeGreaterThan(1.15)
    expect(peak).toBeLessThan(1.35)
    expect(peakDensity).toBeGreaterThan(1.5)
    expect(peakDensity).toBeLessThan(2.1)
  })

  it('reaches a standstill at the jam density', () => {
    expect(weidmannSpeed(5.4)).toBe(0)
    expect(weidmannSpeed(6)).toBe(0)
  })
})
