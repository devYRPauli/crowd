/**
 * The plans nobody means to draw.
 *
 * A planning tool is used by people who are still thinking, so it is handed
 * half-finished and contradictory input constantly: a room with no way out, a
 * counter with no queue, a population of nobody. None of that should throw, hang
 * or report a number that is quietly wrong — and where the plan cannot answer
 * the question, the run should say so rather than inventing an answer.
 */

import { describe, expect, it } from 'vitest'
import { Simulation } from './engine'
import { PlanBuilder, step } from '../library/planBuilder'
import { createPopulation, createScenario } from '../core/model/defaults'
import { parseDocument, parseDocumentJson } from '../core/document/serialize'
import type { Plan, Scenario } from '../core/model/types'
import { detectRooms } from '../core/model/rooms'

const scenarioWith = (overrides: Partial<Scenario> = {}): Scenario => ({
  ...createScenario(),
  durationS: 120,
  ...overrides,
})

const run = (plan: Plan, scenario: Scenario, steps = 400) => {
  const sim = new Simulation(plan, scenario)
  for (let i = 0; i < steps && !sim.isFinished; i++) sim.step(0.1)
  return sim
}

describe('plans that do not make sense', () => {
  it('survives a completely empty plan', () => {
    const plan: Plan = { walls: [], openings: [], furniture: [], zones: [], servicePoints: [] }
    const sim = run(plan, scenarioWith())
    const summary = sim.summary()
    expect(summary.warnings.join(' ')).toMatch(/entry/i)
    expect(Number.isFinite(summary.meanJourney)).toBe(true)
  })

  it('reports a venue with no exit instead of stranding people silently', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 12, 10)
    const entry = b.zone('entry', 1, 1, 4, 4, 'In')
    const sim = run(
      b.build(),
      scenarioWith({
        populations: [
          { ...createPopulation(0), count: 8, entryIds: [entry.id], itinerary: [step('exit')] },
        ],
      }),
    )
    expect(sim.summary().warnings.join(' ')).toMatch(/exit/i)
  })

  it('handles an exit walled off from the entry', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 20, 10)
    // A solid partition with no door: the exit is unreachable.
    b.wall({ x: 10, y: 0 }, { x: 10, y: 10 })
    const entry = b.zone('entry', 1, 1, 5, 5, 'In')
    const exit = b.zone('exit', 15, 4, 19, 8, 'Out')
    const sim = run(
      b.build(),
      scenarioWith({
        durationS: 300,
        populations: [
          {
            ...createPopulation(0),
            count: 6,
            entryIds: [entry.id],
            itinerary: [step('exit', exit.id)],
          },
        ],
      }),
      3000,
    )
    const summary = sim.summary()
    // Nobody can get there, so nobody should be reported as having got there.
    expect(summary.completed).toBe(0)
    expect(summary.warnings.length).toBeGreaterThan(0)
  })

  it('ignores a zero-length wall', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 10, 10)
    b.wall({ x: 5, y: 5 }, { x: 5, y: 5 })
    const entry = b.zone('entry', 1, 1, 3, 3, 'In')
    const exit = b.zone('exit', 7, 7, 9, 9, 'Out')
    expect(() =>
      run(
        b.build(),
        scenarioWith({
          populations: [
            {
              ...createPopulation(0),
              count: 4,
              entryIds: [entry.id],
              itinerary: [step('exit', exit.id)],
            },
          ],
        }),
      ),
    ).not.toThrow()
    expect(detectRooms(b.build().walls).length).toBeGreaterThan(0)
  })

  it('handles two walls exactly on top of each other', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 10, 10)
    b.wall({ x: 0, y: 0 }, { x: 10, y: 0 })
    expect(() => detectRooms(b.build().walls)).not.toThrow()
    expect(() => new Simulation(b.build(), scenarioWith())).not.toThrow()
  })

  it('handles a service point with no queue drawn and one server', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 14, 12)
    const entry = b.zone('entry', 1, 1, 4, 4, 'In')
    const exit = b.zone('exit', 10, 9, 13, 11, 'Out')
    const desk = b.service('Desk', 7, 10.5, Math.PI, 1, { kind: 'constant', mean: 3 })
    const sim = run(
      b.build(),
      scenarioWith({
        durationS: 600,
        populations: [
          {
            ...createPopulation(0),
            count: 6,
            entryIds: [entry.id],
            arrival: { kind: 'all-at-once', startS: 0, windowS: 0 },
            itinerary: [step('service', desk.id), step('exit', exit.id)],
          },
        ],
      }),
      6000,
    )
    expect(sim.summary().services[0].served).toBeGreaterThan(0)
  })

  it('handles a population of nobody', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 10, 10)
    const entry = b.zone('entry', 1, 1, 3, 3, 'In')
    const sim = run(
      b.build(),
      scenarioWith({
        populations: [{ ...createPopulation(0), count: 0, entryIds: [entry.id], itinerary: [] }],
      }),
    )
    const summary = sim.summary()
    expect(summary.totalPeople).toBe(0)
    expect(summary.meanJourney).toBe(0)
    expect(Number.isNaN(summary.meanWait)).toBe(false)
  })

  it('drops itinerary steps whose target no longer exists', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 14, 12)
    const entry = b.zone('entry', 1, 1, 4, 4, 'In')
    const exit = b.zone('exit', 10, 9, 13, 11, 'Out')
    const sim = run(
      b.build(),
      scenarioWith({
        durationS: 300,
        populations: [
          {
            ...createPopulation(0),
            count: 4,
            entryIds: [entry.id],
            arrival: { kind: 'all-at-once', startS: 0, windowS: 0 },
            itinerary: [
              step('service', 'svc-that-was-deleted'),
              step('dwell', 'zone-that-was-deleted'),
              step('exit', exit.id),
            ],
          },
        ],
      }),
      3000,
    )
    // The missing steps are skipped; people still leave.
    expect(sim.summary().completed).toBe(4)
  })

  it('caps an absurd population and says so', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 40, 40)
    const entry = b.zone('entry', 2, 2, 38, 20, 'In')
    const sim = new Simulation(
      b.build(),
      scenarioWith({
        populations: [
          { ...createPopulation(0), count: 50000, entryIds: [entry.id], itinerary: [] },
        ],
      }),
    )
    expect(sim.summary().warnings.join(' ')).toMatch(/capped/i)
  })

  it('places furniture scaled to extremes without breaking the world', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 20, 20)
    b.place('table-round-6', 5, 5, 0, { size: { width: 0.001, depth: 0.001, height: 0.001 } })
    b.place('table-round-6', 14, 14, 0, { size: { width: 120, depth: 120, height: 3 } })
    const entry = b.zone('entry', 1, 1, 3, 3, 'In')
    expect(
      () =>
        new Simulation(
          b.build(),
          scenarioWith({
            populations: [
              { ...createPopulation(0), count: 2, entryIds: [entry.id], itinerary: [] },
            ],
          }),
        ),
    ).not.toThrow()
  })
})

