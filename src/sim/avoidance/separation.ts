/**
 * Body exclusion — the positional pass that keeps a crowd physical.
 *
 * ORCA reasons about velocities, and velocity-level avoidance alone cannot
 * guarantee separation: when its linear program is infeasible the relaxed
 * fallback returns the least-bad velocity, and in a crush the least-bad
 * velocity is still one that closes the gap. Without a positional correction
 * afterwards a jam keeps compressing, and the run reports densities no real
 * crowd reaches — which then feeds back through the speed–density relation and
 * has everyone walking through a pack that could not physically exist.
 *
 * It has a velocity half, applied before anybody moves, so that a pair can
 * close only as fast as the gap between them allows in one step; a correction
 * made after the overlap exists is a step too late.
 *
 * The rules live in their own module because two places implement them:
 * `Simulation.resolveContacts` and `Simulation.relaxOverlaps` for the engine,
 * and the periodic-corridor harness
 * in `validation/fundamentalDiagram.test.ts`, which cannot use the engine
 * because it needs wrap-around geometry the engine has no concept of. If those
 * two drifted, the validation suite would stop measuring the shipped model, so
 * the numbers that define the rule are shared even though the neighbour search
 * either side of them is not.
 */

import { hypot } from '../../core/math/libm'

export const SEPARATION = {
  /**
   * Relaxation passes per step.
   *
   * One pass is enough up to about 3 persons/m² and not above it: pushing A off
   * B moves A into C, so with a single pass the residual overlap grows with
   * density — 16% of a body radius at 3.8 persons/m², 27% at 4.7, which is what
   * let the corridor pack past any density a real crowd reaches. Each pass
   * re-reads the positions the last one produced, so three of them hold the
   * pack at contact instead.
   */
  iterations: 3,

  /**
   * Metres a body may be displaced in one step, summed over the passes.
   *
   * The cap is what makes a deep pile-up ease apart over several ticks rather
   * than explode outwards in one. At the 0.1 s step this is 1.2 m/s, below a
   * walking pace, so the correction never reads on screen as motion of its own.
   */
  maxCorrectionPerStep: 0.12,
} as const

/**
 * Velocity passes per step spent keeping bodies from walking into each other,
 * before anybody moves. Contact comes in chains, since holding A off B changes
 * B, which was also being held off C; two passes are most of the benefit, and
 * the positional passes after integration take what is left.
 */
export const CONTACT_PASSES = 2

/**
 * How much a pair's closing speed has to come down so that they are, at worst,
 * touching after a step of `dt`. Zero when it need not.
 *
 * `gap` is the distance between their surfaces, negative when they already
 * overlap, and `separating` is their relative speed along the line between
 * them, positive when they are moving apart. A pair may close by the whole gap
 * in one step and no faster. Only this component is touched, so a crowd still
 * slides past itself along the tangent.
 */
export function contactCorrection(gap: number, separating: number, dt: number): number {
  const allowed = -gap / dt
  return separating >= allowed ? 0 : allowed - separating
}

/** The share of the step budget one pass may spend. */
export const SEPARATION_PASS_CAP = SEPARATION.maxCorrectionPerStep / SEPARATION.iterations

/**
 * Scale factor that clamps one pass's accumulated displacement to its budget.
 * Zero for a body with nothing to resolve, so callers skip without a special
 * case and without dividing by zero.
 */
export function separationScale(dx: number, dy: number): number {
  const length = hypot(dx, dy)
  if (length === 0) return 0
  return Math.min(length, SEPARATION_PASS_CAP) / length
}
