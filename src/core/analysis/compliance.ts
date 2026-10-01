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

import type { Plan, UnitSystem } from '../model/types'
import { isWalkableOpening, openingThreshold } from '../model/planGeometry'
import { polygonsOverlap } from '../math/geometry'
import { detectRooms } from '../model/rooms'
import { CODE_MINIMUMS, nominal } from '../model/standards'

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
  /** How the messages write a width; the figures stay in metres. */
  units: UnitSystem
}

/** The part of a code check the planner chooses rather than draws. */
export type CodeCheckSettings = Pick<
  ComplianceInput,
  'occupancy' | 'sprinklered' | 'targetEgressMinutes'
>

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

/**
 * Minimum clear door width under IBC, in metres: the 32 in the code states,
 * not the 813 mm it is stored as. Held to 813 mm, a door typed as 32" failed as
 * "813 mm wide, below the 813 mm clear minimum", and three exits' minimum
 * failed a 96" door by the 0.6 mm three roundings added.
 */
export const MIN_DOOR_WIDTH_M = nominal(CODE_MINIMUMS.egressDoorClearWidth)

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
  units,
}: ComplianceInput): ComplianceResult => {
  const factor =
    OCCUPANT_LOAD_FACTORS.find((entry) => entry.id === occupancy) ?? OCCUPANT_LOAD_FACTORS[0]
  const rooms = detectRooms(plan.walls)
  const floorAreaSqm = rooms.reduce((sum, room) => sum + room.area, 0)
  const floorAreaSqft = floorAreaSqm * SQFT_PER_SQM
  const calculatedOccupantLoad = Math.ceil(floorAreaSqft / factor.sqft)
  const designOccupantLoad = Math.max(calculatedOccupantLoad, Math.round(plannedAttendance))

  // Exits are what the engine sends people to: exit zones, and walkable doors
  // marked as a way out. Counting zones alone reported every template, whose
  // exits are all marked doors, as having none. A door onto an exit zone is one
  // exit with it, and a zone no door opens onto is one by itself. Counted once
  // per zone, one zone drawn along a frontage merged every door in it into one
  // exit and failed a hall with two on exit count.
  const exitZones = plan.zones.filter((zone) => zone.kind === 'exit')
  const wallsById = new Map(plan.walls.map((wall) => [wall.id, wall]))
  const doors = plan.openings.filter(isWalkableOpening).flatMap((opening) => {
    const wall = wallsById.get(opening.wallId)
    if (!wall) return []
    // An exit area is drawn from the outer face, often over one side of a
    // doorway rather than across its middle. Tested at the threshold's centre,
    // on the wall's centre line, the door everybody left by added no width,
    // and so did a pair whose zone covered one leaf. Any overlap counts.
    const threshold = openingThreshold(wall, opening)
    const marked = opening.use === 'exit' || opening.use === 'both'
    const zones = exitZones.filter((zone) => polygonsOverlap(threshold, zone.polygon))
    return [{ width: opening.width, marked, inExitZone: zones.length > 0, zones }]
  })
  const doorWidths = doors.map((door) => door.width)
  // Exit width is the width of the ways out. Summing every doorway counted the
  // doors between rooms and the ways in, and passed a hall on width it did not
  // have.
  const exitDoors = doors.filter((d) => d.marked || d.inExitZone)
  const exitWidths = exitDoors.map((d) => d.width)
  const reached = new Set(doors.flatMap((door) => door.zones))
  const exitsProvided = exitDoors.length + exitZones.filter((zone) => !reached.has(zone)).length
  const totalExitWidthM = exitWidths.reduce((sum, width) => sum + width, 0)

  const widthPerOccupantInches = sprinklered ? 0.15 : 0.2
  const calculatedWidthM = (designOccupantLoad * widthPerOccupantInches * MM_PER_INCH) / 1000
  const minimumWidthM = MIN_DOOR_WIDTH_M * Math.max(1, exitCountRequired(designOccupantLoad))
  const requiredWidthM = Math.max(calculatedWidthM, minimumWidthM)
  const bindingRule = calculatedWidthM >= minimumWidthM ? 'calculated' : 'minimum'

  // SFPE: a 1.0 m door has only 0.7 m of effective width. Omitting the boundary
  // layer overstates capacity by about 30%, and it is the step most often left
  // out of a hand calculation.
  const effectiveWidthM = exitWidths.reduce(
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

  // Either side of 50. It told a venue of 52, which already needed a second
  // exit, that one more person would require one.
  if (Math.abs(designOccupantLoad - 50) <= 5) {
    issues.push({
      severity: 'warn',
      message:
        designOccupantLoad < 50
          ? `At ${designOccupantLoad} occupants you are ${50 - designOccupantLoad} short of the 50-person threshold, where a second exit and a wider corridor become required. This is a step change, not a gradient.`
          : `At ${designOccupantLoad} occupants you have reached the 50-person threshold, so a second exit and a wider corridor are required; ${designOccupantLoad - 49} fewer and one exit would do. This is a step change, not a gradient.`,
    })
  }

  // A width that fails is quoted finely enough to tell it from what it misses:
  // to a hundredth of an inch or a tenth of a millimetre, and finer when those
  // read the same. At formatLength's tenth of an inch an 812 mm door failed as
  // 2' 8" wide, below the 2' 8" clear minimum, and a typed 31.996" one, at a
  // hundredth, as 32.00" below 32.00".
  const quote = (widthM: number, requiredM: number): [string, string] => {
    const perMetre = units === 'imperial' ? 1000 / MM_PER_INCH : 1000
    const unit = units === 'imperial' ? '"' : ' mm'
    for (let places = units === 'imperial' ? 2 : 1; ; places++) {
      const [width, required] = [widthM, requiredM].map((m) => (m * perMetre).toFixed(places))
      if (width !== required || places === 6) return [width + unit, required + unit]
    }
  }

  // Each door counts as the size it is called, and is compared to the
  // micrometre: three 32" minimums add up to 2.4383999999999997 m, and a 96"
  // door is 2.4384.
  const short = (widthM: number, requiredM: number) =>
    Math.round(widthM * 1e6) < Math.round(requiredM * 1e6)
  const calledExitWidthM = exitWidths.reduce((sum, width) => sum + nominal(width), 0)
  if (short(calledExitWidthM, requiredWidthM)) {
    const [drawn, required] = quote(calledExitWidthM, requiredWidthM)
    issues.push({
      severity: 'fail',
      message: `Egress width is ${drawn} against ${required} required (${bindingRule === 'minimum' ? 'the minimum door width binds here, not the per-occupant calculation' : 'from the per-occupant calculation'}).`,
    })
  }

  for (const width of doorWidths) {
    if (short(nominal(width), MIN_DOOR_WIDTH_M)) {
      const [drawn, minimum] = quote(nominal(width), MIN_DOOR_WIDTH_M)
      issues.push({
        severity: 'fail',
        message: `A doorway is ${drawn} wide, below the ${minimum} clear minimum.`,
      })
      break
    }
  }

  if (plannedAttendance > calculatedOccupantLoad && calculatedOccupantLoad > 0) {
    issues.push({
      severity: 'warn',
      message: `The scenario puts ${plannedAttendance} people in a space whose code occupant load is ${calculatedOccupantLoad}. The code check uses the larger figure.`,
    })
  }

  if (plannedAttendance > greenGuideCapacity && greenGuideCapacity > 0) {
    issues.push({
      severity: 'warn',
      message: `Green Guide capacity for evacuation in ${targetEgressMinutes} min is ${greenGuideCapacity}; the scenario has ${plannedAttendance}.`,
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