describe('documents that do not make sense', () => {
  it('repairs a truncated file rather than throwing', () => {
    const result = parseDocumentJson('{"schemaVersion":1,"plan":{"walls":[{"a":')
    expect(result.warnings[0]).toMatch(/valid JSON/i)
    expect(result.document.plan.walls).toHaveLength(0)
  })

  it('reads a JSON file that is not a CROWD document', () => {
    const result = parseDocument({ hello: 'world', numbers: [1, 2, 3] })
    expect(result.document.plan.walls).toHaveLength(0)
    expect(result.document.scenario.populations.length).toBeGreaterThan(0)
  })

  it('drops openings whose wall is missing, and says how many', () => {
    const result = parseDocument({
      schemaVersion: 1,
      plan: {
        walls: [{ id: 'w1', a: [0, 0], b: [4, 0] }],
        openings: [
          { id: 'o1', wallId: 'w1', offset: 2, width: 1 },
          { id: 'o2', wallId: 'gone', offset: 2, width: 1 },
        ],
      },
    })
    expect(result.document.plan.openings).toHaveLength(1)
    expect(result.warnings.join(' ')).toMatch(/missing wall/i)
  })

  it('refuses a degenerate zone rather than carrying it into the plan', () => {
    const result = parseDocument({
      schemaVersion: 1,
      plan: {
        zones: [
          {
            id: 'z1',
            kind: 'entry',
            name: 'x',
            polygon: [
              [0, 0],
              [1, 1],
            ],
          },
        ],
      },
    })
    expect(result.document.plan.zones).toHaveLength(0)
  })

  it('clamps values that would break the simulation', () => {
    const result = parseDocument({
      schemaVersion: 1,
      plan: {
        walls: [{ id: 'w1', a: [0, 0], b: [4, 0], thickness: -5, height: 0 }],
        servicePoints: [
          { id: 's1', name: 'Desk', position: [1, 1], servers: -3, serviceTime: { mean: -9 } },
        ],
      },
      scenario: { durationS: -100, seed: -4, speedFactor: 0 },
    })
    expect(result.document.plan.walls[0].thickness).toBeGreaterThan(0)
    expect(result.document.plan.walls[0].height).toBeGreaterThan(0)
    expect(result.document.plan.servicePoints[0].servers).toBeGreaterThanOrEqual(1)
    expect(result.document.plan.servicePoints[0].serviceTime.mean).toBeGreaterThanOrEqual(0)
    expect(result.document.scenario.durationS).toBeGreaterThan(0)
    expect(result.document.scenario.speedFactor).toBeGreaterThan(0)
  })

  it('survives NaN and Infinity in every numeric field', () => {
    const result = parseDocument({
      schemaVersion: 1,
      plan: {
        walls: [{ id: 'w1', a: [Number.NaN, 0], b: [4, Number.POSITIVE_INFINITY] }],
        furniture: [
          {
            id: 'f1',
            catalogId: 'chair',
            position: [Number.NaN, Number.NaN],
            rotation: Number.NaN,
          },
        ],
      },
      scenario: { durationS: Number.NaN, seed: Number.POSITIVE_INFINITY },
    })
    const json = JSON.stringify(result.document)
    expect(json).not.toMatch(/null,null/)
    expect(Number.isFinite(result.document.scenario.durationS)).toBe(true)
    expect(Number.isFinite(result.document.scenario.seed)).toBe(true)
    for (const item of result.document.plan.furniture) {
      expect(Number.isFinite(item.position.x)).toBe(true)
      expect(Number.isFinite(item.rotation)).toBe(true)
    }
  })
})
