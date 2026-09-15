/**
 * The measuring instrument for the configuration study.
 *
 * Everything here builds a venue the way somebody would build one in the
 * editor — four walls, doors cut into them, furniture placed on the floor —
 * rather than loading a template, because the question the study asks is what
 * happens when you *change* a plan, and a template is a fixed answer.
 *
 * Every figure the study reports comes out of `run`. Derived numbers are
 * computed here, once, so that no experiment can quietly define specific flow
 * differently from its neighbour.
 */

import { Simulation } from '../../src/sim/engine.ts'
import { PlanBuilder } from '../../src/library/planBuilder.ts'
import { createScenario } from '../../src/core/model/defaults.ts'
import { DOOR_WIDTHS } from '../../src/core/model/standards.ts'

/**
 * A door by the name a supplier calls it.
 *
 * The study quotes flow per metre of clear width, so the widths it uses have to
 * be the real ones. Taking them out of the product's own table rather than
 * retyping them means a change to the table moves the study with it.
 */
export const door = (imperial) => {
  const size = DOOR_WIDTHS.find((entry) => entry.imperial === imperial)
  if (!size) {
    throw new Error(
      `No stock door called ${imperial}. Known: ${DOOR_WIDTHS.map((d) => d.imperial).join(', ')}`,
    )
  }
  return size.metres
}

/** The physics step the app itself runs at. */
export const DT = 0.1

/** Seeds every configuration is replicated across. */
export const SEEDS = [1, 2, 3]

/**
 * A hall, and everything about it that the study varies.
 *
 * Sizes are real: a 30 x 20 m hall is a mid-sized function room, and the doors
 * are stock leaves out of `standards.ts` rather than round metric numbers, so
 * the flow figures can be compared with published ones measured on real doors.
 */
export const hall = ({
  width = 30,
  height = 20,
  exits = [{ wall: 'south', at: 0.5, width: door(`3'0"`) }],
  entries = [],
  furniture = null,
  services = [],
} = {}) => {
  const b = new PlanBuilder()
  const room = b.room(0, 0, width, height)
  const walls = { south: room.south, east: room.east, north: room.north, west: room.west }
  const spanOf = (name) => (name === 'south' || name === 'north' ? width : height)

  const exitIds = []
  for (const exit of exits) {
    const wall = walls[exit.wall]
    const leaf = b.door(wall, exit.at * spanOf(exit.wall), exit.width, 'door', 'exit')
    exitIds.push(leaf.id)
  }

  const entryIds = []
  for (const entry of entries) {
    const wall = walls[entry.wall]
    const leaf = b.door(
      wall,
      entry.at * spanOf(entry.wall),
      entry.width ?? door(`3'0"`),
      'door',
      'entry',
    )
    entryIds.push(leaf.id)
  }

  // Where people start when no entry door is given: a band across the middle of
  // the floor, clear of the walls, so nobody begins inside one.
  const stand = b.zone('entry', 2, 2, width - 2, height - 2, 'Floor')

  if (furniture) furniture(b, width, height)

  const serviceIds = []
  for (const s of services) {
    const point = b.service(s.name, s.x, s.y, s.rotation ?? 0, s.servers ?? 1, s.serviceTime)
    serviceIds.push(point.id)
  }

  return {
    plan: b.build(),
    width,
    height,
    floorArea: width * height,
    exitIds,
    entryIds,
    standId: stand.id,
    serviceIds,
    /** Total clear width of every exit, in metres — the figure flow scales on. */
    exitWidth: exits.reduce((total, exit) => total + exit.width, 0),
  }
}

/** Furniture layouts, each covering the floor the way a real event would. */
export const LAYOUTS = {
  empty: null,

  /** Banquet rounds of eight, on the spacing a caterer would actually use. */
  banquet: (b, width, height) => {
    const spacing = 3.2
    const columns = Math.floor((width - 4) / spacing)
    const rows = Math.floor((height - 4) / spacing)
    b.tableGrid('table-round-8', 3, 3, columns, rows, spacing, spacing)
  },

  /** Theatre rows facing the far wall, with a centre aisle. */
  theatre: (b, width, height) => {
    const rowWidth = (width - 6) / 2 - 1
    const rows = Math.floor((height - 6) / 0.95)
    b.seatingBlock(3 + rowWidth / 2, 3, rows, rowWidth)
    b.seatingBlock(width - 3 - rowWidth / 2, 3, rows, rowWidth)
  },

  /** Classroom: rectangular tables in ranks, with gangways between them. */
  classroom: (b, width, height) => {
    const spacing = 2.6
    const columns = Math.floor((width - 4) / spacing)
    const rows = Math.floor((height - 4) / (spacing + 0.6))
    b.tableGrid('table-rect-6ft', 3, 3, columns, rows, spacing, spacing + 0.6)
  },

  /** Standing reception: a few poseur tables, most of the floor clear. */
  reception: (b, width, height) => {
    const spacing = 5.0
    const columns = Math.floor((width - 6) / spacing)
    const rows = Math.floor((height - 6) / spacing)
    // Poseur tables are stood at, not sat at, so this places no chairs.
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        b.place('table-poseur', 4 + column * spacing, 4 + row * spacing)
      }
    }
  },
}

