/**
 * Fruin level of service.
 *
 * Three tables, not one. Fruin published separate thresholds for walkways,
 * stairways and queueing areas, and they differ by a factor of two or more at
 * the same density: 1.5 persons/m² is a comfortable queue and a failing
 * walkway. Colouring a waiting area with the walkway legend makes every plan
 * look like a disaster, so the classifier is chosen by what the surface is for.
 *
 * Thresholds are given here as the pedestrian area module in m² per person —
 * the form Fruin published — and converted to densities once, so the numbers in
 * the source can be checked against the source.
 *
 * Separate from level of service, a crowd-safety overlay flags 4 persons/m² and
 * above regardless of facility type. That is operational practice for standing
 * crowds and it has to fire whichever table is in play.
 */

export type FacilityType = 'walkway' | 'stair' | 'queue'

export interface LosBand {
  level: 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
  /** Lower bound of the area module for this band, in m² per person. */
  minModule: number
  /** Upper bound of density for this band, in persons per m². */
  maxDensity: number
  color: string
  description: string
}

const band = (
  level: LosBand['level'],
  minModule: number,
  color: string,
  description: string,
): LosBand => ({
  level,
  minModule,
  maxDensity: minModule > 0 ? 1 / minModule : Infinity,
  color,
  description,
})

export const LOS_COLORS: Record<LosBand['level'], string> = {
  A: '#1a9850',
  B: '#91cf60',
  C: '#d9ef8b',
  D: '#fee08b',
  E: '#fc8d59',
  F: '#d73027',
}

/** Fruin walkway level of service; the default for open floor. */
export const WALKWAY_LOS: LosBand[] = [
  band('A', 3.24, LOS_COLORS.A, 'Free flow — people choose their own speed'),
  band('B', 2.32, LOS_COLORS.B, 'Minor conflicts — occasional adjustment'),
  band('C', 1.39, LOS_COLORS.C, 'Restricted — passing requires effort'),
  band('D', 0.93, LOS_COLORS.D, 'Speed restricted — reverse flow is difficult'),
  band('E', 0.46, LOS_COLORS.E, 'Shuffling — at capacity'),
  band('F', 0, LOS_COLORS.F, 'Breakdown — involuntary contact'),
]

export const STAIR_LOS: LosBand[] = [
  band('A', 1.85, LOS_COLORS.A, 'Free flow on stairs'),
  band('B', 1.58, LOS_COLORS.B, 'Minor conflicts'),
  band('C', 1.11, LOS_COLORS.C, 'Restricted'),
  band('D', 0.74, LOS_COLORS.D, 'Speed restricted'),
  band('E', 0.46, LOS_COLORS.E, 'At capacity'),
  band('F', 0, LOS_COLORS.F, 'Breakdown'),
]

/** Fruin queueing level of service; applied inside waiting areas. */
export const QUEUE_LOS: LosBand[] = [
  band('A', 1.21, LOS_COLORS.A, 'Free circulation through the queue'),
  band('B', 0.93, LOS_COLORS.B, 'Partially restricted'),
  band('C', 0.65, LOS_COLORS.C, 'Restricted — movement disturbs others'),
  band('D', 0.28, LOS_COLORS.D, 'Standing without touching is not possible'),
  band('E', 0.19, LOS_COLORS.E, 'Contact unavoidable — short waits only'),
  band('F', 0, LOS_COLORS.F, 'Fluid crowd — shock waves, crush risk'),
]

export const LOS_TABLES: Record<FacilityType, LosBand[]> = {
  walkway: WALKWAY_LOS,
  stair: STAIR_LOS,
  queue: QUEUE_LOS,
}

export const losFor = (density: number, facility: FacilityType = 'walkway'): LosBand => {
  const table = LOS_TABLES[facility]
  for (const entry of table) {
    if (density <= entry.maxDensity) return entry
  }
  return table[table.length - 1]
}

export const losIndex = (density: number, facility: FacilityType = 'walkway'): number => {
  const table = LOS_TABLES[facility]
  for (let i = 0; i < table.length; i++) {
    if (density <= table[i].maxDensity) return i
  }
  return table.length - 1
}

/** Crowd-safety thresholds for standing crowds, independent of level of service. */
export const CROWD_SAFETY = {
  /** Density at which stewarding intervention is normally planned. */
  warnDensity: 4.0,
  /** Density at which a standing crowd is treated as a crush risk. */
  criticalDensity: 5.0,
  warnColor: '#e879a2',
  criticalColor: '#c2185b',
} as const

export const crowdSafetyLevel = (density: number): 'safe' | 'warn' | 'critical' =>
  density >= CROWD_SAFETY.criticalDensity
    ? 'critical'
    : density >= CROWD_SAFETY.warnDensity
      ? 'warn'
      : 'safe'

/**
 * Weidmann's speed–density relation, the standard calibration curve for
 * pedestrian movement:
 *
 *   v(ρ) = v₀ · (1 − exp(−γ · (1/ρ − 1/ρ_max)))
 *
 * with γ = 1.913 and a jam density ρ_max of 5.4 persons/m². We use it as the
 * multiplier on a person's free-flow speed, so a crowd slows the way a real one
 * does rather than only through collision avoidance. The fundamental-diagram
 * test checks the emergent behaviour against this curve.
 */
export const WEIDMANN = {
  freeSpeed: 1.34,
  gamma: 1.913,
  jamDensity: 5.4,
}

export const weidmannSpeed = (density: number, freeSpeed = WEIDMANN.freeSpeed): number => {
  if (density <= 1e-6) return freeSpeed
  if (density >= WEIDMANN.jamDensity) return 0
  return freeSpeed * (1 - Math.exp(-WEIDMANN.gamma * (1 / density - 1 / WEIDMANN.jamDensity)))
}

/** Weidmann speed as a fraction of free-flow speed, clamped to a usable range. */
export const weidmannFactor = (density: number): number => {
  const factor = weidmannSpeed(density, 1)
  // Even a jammed crowd shuffles. Flooring the factor keeps a dense scene from
  // freezing into a deadlock that no amount of simulated time resolves.
  return Math.min(1, Math.max(0.12, factor))
}

/** Specific flow in persons per metre per second. */
export const weidmannFlow = (density: number): number => density * weidmannSpeed(density)
