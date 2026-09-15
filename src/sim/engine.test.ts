import { describe, expect, it } from 'vitest'
import { Simulation } from './engine'
import type { Plan, Scenario, Wall, Zone } from '../core/model/types'
import { createScenario, createPopulation } from '../core/model/defaults'

let counter = 0
const wall = (ax: number, ay: number, bx: number, by: number): Wall => ({
  id: `w${counter++}`,
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  thickness: 0.15,
  height: 3,
  kind: 'wall',
})

const zone = (kind: Zone['kind'], x0: number, y0: number, x1: number, y1: number): Zone => ({
  id: `${kind}${counter++}`,
  kind,
  name: kind,
  polygon: [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ],
})

/** A straight 2 m × 40 m corridor, as used by RiMEA test case 1. */
const corridorPlan = (entry: Zone, exit: Zone): Plan => ({
  walls: [wall(0, 0, 40, 0), wall(0, 2, 40, 2), wall(0, 0, 0, 2), wall(40, 0, 40, 2)],
  openings: [],
  furniture: [],
  zones: [entry, exit],
  servicePoints: [],
})

const scenarioFor = (entryId: string, count: number, speed: number): Scenario => {
  const base = createScenario()
  const population = createPopulation(0)
  return {
    ...base,
    durationS: 300,
    profiles: [
      {
        id: 'fixed',
        name: 'Fixed speed',
        radius: 0.23,
        speed: { mean: speed, sd: 0, min: speed, max: speed },
        caution: 1,
        assertiveness: 0.5,
        color: '#4c7dd4',
        heightScale: 1,
        mobility: 'walking',
      },
    ],
    populations: [
      {
        ...population,
        count,
        entryIds: [entryId],
        arrival: { kind: 'all-at-once', startS: 0, windowS: 0 },
        profileMix: [{ profileId: 'fixed', weight: 1 }],
        itinerary: [{ id: 'step-exit', kind: 'exit' }],
      },
    ],
  }
}

const runToCompletion = (sim: Simulation, maxSeconds: number) => {
  const dt = 0.1
  let steps = 0
  while (!sim.isFinished && steps * dt < maxSeconds) {
    sim.step(dt)
    steps++
  }
  return sim.summary()
}

describe('Simulation', () => {
  it('walks one person down a corridor at their free speed (RiMEA TC1)', () => {
    const entry = zone('entry', 0.4, 0.5, 1.4, 1.5)
    const exit = zone('exit', 38.6, 0.5, 39.6, 1.5)
    const sim = new Simulation(corridorPlan(entry, exit), scenarioFor(entry.id, 1, 1.0))
    const summary = runToCompletion(sim, 200)

    expect(summary.completed).toBe(1)
    // The corridor is ~38 m between zone centres; at 1 m/s that is ~38 s.
    // RiMEA allows 40 s ± 1 s over the full 40 m, so allow a modest margin for
    // the start and stop inside the zones.
    expect(summary.meanJourney).toBeGreaterThan(34)
    expect(summary.meanJourney).toBeLessThan(45)
  })

  it('never lets anyone end up inside a wall', () => {
    const entry = zone('entry', 0.4, 0.5, 1.4, 1.5)
    const exit = zone('exit', 38.6, 0.5, 39.6, 1.5)
    const sim = new Simulation(corridorPlan(entry, exit), scenarioFor(entry.id, 40, 1.2))
    let worstOverlap = 0
    for (let step = 0; step < 1500 && !sim.isFinished; step++) {
      sim.step(0.1)
      const snapshot = sim.snapshot()
      for (let i = 0; i < snapshot.count; i++) {
        const y = snapshot.agents[i * 10 + 1]
        // Wall faces sit at y = 0.075 and y = 1.925.
        worstOverlap = Math.max(worstOverlap, 0.075 - y, y - 1.925)
      }
    }
    expect(worstOverlap).toBeLessThan(0.24)
  })

  it('clears a crowd through a single exit and reports it (RiMEA TC11)', () => {
    const entry = zone('entry', 2, 0.4, 30, 1.6)
    const exit = zone('exit', 38.6, 0.5, 39.6, 1.5)
    const sim = new Simulation(corridorPlan(entry, exit), scenarioFor(entry.id, 120, 1.34))
    const summary = runToCompletion(sim, 600)

    expect(summary.completed).toBe(120)
    expect(summary.clearanceTime).toBeGreaterThan(0)
    expect(summary.peakOccupancy).toBe(120)
  })

  it('produces identical results for the same seed', () => {
    const entry = zone('entry', 2, 0.4, 10, 1.6)
    const exit = zone('exit', 38.6, 0.5, 39.6, 1.5)
    const plan = corridorPlan(entry, exit)
    const runOnce = () => {
      const sim = new Simulation(plan, scenarioFor(entry.id, 30, 1.34))
      for (let i = 0; i < 400; i++) sim.step(0.1)
      return Array.from(sim.snapshot().agents)
    }
    expect(runOnce()).toEqual(runOnce())
  })

  it('serves a queue and records the wait', () => {
    const entry = zone('entry', 2, 0.4, 8, 1.6)
    const exit = zone('exit', 38.6, 0.5, 39.6, 1.5)
    const plan: Plan = {
      ...corridorPlan(entry, exit),
      servicePoints: [
        {
          id: 'svc1',
          name: 'Desk',
          position: { x: 30, y: 1.9 },
          rotation: 0,
          width: 1.2,
          depth: 0.4,
          servers: 1,
          serviceTime: { kind: 'constant', mean: 2 },
          queue: [
            { x: 30, y: 1.0 },
            { x: 24, y: 1.0 },
          ],
          queueSpacing: 0.6,
        },
      ],
    }
    const base = scenarioFor(entry.id, 12, 1.34)
    const scenario: Scenario = {
      ...base,
      populations: [
        {
          ...base.populations[0],
          itinerary: [
            { id: 'step-svc', kind: 'service', targetId: 'svc1' },
            { id: 'step-exit', kind: 'exit' },
          ],
        },
      ],
    }
    const sim = new Simulation(plan, scenario)
    const summary = runToCompletion(sim, 900)

    expect(summary.services).toHaveLength(1)
    expect(summary.services[0].served).toBe(12)
    // Twelve people, one server, two seconds each: the last waits about 22 s.
    expect(summary.services[0].maxWait).toBeGreaterThan(10)
    expect(summary.completed).toBe(12)
  })
})
