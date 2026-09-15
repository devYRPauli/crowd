/**
 * Performance shape, not performance speed.
 *
 * Absolute timings depend on the machine, so asserting them makes a flaky test.
 * What can be asserted portably is the *shape* of the cost curve: the per-person
 * cost of a step must stay roughly flat as the crowd grows. A neighbour search
 * that silently becomes O(n²) — the classic way a crowd simulator dies — shows
 * up here immediately and nowhere else.
 */

import { describe, expect, it } from 'vitest'
import { Simulation } from './engine'
import { getTemplate } from '../library/templates'
import { PlanBuilder, step } from '../library/planBuilder'
import { createPopulation, createScenario } from '../core/model/defaults'
import type { Scenario } from '../core/model/types'

const TIME_STEP = 0.1

/**
 * A big empty hall with a spawn area large enough to hold the whole crowd at
 * once. A template would do, but arrivals block when a doorway is full, so the
 * number of people actually inside would be capped by the entrance rather than
 * by the number asked for — and then the two measurements would not differ.
 */
const openHall = (count: number) => {
  const builder = new PlanBuilder()
  const room = builder.room(0, 0, 70, 70)
  builder.door(room.south, 35, 4)
  const entry = builder.zone('entry', 4, 4, 66, 40, 'Spawn area')
  const exit = builder.zone('exit', 30, 0.4, 40, 2.4, 'Way out')
  const base = createScenario()
  const scenario: Scenario = {
    ...base,
    durationS: 100000,
    populations: [
      {
        ...createPopulation(0),
        count,
        entryIds: [entry.id],
        arrival: { kind: 'all-at-once', startS: 0, windowS: 0 },
        itinerary: [step('exit', exit.id)],
      },
    ],
  }
  return { plan: builder.build(), scenario }
}

const measurePerAgentCost = (count: number): { perAgentUs: number; active: number } => {
  const { plan, scenario } = openHall(count)
  const sim = new Simulation(plan, scenario, { maxAgents: count * 2 })

  // Let the crowd spread out and reach a steady state before measuring.
  for (let i = 0; i < 150; i++) sim.step(TIME_STEP)
  const active = sim.stats().active

  const started = performance.now()
  const steps = 120
  for (let i = 0; i < steps; i++) sim.step(TIME_STEP)
  const elapsed = performance.now() - started

  return { perAgentUs: (elapsed / steps / Math.max(1, active)) * 1000, active }
}

describe('simulation performance', () => {
  it('costs roughly the same per person as the crowd grows', () => {
    const small = measurePerAgentCost(150)
    const large = measurePerAgentCost(750)

    // Both runs must actually have a crowd, or the comparison is meaningless.
    expect(small.active).toBeGreaterThan(100)
    expect(large.active).toBeGreaterThan(small.active * 2.5)

    const ratio = large.perAgentUs / small.perAgentUs
    // Quadratic scaling over this range would push the ratio well past 3.
    // Some growth is expected and fine: denser crowds mean more neighbours
    // inside each agent's query radius, which is real work, not a defect.
    expect(ratio).toBeLessThan(3)
  }, 60000)

  it('builds a world for a large venue quickly', () => {
    const doc = getTemplate('concourse')!.build()
    const started = performance.now()
    const sim = new Simulation(doc.plan, doc.scenario)
    const elapsed = performance.now() - started
    expect(sim.world.grid.cols * sim.world.grid.rows).toBeGreaterThan(1000)
    // Generous, but a navigation solve that went quadratic would blow past it.
    expect(elapsed).toBeLessThan(4000)
  }, 30000)
})
