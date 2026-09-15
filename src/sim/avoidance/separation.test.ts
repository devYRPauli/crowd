import { describe, expect, it } from 'vitest'
import { SEPARATION, SEPARATION_PASS_CAP, separationScale } from './separation'

describe('separation budget', () => {
  it('spends the whole step budget across the passes and no more', () => {
    expect(SEPARATION_PASS_CAP * SEPARATION.iterations).toBeCloseTo(
      SEPARATION.maxCorrectionPerStep,
      12,
    )
  })

  it('leaves a displacement inside the budget alone', () => {
    const scale = separationScale(SEPARATION_PASS_CAP * 0.5, 0)
    expect(scale).toBe(1)
  })

  it('clamps a displacement over the budget to exactly the budget', () => {
    const dx = SEPARATION_PASS_CAP * 30
    const dy = SEPARATION_PASS_CAP * 40
    const scale = separationScale(dx, dy)
    expect(Math.hypot(dx * scale, dy * scale)).toBeCloseTo(SEPARATION_PASS_CAP, 12)
  })

  it('keeps the direction it was given', () => {
    const dx = 3
    const dy = -4
    const scale = separationScale(dx, dy)
    expect((dx * scale) / (dy * scale)).toBeCloseTo(dx / dy, 12)
  })

  it('returns zero for a body with nothing to resolve, rather than dividing by it', () => {
    expect(separationScale(0, 0)).toBe(0)
  })
})
