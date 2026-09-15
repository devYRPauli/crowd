/**
 * Simulation performance benchmark.
 *
 * Reports the cost of one physics step at several crowd sizes, so a change that
 * makes the engine quadratic is visible before it reaches anyone. Rendering is
 * not measured here: it depends entirely on the GPU, and the CI machine has
 * none.
 *
 * Run with: node --experimental-strip-types scripts/benchmark.mjs, or through
 * `npx vite-node scripts/benchmark.mjs`.
 */

import { Simulation } from '../src/sim/engine.ts'
import { getTemplate } from '../src/library/templates.ts'

const TIME_STEP = 0.1
const WARMUP_STEPS = 200
const MEASURE_STEPS = 300

const bench = (templateId, count) => {
  const doc = getTemplate(templateId).build()
  const scenario = {
    ...doc.scenario,
    durationS: 100000,
    evacuationAtS: null,
    populations: doc.scenario.populations.map((p, index) => ({
      ...p,
      count: index === 0 ? count : Math.round(count * 0.3),
      arrival: { kind: 'all-at-once', startS: 0, windowS: 0 },
    })),
  }
  const sim = new Simulation(doc.plan, scenario, { maxAgents: count * 2 })

  const built = performance.now()
  for (let i = 0; i < WARMUP_STEPS; i++) sim.step(TIME_STEP)
  const warm = performance.now()

  let peakActive = 0
  const started = performance.now()
  for (let i = 0; i < MEASURE_STEPS; i++) {
    sim.step(TIME_STEP)
    peakActive = Math.max(peakActive, sim.stats().active)
  }
  const elapsed = performance.now() - started

  const perStep = elapsed / MEASURE_STEPS
  // Real time means simulating TIME_STEP seconds in TIME_STEP seconds.
  const realTimeFactor = (TIME_STEP * 1000) / perStep
  return {
    template: templateId,
    requested: count,
    active: peakActive,
    buildMs: warm - built,
    perStepMs: perStep,
    perAgentUs: peakActive > 0 ? (perStep * 1000) / peakActive : 0,
    realTimeFactor,
  }
}

const rows = []
for (const [template, count] of [
  ['coffee-bar', 50],
  ['conference', 200],
  ['conference', 500],
  ['concourse', 500],
  ['concourse', 1000],
  ['banquet', 1000],
]) {
  rows.push(bench(template, count))
}

const pad = (value, width) => String(value).padStart(width)
console.log('')
console.log('  template        asked  active   step ms   µs/person   × real time')
console.log('  ' + '-'.repeat(64))
for (const row of rows) {
  console.log(
    `  ${row.template.padEnd(14)} ${pad(row.requested, 5)}  ${pad(row.active, 6)}  ${pad(
      row.perStepMs.toFixed(2),
      7,
    )}  ${pad(row.perAgentUs.toFixed(1), 9)}  ${pad(row.realTimeFactor.toFixed(0), 11)}`,
  )
}
console.log('')
console.log('  Real time needs × 1. Playback runs at up to × 60, so × 60 is the target')
console.log('  for the fastest speed to keep up on this machine.')
console.log('')
