/**
 * Starter venues.
 *
 * Six plans that between them cover the shapes of movement the product is for:
 * a queue that backs up, a crowd that disperses, people who sit and stay, a
 * hall with counterflow, and a room under evacuation. They exist so that the
 * first thing anyone sees is a venue with people already moving through it
 * rather than an empty grid — and so every feature has something to act on
 * before the user has drawn anything.
 */

import type { CrowdDocument, Population, Scenario } from '../core/model/types'
import { SCHEMA_VERSION } from '../core/model/types'
import {
  AGENT_PROFILES,
  DEFAULT_PROFILE_MIX,
  DEFAULT_SETTINGS,
  POPULATION_COLORS,
} from '../core/model/defaults'
import { newDocumentId, newId } from '../core/model/ids'
import { PlanBuilder, step } from './planBuilder'

export interface Template {
  id: string
  name: string
  summary: string
  /** What this venue is useful for demonstrating. */
  teaches: string
  build: () => CrowdDocument
}

const makeDocument = (
  name: string,
  plan: ReturnType<PlanBuilder['build']>,
  scenario: Omit<Scenario, 'profiles'>,
): CrowdDocument => {
  const now = new Date().toISOString()
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newDocumentId(),
    name,
    createdAt: now,
    updatedAt: now,
    settings: { ...DEFAULT_SETTINGS },
    plan,
    scenario: { ...scenario, profiles: AGENT_PROFILES.map((p) => ({ ...p })) },
  }
}

const population = (
  overrides: Partial<Population> & Pick<Population, 'name' | 'count' | 'entryIds' | 'itinerary'>,
): Population => ({
  id: newId('pop'),
  color: POPULATION_COLORS[0],
  arrival: { kind: 'uniform', startS: 0, windowS: 600 },
  profileMix: DEFAULT_PROFILE_MIX.map((entry) => ({ ...entry })),
  ...overrides,
})

const baseRouting: Scenario['routing'] = {
  adaptive: true,
  congestionWeight: 0.55,
  replanIntervalS: 2,
  routeVariety: 0.3,
}

// --- 1. Coffee bar -----------------------------------------------------------

const coffeeBar = (): CrowdDocument => {
  const b = new PlanBuilder()
  const room = b.room(0, 0, 14, 10)
  b.door(room.south, 2.0, 1.8)
  b.window(room.west, 3, 2.4)
  b.window(room.west, 7, 2.4)
  b.window(room.north, 5, 3)

  const counter = b.service(
    'Coffee bar',
    11.2,
    7.6,
    Math.PI,
    2,
    {
      kind: 'lognormal',
      mean: 42,
      sd: 16,
      min: 12,
    },
    {
      width: 3.2,
      depth: 0.8,
      queue: [
        { x: 11.2, y: 6.4 },
        { x: 11.2, y: 3.2 },
        { x: 7.6, y: 3.2 },
      ],
    },
  )
  b.place('coffee-station', 12.6, 9.2, Math.PI)
  b.place('shelving', 8.6, 9.5, Math.PI)

  b.tableWithChairs('table-square-4', 3.0, 7.4)
  b.tableWithChairs('table-square-4', 6.0, 7.4)
  b.tableWithChairs('table-round-4', 3.0, 4.4)
  b.tableWithChairs('table-round-4', 6.0, 4.4)
  b.place('sofa-2', 1.6, 1.9, Math.PI / 2)
  b.place('table-coffee', 2.9, 1.9, Math.PI / 2)
  b.place('plant-tree', 12.8, 1.4)
  b.place('plant-small', 0.9, 9.0)
  b.place('bin', 8.0, 0.8)

  const entry = b.zone('entry', 1.4, 0.35, 3.4, 1.6, 'Street door')
  const exit = b.zone('exit', 1.4, 0.35, 3.4, 1.6, 'Street door (out)')
  const seating = b.zone('seating', 1.2, 3.2, 8.0, 9.0, 'Seating area')
  b.zone('keep-clear', 8.6, 1.0, 10.4, 9.0, 'Service aisle', { cost: 3 })

  return makeDocument('Coffee bar', b.build(), {
    name: 'Morning rush',
    durationS: 2400,
    seed: 1,
    speedFactor: 1,
    routing: baseRouting,
    evacuationAtS: null,
    populations: [
      population({
        name: 'Customers',
        count: 90,
        color: POPULATION_COLORS[0],
        entryIds: [entry.id],
        arrival: { kind: 'peak', startS: 0, windowS: 1800, peakAt: 0.35, spread: 0.16 },
        itinerary: [
          step('service', counter.id),
          step('seat', seating.id, {
            duration: { kind: 'lognormal', mean: 720, sd: 300, min: 180 },
            probability: 0.55,
          }),
          step('exit', exit.id),
        ],
      }),
    ],
  })
}