/** A population that walks in and leaves again, with nothing else to do. */
export const leavers = ({ count, entryIds, standId, arrival }) => ({
  id: 'study',
  name: 'study',
  count,
  color: '#4c7dd4',
  entryIds: entryIds.length ? entryIds : [standId],
  arrival: arrival ?? { kind: 'all-at-once', startS: 0, windowS: 0 },
  profileMix: [{ profileId: 'adult', weight: 1 }],
  itinerary: [{ id: 'study:exit', kind: 'exit' }],
})

/**
 * Run one configuration to a standstill and report what happened.
 *
 * The cap exists so that a plan which strands people ends the run rather than
 * spinning to the duration limit; when it bites, `cappedOut` says so and the
 * numbers from that run are not comparable with the rest.
 */
export const run = ({ plan, scenario, maxSteps = 30_000, sampleDensity = false }) => {
  const sim = new Simulation(plan, scenario)
  const started = performance.now()

  let steps = 0
  let peakActive = 0
  const densitySamples = []

  while (steps < maxSteps && !sim.isFinished) {
    sim.step(DT)
    steps++
    const active = sim.stats().active
    if (active > peakActive) peakActive = active
    if (sampleDensity && steps % 50 === 0) densitySamples.push(active)
  }

  const wallClockMs = performance.now() - started
  const summary = sim.summary()
  return {
    summary,
    steps,
    peakActive,
    densitySamples,
    cappedOut: steps >= maxSteps && !sim.isFinished,
    wallClockMs,
    perAgentUs: peakActive > 0 ? (wallClockMs * 1000) / (steps * peakActive) : 0,
  }
}

/**
 * Specific flow: people per metre of clear exit width per second.
 *
 * This is the figure egress capacity is quoted in, and the one that can be
 * checked against a published number rather than against CROWD's own past self.
 * It is measured over the clearance time — the point 95% of people are out —
 * because the long tail of stragglers is not what the capacity figure describes.
 */
export const specificFlow = (summary, exitWidth) =>
  summary.clearanceTime > 0 ? (summary.completed * 0.95) / (summary.clearanceTime * exitWidth) : 0

/** Mean and spread across the seed replicates of one configuration. */
export const across = (values) => {
  const n = values.length
  if (n === 0) return { mean: 0, min: 0, max: 0, sd: 0 }
  const mean = values.reduce((a, b) => a + b, 0) / n
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  return { mean, min: Math.min(...values), max: Math.max(...values), sd: Math.sqrt(variance) }
}

/** One configuration, run once per seed. */
export const replicate = (build, { seeds = SEEDS, ...options } = {}) =>
  seeds.map((seed) => {
    const { plan, scenario } = build(seed)
    return run({ plan, scenario, ...options })
  })

export const scenarioFor = ({
  population,
  seed,
  durationS = 3600,
  adaptive = true,
  evacuationAtS = null,
}) => {
  const base = createScenario()
  return {
    ...base,
    name: 'study',
    durationS,
    seed,
    evacuationAtS,
    routing: { ...base.routing, adaptive },
    populations: [population],
  }
}

/** A fixed-width table, so a column of numbers reads as a column. */
export const table = (headers, rows) => {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => String(row[i]).length)),
  )
  const line = (cells, pad) =>
    '  ' + cells.map((cell, i) => String(cell)[pad](widths[i])).join('  ')
  const out = [line(headers, 'padEnd'), '  ' + widths.map((w) => '-'.repeat(w)).join('  ')]
  for (const row of rows) out.push(line(row, 'padStart'))
  return out.join('\n')
}

export const fmt = (value, places = 2) => (Number.isFinite(value) ? value.toFixed(places) : '—')
