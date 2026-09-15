/**
 * The configuration study.
 *
 * Each experiment changes one thing about a venue and reports what it cost,
 * which is the loop the whole tool is built around: draw the room, run it,
 * change the room, run it again. Every figure is the mean of three seeds, and
 * the spread across those seeds is reported next to it so that a difference
 * too small to mean anything looks too small to mean anything.
 */

import {
  LAYOUTS,
  SEEDS,
  across,
  door,
  fmt,
  hall,
  leavers,
  run,
  scenarioFor,
  table,
} from './harness.mjs'

const PEOPLE = 200
const results = {}

/** Mean over seeds of one measurement, with the seed spread beside it. */
const gather = (make, pick) => {
  const runs = SEEDS.map((seed) => make(seed))
  return Object.fromEntries(Object.entries(pick).map(([key, get]) => [key, across(runs.map(get))]))
}

const meanSpread = (stat, places = 1) =>
  `${fmt(stat.mean, places)} ±${fmt((stat.max - stat.min) / 2, places)}`

/**
 * Share of person-seconds spent at Fruin level of service E or F.
 *
 * Peak density is a maximum over every person on every tick, so it finds the
 * single worst moment of a run and reads about the same — six to seven persons
 * per square metre, in the doorway — whatever the plan looks like. It is the
 * right alarm and the wrong comparison. This is how much of the crowd's time
 * was actually spent in the crowded bands, which is what separates one layout
 * from another.
 */
const crowdedShare = (summary) => (summary.losShare.E ?? 0) + (summary.losShare.F ?? 0)

// ---------------------------------------------------------------------------
// E1 — what a door is worth
// ---------------------------------------------------------------------------

export const exitProvision = () => {
  const cases = [
    { label: `1 x 2'0"`, exits: [{ wall: 'south', at: 0.5, width: door(`2'0"`) }] },
    { label: `1 x 3'0"`, exits: [{ wall: 'south', at: 0.5, width: door(`3'0"`) }] },
    { label: `1 x 6'0" pair`, exits: [{ wall: 'south', at: 0.5, width: door(`6'0" pair`) }] },
    {
      label: `2 x 3'0" same wall`,
      exits: [
        { wall: 'south', at: 0.3, width: door(`3'0"`) },
        { wall: 'south', at: 0.7, width: door(`3'0"`) },
      ],
    },
    {
      label: `2 x 3'0" opposite`,
      exits: [
        { wall: 'south', at: 0.5, width: door(`3'0"`) },
        { wall: 'north', at: 0.5, width: door(`3'0"`) },
      ],
    },
    {
      label: `4 x 3'0" one each wall`,
      exits: [
        { wall: 'south', at: 0.5, width: door(`3'0"`) },
        { wall: 'north', at: 0.5, width: door(`3'0"`) },
        { wall: 'east', at: 0.5, width: door(`3'0"`) },
        { wall: 'west', at: 0.5, width: door(`3'0"`) },
      ],
    },
  ]

  const rows = []
  for (const c of cases) {
    const venue = hall({ exits: c.exits })
    const stats = gather(
      (seed) => {
        const pop = leavers({ count: PEOPLE, entryIds: [], standId: venue.standId })
        return run({ plan: venue.plan, scenario: scenarioFor({ population: pop, seed }) })
      },
      {
        clearance: (r) => r.summary.clearanceTime,
        peakDensity: (r) => r.summary.peakDensity,
        crowded: (r) => crowdedShare(r.summary) * 100,
        completed: (r) => r.summary.completed,
        p95: (r) => r.summary.p95Journey,
      },
    )
    const flow = (PEOPLE * 0.95) / stats.clearance.mean
    rows.push([
      c.label,
      fmt(venue.exitWidth, 3),
      meanSpread(stats.clearance),
      fmt(flow, 2),
      fmt(flow / venue.exitWidth, 2),
      meanSpread(stats.peakDensity, 2),
      meanSpread(stats.crowded, 1),
      fmt(stats.completed.mean, 0),
    ])
    console.log(`    ${c.label} done`)
  }

  results.exitProvision = rows
  return table(
    ['exits', 'clear m', 'clearance s', 'p/s', 'p/m/s', 'peak p/m2', '% at LOS E/F', 'out'],
    rows,
  )
}

