import { describe, expect, it } from 'vitest'
import { PERSONAL_SPACE, personalSpace } from './proxemics'
import { WALKWAY_LOS } from '../metrics/los'

const ROOMY = WALKWAY_LOS[0].maxDensity
const SHOULDER_TO_SHOULDER = WALKWAY_LOS[4].maxDensity

describe('personal space', () => {
  it('gives an unassertive person the whole margin on an empty floor', () => {
    expect(personalSpace(0, 0)).toBeCloseTo(PERSONAL_SPACE, 12)
  })

  it('gives somebody who takes any gap none of it', () => {
    expect(personalSpace(0, 1)).toBe(0)
  })

  it('leaves nothing at all in a crush, whoever you are', () => {
    for (const assertiveness of [0, 0.25, 0.5, 0.85, 1]) {
      expect(personalSpace(SHOULDER_TO_SHOULDER, assertiveness)).toBe(0)
      expect(personalSpace(SHOULDER_TO_SHOULDER + 5, assertiveness)).toBe(0)
    }
  })

  it('spends it steadily between the two Fruin bands it is pinned to', () => {
    const half = (ROOMY + SHOULDER_TO_SHOULDER) / 2
    expect(personalSpace(half, 0)).toBeCloseTo(PERSONAL_SPACE / 2, 6)
  })

  it('never increases as a crowd thickens', () => {
    let previous = Infinity
    for (let density = 0; density <= 6; density += 0.05) {
      const space = personalSpace(density, 0.5)
      expect(space).toBeLessThanOrEqual(previous + 1e-12)
      previous = space
    }
  })

  /** An out-of-range profile must not hand somebody a negative body radius. */
  it('clamps assertiveness rather than trusting it', () => {
    expect(personalSpace(0, 5)).toBe(0)
    expect(personalSpace(0, -5)).toBeCloseTo(PERSONAL_SPACE, 12)
  })
})
