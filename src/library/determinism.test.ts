/**
 * The same venue, built twice, has to simulate identically.
 *
 * This is the claim the comparison feature rests on: save a run as a baseline,
 * change the layout, run again, and the difference is the layout. If two builds
 * of the *same* plan disagree, every delta the tool reports is partly noise and
 * nobody can tell which part.
 *
 * It did disagree. Object ids are minted per document from `Math.random`, and
 * the engine used to name its random-draw streams after them — one stream per
 * population id, one per service point id — so the same template built twice
 * drew different arrival times and different service durations. The polling
 * station came out anywhere between 108 and 119 people served on identical
 * input. Streams are named after a thing's position in the plan now, which two
 * structurally identical plans always agree on.
 */

import { describe, expect, it } from 'vitest'
import { TEMPLATES } from './templates'
import { Simulation } from '../sim/engine'

/** The summary with ids stripped: those are minted per build and differ by design. */
const numbersOnly = (summary: unknown): unknown =>
  JSON.parse(JSON.stringify(summary).replace(/"id":"[^"]*"/g, '"id":"-"'))

const run = (id: string): unknown => {
  const doc = TEMPLATES.find((template) => template.id === id)!.build()
  // Scaled down to keep this cheap; determinism does not depend on the size.
  const scenario = {
    ...doc.scenario,
    durationS: 900,
    evacuationAtS: null,
    populations: doc.scenario.populations.map((population) => ({
      ...population,
      count: Math.max(8, Math.round(population.count * 0.1)),
      arrival: { ...population.arrival, startS: 0, windowS: 120 },
    })),
  }
  const sim = new Simulation(doc.plan, scenario)
  for (let i = 0; i < 4000 && !sim.isFinished; i++) sim.step(0.25)
  return numbersOnly(sim.summary())
}

describe('determinism', () => {
  it.each(TEMPLATES.map((template) => [template.id] as const))(
    '%s produces the same numbers from a second build of the same plan',
    (id) => {
      const first = run(id)
      expect(run(id)).toEqual(first)
    },
    120_000,
  )
})
