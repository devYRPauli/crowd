/**
 * Code compliance calculator.
 *
 * Deliberately *not* a simulation. These are the hand calculations a planner
 * would otherwise do on paper — occupant load, required egress width, exit
 * count, the SFPE hydraulic flow check — computed from the plan geometry and
 * shown beside the simulated result. Where the two disagree, that difference is
 * the interesting part.
 *
 * Every figure is model-code indicative. Local adoption and amendments vary and
 * approval rests with the authority having jurisdiction; the UI says so, and so
 * does this comment, because it matters.
 */

import type { Plan } from '../model/types'
import { isWalkableOpening } from '../model/planGeometry'
import { detectRooms } from '../model/rooms'

const SQFT_PER_SQM = 10.7639
const MM_PER_INCH = 25.4

/**
 * Occupant load factors from IBC Table 1004.5, in square feet per person.
 * `net` factors exclude circulation and fixtures; `gross` include them.
 */
export const OCCUPANT_LOAD_FACTORS = [
  { id: 'assembly-standing', label: 'Assembly, standing', sqft: 5, basis: 'net' as const },
  { id: 'assembly-chairs', label: 'Assembly, chairs only', sqft: 7, basis: 'net' as const },
  { id: 'assembly-tables', label: 'Assembly, tables and chairs', sqft: 15, basis: 'net' as const },
  { id: 'exhibit', label: 'Exhibit gallery or museum', sqft: 30, basis: 'net' as const },
  { id: 'business', label: 'Business areas', sqft: 150, basis: 'gross' as const },
  { id: 'mercantile', label: 'Mercantile', sqft: 60, basis: 'gross' as const },
  { id: 'kitchen', label: 'Kitchen, commercial', sqft: 200, basis: 'gross' as const },
]

export type OccupancyId = (typeof OCCUPANT_LOAD_FACTORS)[number]['id']

export interface ComplianceInput {
  plan: Plan
  occupancy: OccupancyId
  /** Whether the building is sprinklered with an emergency voice alarm. */
  sprinklered: boolean
  /** Actual number of people the scenario puts in the venue. */
  plannedAttendance: number
  /** Target evacuation time for the UK capacity calculation, in minutes. */
  targetEgressMinutes: number
}

export interface ComplianceResult {
  floorAreaSqm: number
  floorAreaSqft: number
  occupancyLabel: string
  occupantLoadFactor: number
  calculatedOccupantLoad: number
  /** The load the calculations use: the greater of code and planned attendance. */
  designOccupantLoad: number
  exitsRequired: number
  exitsProvided: number
  totalExitWidthM: number
  /** Egress width the occupant load requires, in metres. */
  requiredWidthM: number
  /** Which rule binds: the multiplication, or the minimum door width. */
  bindingRule: 'calculated' | 'minimum'
  /** Effective width after the SFPE boundary layer, in metres. */
  effectiveWidthM: number
  /** SFPE hydraulic flow capacity, in persons per second. */
  hydraulicFlow: number
  hydraulicEgressSeconds: number
  /** UK Green/Purple Guide capacity for the target evacuation time. */
  greenGuideCapacity: number
  issues: ComplianceIssue[]
}

export interface ComplianceIssue {
  severity: 'fail' | 'warn' | 'info'
  message: string
}

/** Specific flow at a restriction, persons per metre per second (SFPE). */
export const SPECIFIC_FLOW = 1.3
/** Boundary layer subtracted from each side of an opening, in metres (SFPE). */
export const BOUNDARY_LAYER = 0.15
/** Green Guide level-route flow rate, persons per metre per minute. */
export const GREEN_GUIDE_RATE = 82
/** Minimum clear door width under IBC, in metres (32 in). */
export const MIN_DOOR_WIDTH_M = (32 * MM_PER_INCH) / 1000

const exitCountRequired = (occupants: number): number => {
  if (occupants <= 49) return 1
  if (occupants <= 500) return 2
  if (occupants <= 1000) return 3
  return 4
}

