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

/**
 * Hand the event loop back for a tick.
 *
 * A test that keeps the worker's event loop to itself for longer than vitest's
 * RPC timeout makes the runner report an unhandled error — "Timeout calling
 * onTaskUpdate" — even though every assertion passed, because the reporter
 * never got an answer. These runs are long synchronous loops and this file is
 * the longest of them, so they let go periodically.
 */
const breathe = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const run = async (id: string): Promise<unknown> => {
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
  for (let i = 0; i < 4000 && !sim.isFinished; i++) {
    sim.step(0.25)
    if (i % 400 === 0) await breathe()
  }
  return numbersOnly(sim.summary())
}

describe('determinism', () => {
  it.each(TEMPLATES.map((template) => [template.id] as const))(
    '%s produces the same numbers from a second build of the same plan',
    async (id) => {
      const first = await run(id)
      expect(await run(id)).toEqual(first)
    },
    120_000,
  )
})