// ---------------------------------------------------------------------------
// E2 — what the furniture costs
// ---------------------------------------------------------------------------

export const layouts = () => {
  const rows = []
  for (const name of ['empty', 'reception', 'classroom', 'banquet', 'theatre']) {
    const venue = hall({
      exits: [
        { wall: 'south', at: 0.3, width: door(`3'0"`) },
        { wall: 'south', at: 0.7, width: door(`3'0"`) },
      ],
      furniture: LAYOUTS[name],
    })
    const stats = gather(
      (seed) => {
        const pop = leavers({ count: PEOPLE, entryIds: [], standId: venue.standId })
        return run({ plan: venue.plan, scenario: scenarioFor({ population: pop, seed }) })
      },
      {
        clearance: (r) => r.summary.clearanceTime,
        walkable: (r) => r.summary.walkableArea,
        journey: (r) => r.summary.meanJourney,
        peakDensity: (r) => r.summary.peakDensity,
        crowded: (r) => crowdedShare(r.summary) * 100,
        completed: (r) => r.summary.completed,
        perAgentUs: (r) => r.perAgentUs,
      },
    )
    rows.push([
      name,
      String(venue.plan.furniture.length),
      fmt(stats.walkable.mean, 0),
      meanSpread(stats.clearance),
      meanSpread(stats.journey),
      meanSpread(stats.peakDensity, 2),
      meanSpread(stats.crowded, 1),
      fmt(stats.completed.mean, 0),
      fmt(stats.perAgentUs.mean, 1),
    ])
    console.log(`    ${name} done`)
  }
  results.layouts = rows
  return table(
    [
      'layout',
      'items',
      'walkable m2',
      'clearance s',
      'journey s',
      'peak p/m2',
      '% at LOS E/F',
      'out',
      'us/p/step',
    ],
    rows,
  )
}

// ---------------------------------------------------------------------------
// E3 — how it scales with the size of the crowd
// ---------------------------------------------------------------------------

export const crowdSize = () => {
  const venue = hall({
    exits: [
      { wall: 'south', at: 0.3, width: door(`3'0"`) },
      { wall: 'south', at: 0.7, width: door(`3'0"`) },
    ],
  })
  const rows = []
  for (const count of [50, 100, 200, 400, 800]) {
    const stats = gather(
      (seed) => {
        const pop = leavers({ count, entryIds: [], standId: venue.standId })
        return run({ plan: venue.plan, scenario: scenarioFor({ population: pop, seed }) })
      },
      {
        clearance: (r) => r.summary.clearanceTime,
        peakDensity: (r) => r.summary.peakDensity,
        journey: (r) => r.summary.meanJourney,
        completed: (r) => r.summary.completed,
        perAgentUs: (r) => r.perAgentUs,
      },
    )
    rows.push([
      String(count),
      meanSpread(stats.clearance),
      fmt((count * 0.95) / stats.clearance.mean, 2),
      meanSpread(stats.journey),
      meanSpread(stats.peakDensity, 2),
      meanSpread(stats.crowded, 1),
      fmt(stats.completed.mean, 0),
      fmt(stats.perAgentUs.mean, 1),
    ])
    console.log(`    ${count} people done`)
  }
  results.crowdSize = rows
  return table(['people', 'clearance s', 'p/s', 'journey s', 'peak p/m2', 'out', 'us/p/step'], rows)
}

// ---------------------------------------------------------------------------
// E4 — how they arrive
// ---------------------------------------------------------------------------

