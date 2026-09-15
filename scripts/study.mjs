/**
 * Run the configuration study and print its tables.
 *
 * `npx vite-node scripts/study.mjs` runs everything; naming experiments
 * (`... scripts/study.mjs exits layouts`) runs only those. The numbers land in
 * docs/EXPERIMENTS.md by hand, not automatically, because a table nobody read
 * before publishing is how a wrong number gets into a document.
 */

import { writeFileSync } from 'node:fs'
import {
  arrivals,
  collected,
  counters,
  crowdSize,
  exitProvision,
  layouts,
} from './study/experiments.mjs'

const ALL = {
  exits: ['E1 — what a door is worth', exitProvision],
  layouts: ['E2 — what the furniture costs', layouts],
  crowd: ['E3 — how it scales with the size of the crowd', crowdSize],
  arrivals: ['E4 — how they arrive', arrivals],
  counters: ['E5 — counters and queues', counters],
}

const asked = process.argv.slice(2).filter((arg) => arg in ALL)
const chosen = asked.length ? asked : Object.keys(ALL)

console.log('\nCROWD configuration study')
console.log('Three seeds per configuration; ± is half the spread across them.\n')

for (const key of chosen) {
  const [title, experiment] = ALL[key]
  console.log(`\n${title}`)
  console.log('-'.repeat(title.length))
  const started = Date.now()
  const rendered = experiment()
  console.log(rendered)
  console.log(`  (${((Date.now() - started) / 1000).toFixed(0)} s)`)
}

writeFileSync(
  new URL('../study-results.json', import.meta.url),
  JSON.stringify(collected(), null, 2),
)
console.log('\nRaw rows written to study-results.json\n')