// --- 2. Conference registration ---------------------------------------------

const conference = (): CrowdDocument => {
  const b = new PlanBuilder()
  const hall = b.room(0, 0, 30, 20)
  b.door(hall.south, 4, 2.4)
  b.door(hall.south, 12, 2.4)
  // Partition between the foyer and the session room.
  const partition = b.wall(
    { x: 0, y: 12 },
    { x: 30, y: 12 },
    { kind: 'partition', thickness: 0.15 },
  )
  b.door(partition, 8, 2.4)
  b.door(partition, 22, 2.4)

  const desks = [6, 11, 16, 21].map((x, index) =>
    b.service(
      `Registration ${index + 1}`,
      x,
      10.6,
      Math.PI,
      1,
      { kind: 'lognormal', mean: 38, sd: 14, min: 10 },
      {
        width: 2.0,
        depth: 0.8,
        queue: [
          { x, y: 9.4 },
          { x, y: 4.2 },
        ],
      },
    ),
  )
  for (const x of [6, 11, 16, 21]) b.place('counter-reception', x, 10.6, Math.PI)
  b.place('banner', 2.0, 10.4, Math.PI)
  b.place('banner', 26.0, 10.4, Math.PI)
  b.place('coat-rail', 27.5, 6.0, Math.PI / 2)
  b.place('coat-rail', 27.5, 4.0, Math.PI / 2)
  b.place('plant-tree', 1.4, 6.0)
  b.place('plant-tree', 28.4, 9.6)

  // Session room.
  b.place('stage', 15, 18.4, 0, { size: { width: 10, depth: 2.6, height: 0.5 } })
  b.place('projector-screen', 15, 19.4, 0, { size: { width: 6, depth: 0.2, height: 3.4 } })
  b.place('lectern', 19.5, 18.6)
  for (let row = 0; row < 7; row++) {
    b.place('seat-row', 9.5, 13.4 + row * 0.95, Math.PI, {
      size: { width: 8.4, depth: 0.7, height: 0.95 },
    })
    b.place('seat-row', 20.5, 13.4 + row * 0.95, Math.PI, {
      size: { width: 8.4, depth: 0.7, height: 0.95 },
    })
  }

  const entryA = b.zone('entry', 3.0, 0.3, 5.2, 1.8, 'Main entrance')
  const entryB = b.zone('entry', 11.0, 0.3, 13.2, 1.8, 'Side entrance')
  const exit = b.zone('exit', 3.0, 0.3, 5.2, 1.8, 'Main entrance (out)')
  const session = b.zone('seating', 5.0, 12.8, 25.0, 19.6, 'Session room')
  b.zone('keep-clear', 14.0, 12.4, 16.2, 19.8, 'Centre aisle', { cost: 5 })
  b.zone('measure', 0.4, 12.2, 29.6, 13.0, 'Session doorway')

  return makeDocument('Conference registration', b.build(), {
    name: 'Doors open',
    durationS: 3600,
    seed: 1,
    speedFactor: 1,
    routing: baseRouting,
    evacuationAtS: null,
    populations: [
      population({
        name: 'Delegates',
        count: 320,
        color: POPULATION_COLORS[0],
        entryIds: [entryA.id, entryB.id],
        arrival: { kind: 'peak', startS: 0, windowS: 1800, peakAt: 0.55, spread: 0.2 },
        groupSize: { min: 1, max: 3 },
        itinerary: [
          step('service', undefined, { targetIds: desks.map((d) => d.id) }),
          step('seat', session.id, { duration: { kind: 'normal', mean: 1500, sd: 200, min: 600 } }),
          step('exit', exit.id),
        ],
      }),
    ],
  })
}