export const arrivals = () => {
  const venue = hall({
    exits: [{ wall: 'south', at: 0.7, width: door(`3'0"`) }],
    entries: [{ wall: 'north', at: 0.3, width: door(`6'0" pair`) }],
  })
  const profiles = [
    { label: 'all at once', arrival: { kind: 'all-at-once', startS: 0, windowS: 0 } },
    { label: 'uniform 120 s', arrival: { kind: 'uniform', startS: 0, windowS: 120 } },
    { label: 'uniform 600 s', arrival: { kind: 'uniform', startS: 0, windowS: 600 } },
    {
      label: 'peak at 600 s',
      arrival: { kind: 'peak', startS: 0, windowS: 600, peakAt: 0.5, spread: 0.2 },
    },
  ]
  const rows = []
  for (const p of profiles) {
    const stats = gather(
      (seed) => {
        const pop = leavers({
          count: PEOPLE,
          entryIds: venue.entryIds,
          standId: venue.standId,
          arrival: p.arrival,
        })
        return run({ plan: venue.plan, scenario: scenarioFor({ population: pop, seed }) })
      },
      {
        peakOccupancy: (r) => r.summary.peakOccupancy,
        peakDensity: (r) => r.summary.peakDensity,
        journey: (r) => r.summary.meanJourney,
        wait: (r) => r.summary.meanWait,
        completed: (r) => r.summary.completed,
      },
    )
    rows.push([
      p.label,
      meanSpread(stats.peakOccupancy, 0),
      meanSpread(stats.peakDensity, 2),
      meanSpread(stats.journey),
      meanSpread(stats.wait),
      fmt(stats.completed.mean, 0),
    ])
    console.log(`    ${p.label} done`)
  }
  results.arrivals = rows
  return table(['arrival', 'peak inside', 'peak p/m2', 'journey s', 'wait s', 'out'], rows)
}

// ---------------------------------------------------------------------------
// E5 — counters and queues
// ---------------------------------------------------------------------------

export const counters = () => {
  // 120 people over half an hour against a 40 s desk: one desk is offered 2.7
  // times what it can serve, two 1.3 times, and only three and four are stable.
  // That is the interesting range — a queue that is merely busy tells you less
  // than the step from saturated to not.
  const COUNT = 120
  const WINDOW = 1800
  const MEAN_SERVICE = 40
  const serviceTime = { kind: 'normal', mean: MEAN_SERVICE, sd: 10, min: 10 }
  const rows = []

  for (const desks of [1, 2, 3, 4]) {
    const services = []
    for (let i = 0; i < desks; i++) {
      // Mid-room and facing the same way the templates face their counters, so
      // the queue has the length of the hall to grow into. A counter backed up
      // against a wall puts its slots outside the building and people walk out
      // of the door and round to reach them, which nothing warns about.
      services.push({
        name: `Desk ${i + 1}`,
        x: 6 + i * 5,
        y: 6,
        rotation: Math.PI,
        servers: 1,
        serviceTime,
      })
    }
    const venue = hall({
      exits: [{ wall: 'south', at: 0.5, width: door(`6'0" pair`) }],
      entries: [{ wall: 'south', at: 0.15, width: door(`6'0" pair`) }],
      services,
    })
    const stats = gather(
      (seed) => {
        const pop = {
          ...leavers({ count: COUNT, entryIds: venue.entryIds, standId: venue.standId }),
          arrival: { kind: 'uniform', startS: 0, windowS: WINDOW },
          itinerary: [
            { id: 'q:service', kind: 'service', targetIds: venue.serviceIds },
            { id: 'q:exit', kind: 'exit' },
          ],
        }
        return run({
          plan: venue.plan,
          scenario: scenarioFor({ population: pop, seed, durationS: 12_000 }),
          maxSteps: 120_000,
        })
      },
      {
        queueTime: (r) => r.summary.meanQueueTime,
        maxWait: (r) => r.summary.maxWait,
        journey: (r) => r.summary.meanJourney,
        completed: (r) => r.summary.completed,
      },
    )

    const lambda = COUNT / WINDOW
    const rho = lambda / (desks * (1 / MEAN_SERVICE))
    rows.push([
      String(desks),
      fmt(rho, 2),
      meanSpread(stats.queueTime, 0),
      meanSpread(stats.maxWait, 0),
      meanSpread(stats.journey, 0),
      fmt(stats.completed.mean, 0),
    ])
    console.log(`    ${desks} desk(s) done`)
  }

  results.counters = rows
  return table(['desks', 'offered load', 'queue s', 'worst wait s', 'journey s', 'served'], rows)
}

export const collected = () => results
