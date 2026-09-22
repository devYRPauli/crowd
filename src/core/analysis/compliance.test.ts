import { describe, expect, it } from 'vitest'
import { computeCompliance, BOUNDARY_LAYER, MIN_DOOR_WIDTH_M, SPECIFIC_FLOW } from './compliance'
import { PlanBuilder } from '../../library/planBuilder'

const hall = (width: number, depth: number, doorWidths: number[]) => {
  const b = new PlanBuilder()
  const room = b.room(0, 0, width, depth)
  doorWidths.forEach((doorWidth, index) => {
    b.door(room.south, 2 + index * 4, doorWidth)
  })
  b.zone('exit', 1.5, 0, 3.5, 1.2, 'Exit')
  return b.build()
}

describe('compliance calculator', () => {
  it('computes occupant load from floor area and the IBC factor', () => {
    // 10 x 10 m = 100 m2 = 1076.4 sqft; at 15 sqft/person that is 72 people.
    const result = computeCompliance({
      plan: hall(10, 10, [1.8]),
      occupancy: 'assembly-tables',
      sprinklered: false,
      plannedAttendance: 0,
      targetEgressMinutes: 8,
    })
    expect(result.floorAreaSqm).toBeCloseTo(100, 0)
    expect(result.calculatedOccupantLoad).toBe(72)
  })

  it('subtracts the SFPE boundary layer from every opening', () => {
    const result = computeCompliance({
      plan: hall(10, 10, [1.0]),
      occupancy: 'assembly-standing',
      sprinklered: false,
      plannedAttendance: 100,
      targetEgressMinutes: 8,
    })
    // A 1.0 m door has 0.7 m of effective width — a 30% difference.
    expect(result.effectiveWidthM).toBeCloseTo(1.0 - BOUNDARY_LAYER * 2, 6)
    expect(result.hydraulicFlow).toBeCloseTo(0.7 * SPECIFIC_FLOW, 6)
  })

  it('says which rule binds, because the calculation only takes over above 220 occupants', () => {
    const small = computeCompliance({
      plan: hall(6, 6, [1.0]),
      occupancy: 'business',
      sprinklered: false,
      plannedAttendance: 10,
      targetEgressMinutes: 8,
    })
    expect(small.bindingRule).toBe('minimum')

    const large = computeCompliance({
      plan: hall(40, 40, [2.0, 2.0]),
      occupancy: 'assembly-standing',
      sprinklered: false,
      plannedAttendance: 2000,
      targetEgressMinutes: 8,
    })
    expect(large.bindingRule).toBe('calculated')
  })

  it('applies the exit-count steps and flags the 50-person cliff', () => {
    const result = computeCompliance({
      plan: hall(8, 8, [1.0]),
      occupancy: 'assembly-standing',
      sprinklered: false,
      plannedAttendance: 48,
      targetEgressMinutes: 8,
    })
    expect(result.exitsRequired).toBeGreaterThanOrEqual(2)
    const cliff = computeCompliance({
      plan: hall(4, 4, [1.0]),
      occupancy: 'business',
      sprinklered: false,
      plannedAttendance: 52,
      targetEgressMinutes: 8,
    })
    expect(cliff.issues.some((issue) => issue.message.includes('50-person threshold'))).toBe(true)
  })

  it('counts doors marked as a way out, as the engine does', () => {
    const b = new PlanBuilder()
    const room = b.room(0, 0, 10, 10)
    b.door(room.south, 2, 1.83, 'door', 'both')
    b.door(room.north, 2, 1.83, 'door', 'exit')
    b.door(room.east, 2, 1.83, 'door', 'entry')
    b.door(room.west, 2, 1.83)
    const result = computeCompliance({
      plan: b.build(),
      occupancy: 'assembly-standing',
      sprinklered: false,
      plannedAttendance: 100,
      targetEgressMinutes: 8,
    })
    expect(result.exitsProvided).toBe(2)
    expect(result.issues.some((issue) => issue.message.includes('marked on the plan'))).toBe(false)
  })

  it('counts an exit zone drawn over a marked door once', () => {
    const b = new PlanBuilder()
    const room = b.room(0, 0, 10, 10)
    b.door(room.south, 2.5, 1.0, 'door', 'exit')
    b.zone('exit', 1.5, 0, 3.5, 1.2, 'Exit')
    const result = computeCompliance({
      plan: b.build(),
      occupancy: 'assembly-standing',
      sprinklered: false,
      plannedAttendance: 20,
      targetEgressMinutes: 8,
    })
    expect(result.exitsProvided).toBe(1)
  })

  it('flags a door below the clear minimum', () => {
    const result = computeCompliance({
      plan: hall(10, 10, [0.7]),
      occupancy: 'assembly-standing',
      sprinklered: false,
      plannedAttendance: 20,
      targetEgressMinutes: 8,
    })
    expect(0.7).toBeLessThan(MIN_DOOR_WIDTH_M)
    expect(result.issues.some((issue) => issue.message.includes('clear minimum'))).toBe(true)
  })

  it('uses the reduced width allowance when the building is sprinklered', () => {
    const base = {
      plan: hall(40, 40, [2.0, 2.0]),
      occupancy: 'assembly-standing' as const,
      plannedAttendance: 1500,
      targetEgressMinutes: 8,
    }
    const plain = computeCompliance({ ...base, sprinklered: false })
    const sprinklered = computeCompliance({ ...base, sprinklered: true })
    expect(sprinklered.requiredWidthM).toBeLessThan(plain.requiredWidthM)
    expect(sprinklered.requiredWidthM / plain.requiredWidthM).toBeCloseTo(0.75, 2)
  })
})