// --- 3. Gallery opening ------------------------------------------------------

const gallery = (): CrowdDocument => {
  const b = new PlanBuilder()
  const room = b.room(0, 0, 24, 16)
  b.door(room.south, 3, 2.2)
  b.door(room.east, 8, 1.6)
  // Interior partitions that make a route rather than one big box.
  const p1 = b.wall(
    { x: 8, y: 0.2 },
    { x: 8, y: 9 },
    { kind: 'partition', thickness: 0.2, height: 3 },
  )
  const p2 = b.wall(
    { x: 16, y: 7 },
    { x: 16, y: 15.8 },
    { kind: 'partition', thickness: 0.2, height: 3 },
  )
  b.door(p1, 5.5, 2.0, 'opening')
  b.door(p2, 4.0, 2.0, 'opening')

  for (const [x, y, rot] of [
    [3, 15.7, 0],
    [6, 15.7, 0],
    [12, 15.7, 0],
    [20, 15.7, 0],
    [7.7, 3, Math.PI / 2],
    [7.7, 6.5, Math.PI / 2],
    [16.3, 10, -Math.PI / 2],
    [16.3, 13.5, -Math.PI / 2],
    [23.7, 4, -Math.PI / 2],
    [23.7, 11, -Math.PI / 2],
  ] as Array<[number, number, number]>) {
    b.place('artwork', x, y, rot)
  }
  b.place('column-round', 12, 8)
  b.place('column-round', 18, 4)

  const bar = b.service(
    'Drinks bar',
    21.4,
    14.8,
    Math.PI,
    2,
    { kind: 'lognormal', mean: 28, sd: 10, min: 8 },
    {
      width: 3.0,
      depth: 0.8,
      queue: [
        { x: 21.4, y: 13.6 },
        { x: 21.4, y: 10.0 },
      ],
    },
  )
  b.place('counter-bar', 21.4, 14.8, Math.PI, { size: { width: 3.0, depth: 0.7, height: 1.1 } })
  for (const x of [18.0, 19.4, 20.8]) b.place('table-poseur', x, 8.6)
  b.place('plant-tree', 1.6, 8.0)

  const entry = b.zone('entry', 2.0, 0.35, 4.2, 1.8, 'Front door')
  const exit = b.zone('exit', 2.0, 0.35, 4.2, 1.8, 'Front door (out)')
  const westWing = b.zone('waypoint', 0.6, 9.5, 7.4, 15.2, 'West wall', {
    dwell: { kind: 'lognormal', mean: 210, sd: 90, min: 45 },
  })
  const eastWing = b.zone('waypoint', 9.0, 1.0, 15.2, 6.4, 'East wall', {
    dwell: { kind: 'lognormal', mean: 210, sd: 90, min: 45 },
  })
  const backWing = b.zone('waypoint', 17.0, 8.0, 23.4, 14.0, 'Back room', {
    dwell: { kind: 'lognormal', mean: 180, sd: 80, min: 40 },
  })

  return makeDocument('Gallery opening', b.build(), {
    name: 'Private view',
    durationS: 5400,
    seed: 1,
    speedFactor: 1,
    routing: { ...baseRouting, routeVariety: 0.5 },
    evacuationAtS: null,
    populations: [
      population({
        name: 'Guests',
        count: 180,
        color: POPULATION_COLORS[4],
        entryIds: [entry.id],
        arrival: { kind: 'peak', startS: 120, windowS: 2700, peakAt: 0.3, spread: 0.22 },
        groupSize: { min: 1, max: 4 },
        itinerary: [
          step('service', bar.id, { probability: 0.8 }),
          step('dwell', westWing.id, { probability: 0.7 }),
          step('dwell', eastWing.id, { probability: 0.8 }),
          step('dwell', backWing.id, { probability: 0.6 }),
          step('exit', exit.id),
        ],
      }),
    ],
  })
}

// --- 4. Polling station ------------------------------------------------------

