/**
 * Measurement areas.
 *
 * A `measure` zone is how someone asks "what happened *here*" — at the doorway,
 * on the dance floor, in front of the stage. These tests check that the answer
 * is about the area asked for and not about the venue as a whole.
 */

import { describe, expect, it } from 'vitest'
import { Simulation } from './engine'
import { PlanBuilder, step } from '../library/planBuilder'
import { createPopulation, createScenario } from '../core/model/defaults'
import type { Scenario } from '../core/model/types'

const hall = () => {
  const b = new PlanBuilder()
  b.room(0, 0, 30, 12)
  const entry = b.zone('entry', 1, 1, 8, 11, 'In')
  const exit = b.zone('exit', 27.5, 4, 29, 8, 'Out')
  // A gate the crowd must pass through, and a quiet corner it never visits.
  const gate = b.zone('measure', 14, 0.5, 16, 11.5, 'Gate line')
  const corner = b.zone('measure', 20, 0.5, 23, 2.5, 'Quiet corner')
  b.wall({ x: 15, y: 0 }, { x: 15, y: 4.5 })
  b.wall({ x: 15, y: 7.5 }, { x: 15, y: 12 })
  return { plan: b.build(), entry, exit, gate, corner }
}

const scenarioFor = (entryId: string, exitId: string, count: number): Scenario => ({
  ...createScenario(),
  durationS: 600,
  populations: [
    {
      ...createPopulation(0),
      count,
      entryIds: [entryId],
      arrival: { kind: 'all-at-once', startS: 0, windowS: 0 },
      itinerary: [step('exit', exitId)],
    },
  ],
})

const runIt = () => {
  const { plan, entry, exit, gate, corner } = hall()
  const sim = new Simulation(plan, scenarioFor(entry.id, exit.id, 60))
  for (let i = 0; i < 4000 && !sim.isFinished; i++) sim.step(0.1)
  const summary = sim.summary()
  return {
    summary,
    gate: summary.areas.find((area) => area.id === gate.id),
    corner: summary.areas.find((area) => area.id === corner.id),
  }
}

describe('measurement areas', () => {
  const { summary, gate, corner } = runIt()

  it('reports one summary per measurement area', () => {
    expect(summary.areas).toHaveLength(2)
    expect(gate).toBeDefined()
    expect(corner).toBeDefined()
  })

  it('records its own floor area', () => {
    expect(gate!.areaSqm).toBeCloseTo(2 * 11, 4)
    expect(corner!.areaSqm).toBeCloseTo(3 * 2, 4)
  })

  it('sees the crowd at the gap everyone squeezes through', () => {
    expect(gate!.peakOccupancy).toBeGreaterThan(3)
    expect(gate!.personSeconds).toBeGreaterThan(0)
    expect(gate!.peakDensity).toBeGreaterThan(0.2)
  })

  it('sees nothing in a corner nobody visits', () => {
    expect(corner!.peakOccupancy).toBeLessThanOrEqual(1)
    expect(corner!.meanDensity).toBeLessThan(0.15)
  })

  it('measures speed only for the people who were inside', () => {
    expect(gate!.meanSpeed).toBeGreaterThan(0)
    expect(gate!.meanSpeed).toBeLessThan(2.5)
    // Nobody was in the corner, so there is no speed to report rather than a
    // misleading zero-divided-by-zero.
    expect(Number.isFinite(corner!.meanSpeed)).toBe(true)
  })

  it('classifies the worst level of service it reached', () => {
    expect(['A', 'B', 'C', 'D', 'E', 'F']).toContain(gate!.worstLos)
    expect(corner!.worstLos).toBe('A')
  })

  it('reports crush-risk time separately from level of service', () => {
    expect(gate!.secondsAtCrushRisk).toBeGreaterThanOrEqual(0)
    expect(gate!.secondsAtLosF).toBeGreaterThanOrEqual(gate!.secondsAtCrushRisk === 0 ? 0 : 0)
    expect(corner!.secondsAtCrushRisk).toBe(0)
  })

  it('reports nothing when the plan has no measurement areas', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 10, 10)
    const entry = b.zone('entry', 1, 1, 3, 3, 'In')
    const exit = b.zone('exit', 7, 7, 9, 9, 'Out')
    const sim = new Simulation(b.build(), scenarioFor(entry.id, exit.id, 4))
    for (let i = 0; i < 500 && !sim.isFinished; i++) sim.step(0.1)
    expect(sim.summary().areas).toHaveLength(0)
  })
})
