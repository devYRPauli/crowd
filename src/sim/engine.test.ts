import { describe, expect, it } from 'vitest'
import { Simulation } from './engine'
import { AGENT_FIELD, AGENT_STRIDE, agentStateIndex } from './types'
import type { Plan, Scenario, Wall, Zone } from '../core/model/types'
import { createScenario, createPopulation } from '../core/model/defaults'
import { PlanBuilder } from '../library/planBuilder'
import { DEFAULT_DOOR_WIDTH, DEFAULT_DOUBLE_DOOR_WIDTH } from '../core/model/standards'

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

  it('does not let somebody outside the wall take the head of a queue inside it', () => {
    // The banquet buffet's queue runs down the east wall past an exit door.
    // People squeezed out through the door were near enough the line to count
    // as beside it, through the wall, and ranked by how far along it they
    // were: the head of the queue stood outside for thirteen minutes with all
    // three servers idle. In this room it stranded part of the queue on three
    // seeds of four.
    const b = new PlanBuilder()
    const room = b.room(0, 0, 10, 10)
    b.door(room.south, 3, DEFAULT_DOUBLE_DOOR_WIDTH, 'door', 'both')
    b.door(room.east, 4, DEFAULT_DOOR_WIDTH, 'door', 'exit')
    const buffet = b.service(
      'Buffet',
      7.6,
      9.4,
      Math.PI,
      2,
      { kind: 'constant', mean: 30 },
      {
        width: 4.0,
        depth: 0.9,
        queue: [
          { x: 8.8, y: 8.0 },
          { x: 8.8, y: 5.4 },
        ],
      },
    )
    b.place('counter-buffet', 7.6, 9.4, Math.PI, { size: { width: 4.0, depth: 0.8, height: 0.9 } })
    const entry = b.zone('entry', 1.5, 0.3, 4.5, 1.5, 'In')
    const plan = b.build()

    for (let seed = 1; seed <= 4; seed++) {
      const scenario: Scenario = {
        ...createScenario(),
        seed,
        durationS: 1800,
        populations: [
          {
            ...createPopulation(0),
            count: 40,
            entryIds: [entry.id],
            arrival: { kind: 'uniform', startS: 0, windowS: 120 },
            itinerary: [
              { id: 'step-buffet', kind: 'service', targetId: buffet.id },
              { id: 'step-exit', kind: 'exit' },
            ],
          },
        ],
      }
      const summary = runToCompletion(new Simulation(plan, scenario), 1800)
      expect(summary.services[0].served).toBe(40)
      expect(summary.warnings).toEqual([])
    }
  }, 120_000)

  it('brings each guest at a table round to a place of their own', () => {
    // A field to the table led everybody to the place of whoever asked first,
    // and the guests seated across from it found their way round from there
    // through the chairs: the last of eight sat down after 140 to 330 s. In the
    // banquet hall some never did. Over several seeds, because who is last to
    // a table and how long they take turns on the order people arrive in.
    //
    // Guests also sat down 0.4 m short of their chairs, out in the aisle round
    // the table. On one seed in eight that shut a guest walking round to a
    // place further on in against the table until a neighbour got up after
    // their two minutes: the last of the eight sat down at 129 s.
    const b = new PlanBuilder()
    const room = b.room(0, 0, 8, 8)
    b.door(room.south, 4, 1.83, 'door', 'both')
    b.tableWithChairs('table-round-8', 4, 4.5)
    const seating = b.zone('seating', 2, 2.5, 6, 6.5, 'Table')
    const entry = b.zone('entry', 2.5, 0.3, 5.5, 1.5, 'In')
    const plan = b.build()
    const chairs = plan.furniture.filter((f) => f.catalogId === 'chair').map((f) => f.position)
    const seatedState = agentStateIndex('seated')

    const lastSeated: number[] = []
    for (let seed = 1; seed <= 8; seed++) {
      const scenario: Scenario = {
        ...createScenario(),
        seed,
        durationS: 600,
        populations: [
          {
            ...createPopulation(0),
            count: 8,
            entryIds: [entry.id],
            arrival: { kind: 'all-at-once', startS: 0, windowS: 0 },
            itinerary: [
              {
                id: 'step-seat',
                kind: 'seat',
                targetId: seating.id,
                duration: { kind: 'constant', mean: 120 },
              },
              { id: 'step-exit', kind: 'exit' },
            ],
          },
        ],
      }
      const sim = new Simulation(plan, scenario)
      const sat = new Set<number>()
      while (sat.size < 8 && sim.currentTime < 300) {
        sim.step(0.1)
        const { agents, count } = sim.snapshot()
        for (let i = 0; i < count; i++) {
          const base = i * AGENT_STRIDE
          if (agents[base + AGENT_FIELD.state] === seatedState)
            sat.add(agents[base + AGENT_FIELD.id])
        }
      }
      expect(sat.size).toBe(8)
      lastSeated.push(sim.currentTime)
      const { agents, count } = sim.snapshot()
      for (let i = 0; i < count; i++) {
        const base = i * AGENT_STRIDE
        const at = { x: agents[base + AGENT_FIELD.x], y: agents[base + AGENT_FIELD.y] }
        const nearest = Math.min(...chairs.map((c) => Math.hypot(c.x - at.x, c.y - at.y)))
        expect(nearest).toBeLessThan(0.15)
      }
      expect(runToCompletion(sim, 900).warnings).toEqual([])
    }
    expect(Math.max(...lastSeated)).toBeLessThan(30)
  }, 60_000)

  it('seats an audience in its rows, along rows already part full', () => {
    // Sat down 0.4 m short of their seats, an audience sat in the gaps between
    // the rows. Put on the seat itself, they closed the gap for the delegates
    // behind them: the margin people keep from strangers, kept from somebody
    // sitting down, left half a metre between two seated rows too tight to
    // walk along. And whoever sat beside a wheelchair user could never reach
    // the middle of their own seat, and stood a fifth of a metre off it.
    const b = new PlanBuilder()
    const room = b.room(0, 0, 6, 8)
    b.door(room.south, 4.5, DEFAULT_DOUBLE_DOOR_WIDTH, 'door', 'both')
    b.seatingBlock(1.7, 3, 2, 3.3)
    const seating = b.zone('seating', 0, 2.4, 3.4, 4.9, 'Rows')
    const entry = b.zone('entry', 3.8, 0.3, 5.5, 1.3, 'In')
    const plan = b.build()
    const rows = plan.furniture.filter((f) => f.catalogId === 'seat-row').map((f) => f.position.y)
    const seatedState = agentStateIndex('seated')

    for (let seed = 1; seed <= 8; seed++) {
      const scenario: Scenario = {
        ...createScenario(),
        seed,
        durationS: 900,
        populations: [
          {
            ...createPopulation(0),
            count: 8,
            entryIds: [entry.id],
            arrival: { kind: 'uniform', startS: 0, windowS: 60 },
            itinerary: [
              {
                id: 'step-seat',
                kind: 'seat',
                targetId: seating.id,
                duration: { kind: 'constant', mean: 300 },
              },
              { id: 'step-exit', kind: 'exit' },
            ],
          },
        ],
      }
      const sim = new Simulation(plan, scenario)
      const satAt = new Map<number, number>()
      while (satAt.size < 8 && sim.currentTime < 150) {
        sim.step(0.1)
        const { agents, count } = sim.snapshot()
        for (let i = 0; i < count; i++) {
          const base = i * AGENT_STRIDE
          const id = agents[base + AGENT_FIELD.id]
          if (agents[base + AGENT_FIELD.state] !== seatedState || satAt.has(id)) continue
          satAt.set(id, agents[base + AGENT_FIELD.y])
        }
      }
      expect(satAt.size).toBe(8)
      // Half the depth of a row: sitting in it, not in the gap behind it.
      for (const y of satAt.values()) {
        expect(Math.min(...rows.map((row) => Math.abs(row - y)))).toBeLessThan(0.35)
      }
      expect(runToCompletion(sim, 900).warnings).toEqual([])
    }
  }, 60_000)
})