const pollingStation = (): CrowdDocument => {
  const b = new PlanBuilder()
  const room = b.room(0, 0, 18, 12)
  b.door(room.south, 3, 1.6)
  b.door(room.north, 15, 1.6)

  const checkIn = [5, 9].map((x, index) =>
    b.service(
      `Check-in ${index + 1}`,
      x,
      9.6,
      Math.PI,
      1,
      { kind: 'lognormal', mean: 55, sd: 20, min: 20 },
      {
        width: 1.8,
        depth: 0.8,
        queue: [
          { x, y: 8.4 },
          { x, y: 3.4 },
        ],
      },
    ),
  )
  for (const x of [5, 9]) b.place('counter-reception', x, 9.6, Math.PI)
  for (const x of [12.5, 14.0, 15.5]) {
    b.place('ballot-booth', x, 9.4, Math.PI)
    b.place('ballot-booth', x, 6.4, Math.PI)
  }
  b.place('bin', 17.0, 1.0)
  b.place('floor-sign', 3.4, 2.6, Math.PI / 4)
  b.place('barrier', 11.0, 4.6, Math.PI / 2, { size: { width: 3.2, depth: 0.12, height: 1.1 } })

  const entry = b.zone('entry', 2.2, 0.35, 3.9, 1.6, 'Entrance')
  const exit = b.zone('exit', 14.2, 10.4, 15.9, 11.7, 'Exit')
  const booths = b.zone('waypoint', 11.4, 5.4, 16.6, 10.4, 'Voting booths', {
    dwell: { kind: 'lognormal', mean: 110, sd: 45, min: 35 },
    capacity: 6,
  })

  return makeDocument('Polling station', b.build(), {
    name: 'Evening peak',
    durationS: 5400,
    seed: 1,
    speedFactor: 1,
    routing: baseRouting,
    evacuationAtS: null,
    populations: [
      population({
        name: 'Voters',
        count: 260,
        color: POPULATION_COLORS[2],
        entryIds: [entry.id],
        arrival: { kind: 'peak', startS: 0, windowS: 5400, peakAt: 0.7, spread: 0.15 },
        profileMix: [
          { profileId: 'adult', weight: 50 },
          { profileId: 'senior', weight: 28 },
          { profileId: 'hurried', weight: 12 },
          { profileId: 'wheelchair', weight: 6 },
          { profileId: 'child', weight: 4 },
        ],
        itinerary: [
          step('service', undefined, { targetIds: checkIn.map((d) => d.id) }),
          step('dwell', booths.id),
          step('exit', exit.id),
        ],
      }),
    ],
  })
}

// --- 5. Transit concourse ----------------------------------------------------

