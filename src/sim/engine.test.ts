import { describe, expect, it } from 'vitest'
import { Simulation } from './engine'
import { AGENT_FIELD, AGENT_STRIDE } from './types'
import type { Plan, Scenario, Wall, Zone } from '../core/model/types'
import { createScenario, createPopulation } from '../core/model/defaults'
import { PlanBuilder } from '../library/planBuilder'

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

  it('clears a crowd through a single exit and reports it', () => {
    const entry = zone('entry', 2, 0.4, 30, 1.6)
    const exit = zone('exit', 38.6, 0.5, 39.6, 1.5)
    const scenario = scenarioFor(entry.id, 120, 1.34)
    const sim = new Simulation(corridorPlan(entry, exit), { ...scenario, durationS: 1200 })
    // A shove in the crush at the exit once carried somebody through the
    // corridor wall, and outside it nothing leads back to the way out.
    let outside = 0
    for (let step = 0; !sim.isFinished && step < 12000; step++) {
      sim.step(0.1)
      const { agents, count } = sim.snapshot()
      for (let i = 0; i < count; i++) {
        const y = agents[i * AGENT_STRIDE + AGENT_FIELD.y]
        if (y < 0 || y > 2) outside++
      }
    }
    const summary = sim.summary()

    expect(outside).toBe(0)
    expect(summary.completed).toBe(120)
    expect(summary.clearanceTime).toBeGreaterThan(0)
    // Arrivals block when the doorway is full, so they are not all inside at once.
    expect(summary.peakOccupancy).toBeGreaterThan(50)
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

  it('keeps serving when the queue outgrows the line drawn for it', () => {
    // A bar at the head of a lane beside the tables, as in the banquet hall.
    // Places laid on the line's straight continuation sent people head-on into
    // the queue they were joining, and people standing in the line who had not
    // reached their place were kept out of it. The counter stopped with half
    // the crowd still waiting.
    const b = new PlanBuilder()
    const room = b.room(0, 0, 10, 14)
    b.door(room.south, 4, 1.83, 'door', 'both')
    for (const x of [3.5, 6.5])
      for (const y of [3, 6.5, 10]) b.tableWithChairs('table-round-8', x, y)
    const bar = b.service(
      'Bar',
      1.6,
      13.4,
      Math.PI,
      2,
      { kind: 'constant', mean: 20 },
      {
        width: 2.4,
        depth: 0.7,
        queue: [
          { x: 0.9, y: 12.4 },
          { x: 0.9, y: 9.4 },
        ],
      },
    )
    const entry = b.zone('entry', 3, 0.3, 6, 1.5, 'In')
    const scenario: Scenario = {
      ...createScenario(),
      durationS: 1500,
      populations: [
        {
          ...createPopulation(0),
          count: 60,
          entryIds: [entry.id],
          arrival: { kind: 'all-at-once', startS: 0, windowS: 0 },
          itinerary: [
            { id: 'step-bar', kind: 'service', targetId: bar.id },
            { id: 'step-exit', kind: 'exit' },
          ],
        },
      ],
    }
    const summary = runToCompletion(new Simulation(b.build(), scenario), 1500)

    expect(summary.services[0].served).toBe(60)
    expect(summary.completed).toBe(60)
    // Two servers at 20 s each cannot clear sixty in under 600 s; a queue that
    // keeps them busy finishes not long after.
    expect(summary.clearanceTime).toBeLessThan(900)
  }, 60_000)
})