export const computeCompliance = ({
  plan,
  occupancy,
  sprinklered,
  plannedAttendance,
  targetEgressMinutes,
}: ComplianceInput): ComplianceResult => {
  const factor =
    OCCUPANT_LOAD_FACTORS.find((entry) => entry.id === occupancy) ?? OCCUPANT_LOAD_FACTORS[0]
  const rooms = detectRooms(plan.walls)
  const floorAreaSqm = rooms.reduce((sum, room) => sum + room.area, 0)
  const floorAreaSqft = floorAreaSqm * SQFT_PER_SQM
  const calculatedOccupantLoad = Math.ceil(floorAreaSqft / factor.sqft)
  const designOccupantLoad = Math.max(calculatedOccupantLoad, Math.round(plannedAttendance))

  // Exits: openings at floor level that reach the outside are counted through
  // the exit zones the user drew, because only they say where "out" is.
  const exitZones = plan.zones.filter((zone) => zone.kind === 'exit')
  const doorWidths = plan.openings.filter(isWalkableOpening).map((opening) => opening.width)
  const exitsProvided = Math.max(exitZones.length, 0)
  const totalExitWidthM = doorWidths.reduce((sum, width) => sum + width, 0)

  const widthPerOccupantInches = sprinklered ? 0.15 : 0.2
  const calculatedWidthM = (designOccupantLoad * widthPerOccupantInches * MM_PER_INCH) / 1000
  const minimumWidthM = MIN_DOOR_WIDTH_M * Math.max(1, exitCountRequired(designOccupantLoad))
  const requiredWidthM = Math.max(calculatedWidthM, minimumWidthM)
  const bindingRule = calculatedWidthM >= minimumWidthM ? 'calculated' : 'minimum'

  // SFPE: a 1.0 m door has only 0.7 m of effective width. Omitting the boundary
  // layer overstates capacity by about 30%, and it is the step most often left
  // out of a hand calculation.
  const effectiveWidthM = doorWidths.reduce(
    (sum, width) => sum + Math.max(0, width - BOUNDARY_LAYER * 2),
    0,
  )
  const hydraulicFlow = effectiveWidthM * SPECIFIC_FLOW
  const hydraulicEgressSeconds = hydraulicFlow > 0 ? designOccupantLoad / hydraulicFlow : Infinity

  const greenGuideCapacity = Math.floor(totalExitWidthM * GREEN_GUIDE_RATE * targetEgressMinutes)

  const issues: ComplianceIssue[] = []

  if (floorAreaSqm <= 0) {
    issues.push({
      severity: 'info',
      message:
        'No enclosed rooms were found, so there is no floor area to calculate from. Close the walls to get an occupant load.',
    })
  }

  const requiredExits = exitCountRequired(designOccupantLoad)
  if (exitsProvided < requiredExits) {
    issues.push({
      severity: 'fail',
      message: `${requiredExits} exits are required for ${designOccupantLoad} occupants; ${exitsProvided} ${exitsProvided === 1 ? 'is' : 'are'} marked on the plan.`,
    })
  }

  if (Math.abs(designOccupantLoad - 50) <= 5) {
    issues.push({
      severity: 'warn',
      message: `At ${designOccupantLoad} occupants you are on the 50-person threshold. One more person requires a second exit and a wider corridor — this is a step change, not a gradient.`,
    })
  }

  if (totalExitWidthM < requiredWidthM) {
    issues.push({
      severity: 'fail',
      message: `Egress width is ${totalExitWidthM.toFixed(2)} m against ${requiredWidthM.toFixed(2)} m required (${bindingRule === 'minimum' ? 'the minimum door width binds here, not the per-occupant calculation' : 'from the per-occupant calculation'}).`,
    })
  }

  for (const width of doorWidths) {
    if (width < MIN_DOOR_WIDTH_M) {
      issues.push({
        severity: 'fail',
        message: `A doorway is ${(width * 1000).toFixed(0)} mm wide, below the ${(MIN_DOOR_WIDTH_M * 1000).toFixed(0)} mm clear minimum.`,
      })
      break
    }
  }

  if (plannedAttendance > calculatedOccupantLoad && calculatedOccupantLoad > 0) {
    issues.push({
      severity: 'warn',
      message: `The scenario puts ${plannedAttendance} people in a space whose code occupant load is ${calculatedOccupantLoad}. The calculation below uses the larger figure.`,
    })
  }

  if (plannedAttendance > greenGuideCapacity && greenGuideCapacity > 0) {
    issues.push({
      severity: 'warn',
      message: `Green Guide capacity for a ${targetEgressMinutes}-minute evacuation is ${greenGuideCapacity}; the scenario has ${plannedAttendance}.`,
    })
  }

  issues.push({
    severity: 'info',
    message:
      'The 82 persons per metre per minute rate is an emergency maximum, not a comfortable circulation rate. Design level routes below it.',
  })

  return {
    floorAreaSqm,
    floorAreaSqft,
    occupancyLabel: factor.label,
    occupantLoadFactor: factor.sqft,
    calculatedOccupantLoad,
    designOccupantLoad,
    exitsRequired: requiredExits,
    exitsProvided,
    totalExitWidthM,
    requiredWidthM,
    bindingRule,
    effectiveWidthM,
    hydraulicFlow,
    hydraulicEgressSeconds,
    greenGuideCapacity,
    issues,
  }
}