const concourse = (): CrowdDocument => {
  const b = new PlanBuilder()
  const hall = b.room(0, 0, 40, 18, { height: 5 })
  b.door(hall.west, 6, 3.0, 'opening')
  b.door(hall.west, 12, 3.0, 'opening')
  b.door(hall.east, 6, 3.0, 'opening')
  b.door(hall.east, 12, 3.0, 'opening')
  b.door(hall.south, 20, 4.0, 'opening')

  for (const x of [9, 11, 13]) b.place('kiosk', x, 16.6, Math.PI)
  for (const x of [26, 27.4, 28.8, 30.2]) b.place('turnstile', x, 9, 0)
  b.place('shelving', 20, 16.8, Math.PI, { size: { width: 4, depth: 0.6, height: 2.0 } })
  b.place('bench', 5, 3.0, 0, { size: { width: 2.4, depth: 0.45, height: 0.45 } })
  b.place('bench', 8, 3.0, 0, { size: { width: 2.4, depth: 0.45, height: 0.45 } })
  b.place('screen-tv', 20, 2.0, 0, { size: { width: 2.4, depth: 0.3, height: 2.4 } })
  b.place('column-square', 15, 9)
  b.place('column-square', 25, 9)
  b.place('bin', 35, 2)
  b.place('plant-tree', 34, 16)

  const gate = b.service(
    'Ticket gate',
    28,
    9.6,
    Math.PI,
    4,
    { kind: 'lognormal', mean: 4.5, sd: 1.6, min: 1.5 },
    {
      width: 5.2,
      depth: 0.6,
      queueSpacing: 0.55,
      queue: [
        { x: 28, y: 8.4 },
        { x: 28, y: 4.0 },
      ],
    },
  )

  const west = b.zone('entry', 0.3, 4.5, 1.8, 13.5, 'West entrance')
  const south = b.zone('entry', 18.0, 0.3, 22.0, 1.6, 'Street stair')
  const platforms = b.zone('exit', 36.0, 4.0, 39.7, 14.0, 'To platforms')
  const fromPlatforms = b.zone('entry', 36.0, 4.0, 39.7, 14.0, 'From platforms')
  const westOut = b.zone('exit', 0.3, 4.5, 1.8, 13.5, 'West exit')
  b.zone('measure', 24.0, 7.0, 32.0, 11.0, 'Gate line')
  b.zone('keep-clear', 14.0, 7.5, 16.0, 10.5, 'Around column', { cost: 3 })

  return makeDocument('Transit concourse', b.build(), {
    name: 'Peak hour, both directions',
    durationS: 1800,
    seed: 1,
    speedFactor: 1,
    routing: { ...baseRouting, congestionWeight: 0.7, routeVariety: 0.35 },
    evacuationAtS: null,
    populations: [
      population({
        name: 'Boarding',
        count: 420,
        color: POPULATION_COLORS[0],
        entryIds: [west.id, south.id],
        arrival: { kind: 'poisson', startS: 0, windowS: 1500 },
        profileMix: [
          { profileId: 'adult', weight: 46 },
          { profileId: 'hurried', weight: 30 },
          { profileId: 'luggage', weight: 14 },
          { profileId: 'senior', weight: 6 },
          { profileId: 'child', weight: 3 },
          { profileId: 'wheelchair', weight: 1 },
        ],
        itinerary: [step('service', gate.id), step('exit', platforms.id)],
      }),
      population({
        name: 'Arriving',
        count: 260,
        color: POPULATION_COLORS[1],
        entryIds: [fromPlatforms.id],
        arrival: { kind: 'waves', startS: 90, windowS: 1400, waves: 7 },
        itinerary: [step('exit', westOut.id)],
      }),
    ],
  })
}

// --- 6. Banquet hall ---------------------------------------------------------

