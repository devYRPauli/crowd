/**
 * Not brushing against strangers.
 *
 * A body radius says where somebody *is*. It says nothing about whether they
 * will let a stranger's shoulder touch theirs, and people will not: they read a
 * gap, judge it too tight, and hold back or go round. Every separation rule in
 * this engine worked on `radiusA + radiusB` before this module — contact, zero
 * margin — so a modelled crowd closed until skin met skin and only stopped
 * there.
 *
 * The margin here is deliberately small, and the reason is the most important
 * thing in this file. Hall's proxemics puts personal distance at 0.46–1.22 m
 * centre to centre, which would be a quarter of a metre of air per person or
 * more — but **the speed law already contains that**. Weidmann's curve is
 * fitted to real crowds, and real crowds keep their distance; that is most of
 * why speed falls with density at all. Model the same behaviour a second time
 * as a geometric buffer and it is counted twice. The fundamental diagram says
 * so plainly: at a quarter of a metre the flow peak moves from 1.81 to 1.41
 * persons/m², well below where any real crowd peaks, because the buffer caps
 * density on its own before Weidmann gets to.
 *
 * So the proxemic distance stays in the speed law, where it is calibrated, and
 * what lives here is only the last few centimetres of it: the margin that keeps
 * a walking crowd from *touching*. Five centimetres a person, a tenth of a
 * metre across a pair.
 *
 * Two things spend even that.
 *
 * **Density**, because in a crush people are pressed together and no margin
 * survives it. Fruin's tables already say where it goes — level A is where
 * people still choose their own spacing, level E is shuffling at capacity — so
 * the margin is whole at the A boundary and gone by the E boundary, straight
 * line between. Reading it off the same table the results are reported against
 * keeps one definition of crowded in the product rather than two that can
 * drift.
 *
 * **Assertiveness**, because people differ, and this is what the field has
 * always claimed to mean. `AgentProfile.assertiveness` is documented as "higher
 * values accept tighter gaps", is defaulted across all seven shipped profiles,
 * is clamped on load and copied onto every agent at spawn — and was read by
 * nothing whatsoever until now. Somebody in a hurry takes the gap; somebody
 * with luggage or in a wheelchair wants more room than their footprint.
 *
 * What this is *not* is a second collision radius. Contact is still contact:
 * `resolveContacts` and `relaxOverlaps` work on the physical radius and are
 * untouched by any of this, so bodies never overlap however assertive anybody
 * is. This only decides how early somebody starts avoiding.
 */

import { WALKWAY_LOS } from '../metrics/los'

/**
 * Metres of clearance a wholly unassertive person keeps beyond their own body
 * with the floor to themselves. Counted once per person, so two relaxed adults
 * come no closer than about 0.56 m centre to centre, against 0.46 m at contact.
 *
 * Calibrated on the fundamental diagram, which is the reference this model is
 * fitted to and is sensitive to exactly this. At five centimetres agreement
 * with Weidmann is 0.044 m/s RMSE and the flow peak sits at 1.72 persons/m²,
 * both where they were without any margin at all. At ten it is 0.056 and 1.23,
 * and at twenty-five 0.067 and 1.41 — and the band for that peak is 1.5–2.1, so
 * anything larger caps density on its own before the speed law gets to it and
 * the curve turns over in the wrong place.
 */
export const PERSONAL_SPACE = 0.05

/** Fruin walkway A: people still choose their own spacing. 0.31 persons/m². */
const ROOMY = WALKWAY_LOS[0].maxDensity
/** Fruin walkway E: at capacity, shuffling, personal space gone. 2.17 persons/m². */
const SHOULDER_TO_SHOULDER = WALKWAY_LOS[4].maxDensity

/**
 * How much personal space somebody still has, at this density and with this
 * much willingness to accept a tight gap.
 *
 * `assertiveness` runs 0–1 across the shipped profiles: 0.85 for somebody in a
 * hurry, 0.25 for a wheelchair user.
 */
export const personalSpace = (density: number, assertiveness: number): number => {
  if (density >= SHOULDER_TO_SHOULDER) return 0
  const room =
    density <= ROOMY ? 1 : (SHOULDER_TO_SHOULDER - density) / (SHOULDER_TO_SHOULDER - ROOMY)
  const willingness = Math.min(1, Math.max(0, assertiveness))
  return PERSONAL_SPACE * room * (1 - willingness)
}