const banquet = (): CrowdDocument => {
  const b = new PlanBuilder()
  const hall = b.room(0, 0, 28, 20)
  b.door(hall.south, 6, 2.4)
  b.door(hall.south, 22, 2.4)
  b.door(hall.east, 10, 1.6)

  b.place('stage', 14, 18.2, 0, { size: { width: 9, depth: 3.0, height: 0.6 } })
  b.place('lectern', 17.5, 18.4)
  b.place('projector-screen', 14, 19.5, 0, { size: { width: 5.5, depth: 0.2, height: 3.2 } })

  // Eight banquet rounds of ten, on a 5 m grid with a clear centre aisle.
  const seatingZone = b.zone('seating', 1.5, 3.0, 26.5, 15.5, 'Dining floor')
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 4; column++) {
      const x = 4.2 + column * 6.6
      const y = 5.0 + row * 4.8
      if (row === 1 && (column === 1 || column === 2)) continue
      b.tableWithChairs('table-round-8', x, y, 0, 'chair-stacking')
    }
  }

  const bar = b.service(
    'Bar',
    2.4,
    17.6,
    Math.PI,
    2,
    { kind: 'lognormal', mean: 34, sd: 12, min: 10 },
    {
      width: 3.4,
      depth: 0.8,
      queue: [
        { x: 2.4, y: 16.4 },
        { x: 2.4, y: 12.4 },
      ],
    },
  )
  b.place('counter-bar', 2.4, 17.6, Math.PI, { size: { width: 3.4, depth: 0.7, height: 1.1 } })
  const buffet = b.service(
    'Buffet',
    25.6,
    17.6,
    Math.PI,
    3,
    { kind: 'lognormal', mean: 46, sd: 15, min: 18 },
    {
      width: 4.0,
      depth: 0.9,
      queue: [
        { x: 25.6, y: 16.2 },
        { x: 25.6, y: 11.0 },
      ],
    },
  )
  b.place('counter-buffet', 25.6, 17.6, Math.PI, { size: { width: 4.0, depth: 0.8, height: 0.9 } })
  b.place('plant-tree', 13.5, 10.0)

  const staffStation = b.zone('waypoint', 6.0, 17.0, 11.0, 19.4, 'Service station', {
    dwell: { kind: 'uniform', mean: 300, min: 120, max: 600 },
  })
  const entry = b.zone('entry', 5.0, 0.35, 7.2, 1.8, 'Main door')
  const entryB = b.zone('entry', 21.0, 0.35, 23.2, 1.8, 'Second door')
  const exit = b.zone('exit', 5.0, 0.35, 7.2, 1.8, 'Main door (out)')
  const exitB = b.zone('exit', 21.0, 0.35, 23.2, 1.8, 'Second door (out)')
  b.zone('keep-clear', 12.6, 2.0, 15.6, 16.0, 'Service aisle', { cost: 4 })

  return makeDocument('Banquet hall', b.build(), {
    name: 'Reception, dinner, and a fire drill',
    durationS: 5400,
    seed: 1,
    speedFactor: 1,
    routing: baseRouting,
    evacuationAtS: 3600,
    populations: [
      population({
        name: 'Guests',
        count: 220,
        color: POPULATION_COLORS[3],
        entryIds: [entry.id, entryB.id],
        arrival: { kind: 'peak', startS: 0, windowS: 1800, peakAt: 0.45, spread: 0.2 },
        groupSize: { min: 2, max: 5 },
        itinerary: [
          step('service', bar.id, { probability: 0.75 }),
          step('service', buffet.id),
          step('seat', seatingZone.id, {
            duration: { kind: 'normal', mean: 2400, sd: 400, min: 900 },
          }),
          step('exit', exit.id),
        ],
      }),
      population({
        name: 'Staff',
        count: 14,
        color: POPULATION_COLORS[5],
        entryIds: [entryB.id],
        arrival: { kind: 'all-at-once', startS: 0, windowS: 0 },
        profileMix: [{ profileId: 'staff', weight: 1 }],
        itinerary: [
          step('dwell', staffStation.id, {
            duration: { kind: 'uniform', mean: 240, min: 90, max: 480 },
          }),
          step('goto', seatingZone.id),
          step('dwell', staffStation.id, {
            duration: { kind: 'uniform', mean: 240, min: 90, max: 480 },
          }),
          step('exit', exitB.id),
        ],
      }),
    ],
  })
}

export const TEMPLATES: Template[] = [
  {
    id: 'coffee-bar',
    name: 'Coffee bar',
    summary: 'A 14 × 10 m café with a two-server bar and a queue that folds around the room.',
    teaches: 'How a single counter becomes the constraint, and what a third barista buys you.',
    build: coffeeBar,
  },
  {
    id: 'conference',
    name: 'Conference registration',
    summary: 'A 30 × 20 m foyer with four registration desks feeding a 300-seat session room.',
    teaches:
      'Queue balancing across parallel desks, and the doorway surge when the session starts.',
    build: conference,
  },
  {
    id: 'gallery',
    name: 'Gallery opening',
    summary: 'A partitioned gallery with a drinks bar and three hanging walls to work around.',
    teaches: 'Dwell behaviour, route variety, and where a crowd pools when nobody is in a hurry.',
    build: gallery,
  },
  {
    id: 'polling-station',
    name: 'Polling station',
    summary: 'Two check-in desks, six booths, and an accessible route from door to exit.',
    teaches: 'Service capacity against an evening peak, with an older and less mobile population.',
    build: pollingStation,
  },
  {
    id: 'concourse',
    name: 'Transit concourse',
    summary: 'A 40 × 18 m hall with four ticket gates and trains arriving in waves.',
    teaches: 'Counterflow, lane formation, and gate throughput under a wave of arrivals.',
    build: concourse,
  },
  {
    id: 'banquet',
    name: 'Banquet hall',
    summary: 'Ten banquet rounds, a bar, a buffet, and an unannounced evacuation at one hour.',
    teaches: 'Seated occupancy, buffet queueing, and how long a seated room takes to clear.',
    build: banquet,
  },
]

export const getTemplate = (id: string): Template | undefined => TEMPLATES.find((t) => t.id === id)

export const DEFAULT_TEMPLATE_ID = 'coffee-bar'
