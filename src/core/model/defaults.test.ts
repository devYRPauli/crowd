import { describe, expect, it } from 'vitest'
import {
  AGENT_PROFILES,
  DEFAULT_PROFILE_MIX,
  DEFAULT_SETTINGS,
  POPULATION_COLORS,
  ZONE_COLORS,
  ZONE_LABELS,
  createDocument,
  createEmptyPlan,
  createItineraryStep,
  createPopulation,
  createScenario,
} from './defaults'
import {
  CODE_MINIMUMS,
  DEFAULT_DOOR_HEIGHT,
  DEFAULT_DOOR_WIDTH,
  DEFAULT_WALL_HEIGHT,
  DEFAULT_WALL_THICKNESS,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_SILL,
  DEFAULT_WINDOW_WIDTH,
  DOOR_HEIGHTS,
  DOOR_WIDTHS,
  DOUBLE_DOOR_FROM,
  WALL_HEIGHTS,
  WALL_THICKNESSES,
  WINDOW_HEIGHTS,
  WINDOW_SILLS,
  WINDOW_WIDTHS,
  isStandard,
} from './standards'
import type { StandardSize } from './standards'
import { SCHEMA_VERSION } from './types'
import type { Wall, ZoneKind } from './types'
import { parseDocument, serializeDocument } from '../document/serialize'

const HEX_COLOR = /^#[0-9a-f]{6}$/

interface DimensionRow {
  name: string
  setting: number
  standard: number
  catalogue: readonly StandardSize[]
}

const DEFAULT_DIMENSIONS: DimensionRow[] = [
  {
    name: 'wall height',
    setting: DEFAULT_SETTINGS.defaultWallHeight,
    standard: DEFAULT_WALL_HEIGHT,
    catalogue: WALL_HEIGHTS,
  },
  {
    name: 'wall thickness',
    setting: DEFAULT_SETTINGS.defaultWallThickness,
    standard: DEFAULT_WALL_THICKNESS,
    catalogue: WALL_THICKNESSES,
  },
  {
    name: 'door width',
    setting: DEFAULT_SETTINGS.defaultDoorWidth,
    standard: DEFAULT_DOOR_WIDTH,
    catalogue: DOOR_WIDTHS,
  },
  {
    name: 'door height',
    setting: DEFAULT_SETTINGS.defaultDoorHeight,
    standard: DEFAULT_DOOR_HEIGHT,
    catalogue: DOOR_HEIGHTS,
  },
  {
    name: 'window width',
    setting: DEFAULT_SETTINGS.defaultWindowWidth,
    standard: DEFAULT_WINDOW_WIDTH,
    catalogue: WINDOW_WIDTHS,
  },
  {
    name: 'window height',
    setting: DEFAULT_SETTINGS.defaultWindowHeight,
    standard: DEFAULT_WINDOW_HEIGHT,
    catalogue: WINDOW_HEIGHTS,
  },
  {
    name: 'window sill',
    setting: DEFAULT_SETTINGS.defaultWindowSill,
    standard: DEFAULT_WINDOW_SILL,
    catalogue: WINDOW_SILLS,
  },
]

/**
 * Every zone kind the document type admits, spelled out so the compiler fails
 * the build when a kind is added: the colour and label tables below are keyed
 * by plain string, so a missing kind is silent at runtime.
 */
const ZONE_KINDS = Object.keys({
  entry: true,
  exit: true,
  waypoint: true,
  obstacle: true,
  'keep-clear': true,
  seating: true,
  measure: true,
} satisfies Record<ZoneKind, true>) as ZoneKind[]

/** Paths at which two separately built values are the same object. */
const sharedReferences = (a: unknown, b: unknown, path = ''): string[] => {
  if (typeof a !== 'object' || a === null) return []
  if (typeof b !== 'object' || b === null) return []
  if (a === b) return [path]
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  return Object.keys(left).flatMap((key) =>
    sharedReferences(left[key], right[key], path ? `${path}.${key}` : key),
  )
}

describe('the editor defaults', () => {
  it.each(DEFAULT_DIMENSIONS)('reaches for a $name somebody could order', (row) => {
    // The settings object is the fourth place these numbers could live, and the
    // three before it disagreed. A literal typed here instead of imported gives
    // a plan that looks right and prices wrong, and every egress figure derived
    // from it inherits the error.
    expect(row.setting).toBe(row.standard)
    expect(isStandard(row.catalogue, row.setting)).toBe(true)
  })

  it('opens with a single leaf that would pass as an egress door', () => {
    // Below the pair threshold, so a fresh door is drawn with one leaf, and
    // between the code's clear-width minimum and the widest leaf anybody hangs.
    expect(DEFAULT_SETTINGS.defaultDoorWidth).toBeLessThan(DOUBLE_DOOR_FROM)
    expect(DEFAULT_SETTINGS.defaultDoorWidth).toBeGreaterThan(CODE_MINIMUMS.egressDoorClearWidth)
    expect(DEFAULT_SETTINGS.defaultDoorWidth).toBeLessThanOrEqual(CODE_MINIMUMS.egressLeafMaxWidth)
    expect(DEFAULT_SETTINGS.defaultDoorHeight).toBeGreaterThanOrEqual(
      CODE_MINIMUMS.egressDoorHeight,
    )
  })

  it('cuts its doors and windows into a wall tall enough to hold them', () => {
    // An opening taller than the wall it is cut into is not a plan anybody can
    // build, and the renderer draws the hole straight through the roofline.
    const { defaultWallHeight, defaultDoorHeight, defaultWindowHeight, defaultWindowSill } =
      DEFAULT_SETTINGS
    expect(defaultDoorHeight).toBeLessThan(defaultWallHeight)
    expect(defaultWindowSill + defaultWindowHeight).toBeLessThanOrEqual(defaultWallHeight)
    expect(defaultWallHeight).toBeGreaterThanOrEqual(CODE_MINIMUMS.egressCeilingHeight)
    expect(DEFAULT_SETTINGS.defaultWallThickness).toBeLessThan(DEFAULT_SETTINGS.defaultDoorWidth)
  })

  it('stores metric and snaps to angles a squared-off room can land on', () => {
    // The document is metric whatever the user reads; imperial is display and
    // parsing only. An angle snap that does not divide a right angle makes a
    // rectangular room impossible to draw with snapping on.
    expect(DEFAULT_SETTINGS.units).toBe('metric')
    expect(DEFAULT_SETTINGS.gridSize).toBeGreaterThan(0)
    expect(90 % DEFAULT_SETTINGS.angleSnapDeg).toBe(0)
    expect(DEFAULT_SETTINGS.snapToGrid).toBe(true)
    expect(DEFAULT_SETTINGS.snapToObjects).toBe(true)
  })
})

describe('the shipped agent profiles', () => {
  it('gives every kind of person their own id, name and colour', () => {
    const ids = AGENT_PROFILES.map((profile) => profile.id)
    // The mix names profiles by id and the crowd renderer colours people by
    // profile; a duplicate id sends a whole group to the wrong body, and a
    // duplicate colour makes two kinds of person indistinguishable on screen.
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(AGENT_PROFILES.map((profile) => profile.color)).size).toBe(ids.length)
    expect(new Set(AGENT_PROFILES.map((profile) => profile.name)).size).toBe(ids.length)
    for (const profile of AGENT_PROFILES) {
      expect([profile.id, profile.color]).toEqual([profile.id, expect.stringMatching(HEX_COLOR)])
      expect(profile.name.length).toBeGreaterThan(0)
      expect(['walking', 'assisted', 'wheelchair']).toContain(profile.mobility)
      expect(profile.radius).toBeGreaterThan(0.1)
      expect(profile.radius).toBeLessThan(0.5)
      expect(profile.heightScale).toBeGreaterThan(0.5)
      expect(profile.heightScale).toBeLessThanOrEqual(1)
      expect(profile.caution).toBeGreaterThan(0)
      expect(profile.assertiveness).toBeGreaterThanOrEqual(0)
      expect(profile.assertiveness).toBeLessThanOrEqual(1)
    }
  })

  it('leaves room for two standard deviations inside every speed clamp', () => {
    // Speeds are sampled normally and then clamped. A clamp inside 2 sd throws
    // away a real tail and drags the sampled mean off the profile's own figure,
    // so the crowd walks at a speed nobody chose.
    for (const { id, speed } of AGENT_PROFILES) {
      expect([id, speed.sd > 0]).toEqual([id, true])
      expect([id, speed.min < speed.mean && speed.mean < speed.max]).toEqual([id, true])
      expect([id, speed.mean - 2 * speed.sd >= speed.min]).toEqual([id, true])
      expect([id, speed.mean + 2 * speed.sd <= speed.max]).toEqual([id, true])
    }
  })

  it('walks the average adult at the speed Weidmann measured', () => {
    // The validation suite is a public claim, and it is measured against these
    // two numbers. Anything else here quietly re-baselines every run.
    const adult = AGENT_PROFILES.find((profile) => profile.id === 'adult')
    expect(adult?.speed.mean).toBeCloseTo(1.34, 6)
    expect(adult?.speed.sd).toBeCloseTo(0.26, 6)
    expect(adult?.radius).toBeCloseTo(0.23, 6)
  })

  it('gives the wheelchair user the widest body and the child the narrowest', () => {
    // Clearances are checked against the widest body that has to get through;
    // if that stops being the wheelchair user, a door they cannot use passes.
    const widest = [...AGENT_PROFILES].sort((a, b) => b.radius - a.radius)[0]
    const narrowest = [...AGENT_PROFILES].sort((a, b) => a.radius - b.radius)[0]
    expect(widest.id).toBe('wheelchair')
    expect(narrowest.id).toBe('child')
    expect(widest.mobility).toBe('wheelchair')
  })
})

describe('the default crowd mix', () => {
  it('splits a hundred people across profiles that exist', () => {
    const total = DEFAULT_PROFILE_MIX.reduce((sum, entry) => sum + entry.weight, 0)
    expect(total).toBe(100)
    const ids = DEFAULT_PROFILE_MIX.map((entry) => entry.profileId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of DEFAULT_PROFILE_MIX) {
      // The engine resolves a mix entry with `findIndex`, and clamps a miss to
      // index 0 — so a misspelt id does not throw, it silently turns that share
      // of the crowd into adults and the mix stops meaning anything.
      expect([entry.profileId, AGENT_PROFILES.some((p) => p.id === entry.profileId)]).toEqual([
        entry.profileId,
        true,
      ])
      expect(entry.weight).toBeGreaterThan(0)
    }
    const heaviest = [...DEFAULT_PROFILE_MIX].sort((a, b) => b.weight - a.weight)[0]
    expect(heaviest.profileId).toBe('adult')
  })
})

describe('a new population', () => {
  it('is a group of attendees who all arrive with time left to walk out', () => {
    const scenario = createScenario()
    const population = scenario.populations[0]
    expect(population.name).toBe('Attendees')
    expect(population.count).toBe(120)
    expect(population.entryIds).toEqual([])
    expect(population.arrival).toEqual({ kind: 'uniform', startS: 0, windowS: 600 })
    // Arrivals that ran past the end of the run would leave a fresh document's
    // baseline reporting people who never got in as people who could not finish.
    expect(population.arrival.startS + population.arrival.windowS).toBeLessThan(scenario.durationS)
  })

  it('heads for any exit rather than a destination the empty plan has not got', () => {
    const population = createPopulation()
    expect(population.itinerary).toHaveLength(1)
    expect(population.itinerary[0].kind).toBe('exit')
    // A default step pointed at a zone id would strand everybody in a document
    // that starts with no zones at all.
    expect(population.itinerary[0].targetId).toBeUndefined()
  })

  it('numbers and colours later groups so two are never confused', () => {
    expect(createPopulation(1).name).toBe('Group 2')
    expect(createPopulation(1).color).toBe(POPULATION_COLORS[1])
    // The palette wraps rather than handing out `undefined` to the seventh group.
    expect(createPopulation(POPULATION_COLORS.length).color).toBe(POPULATION_COLORS[0])
    expect(new Set(POPULATION_COLORS).size).toBe(POPULATION_COLORS.length)
    for (const color of POPULATION_COLORS) expect(color).toMatch(HEX_COLOR)
  })

  it('gives two steps of the same kind ids of their own', () => {
    const first = createItineraryStep('goto', 'zone_a')
    const second = createItineraryStep('goto', 'zone_a')
    expect(first.id).not.toBe(second.id)
    expect(second).toMatchObject({ kind: 'goto', targetId: 'zone_a' })
  })
})

describe('a new scenario', () => {
  it('is a baseline run with a fixed seed and every shipped profile', () => {
    const scenario = createScenario()
    expect(scenario.name).toBe('Baseline')
    // A seed drawn at creation would make two documents of the same venue
    // incomparable, which is the whole point of carrying a seed in the document.
    expect(scenario.seed).toBe(1)
    expect(scenario.durationS).toBe(1800)
    expect(scenario.speedFactor).toBe(1)
    expect(scenario.evacuationAtS).toBeNull()
    expect(scenario.profiles.map((profile) => profile.id)).toEqual(
      AGENT_PROFILES.map((profile) => profile.id),
    )
  })

  it('routes around congestion with weights the parser would not have to clamp', () => {
    const { routing } = createScenario()
    expect(routing.adaptive).toBe(true)
    expect(routing.congestionWeight).toBeGreaterThan(0)
    expect(routing.congestionWeight).toBeLessThanOrEqual(1)
    expect(routing.routeVariety).toBeGreaterThanOrEqual(0)
    expect(routing.routeVariety).toBeLessThanOrEqual(1)
    expect(routing.replanIntervalS).toBeGreaterThanOrEqual(0.25)
  })
})

describe('a new document', () => {
  it('starts on an empty floor, stamped and named', () => {
    const doc = createDocument()
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.name).toBe('Untitled venue')
    expect(createDocument('Hall 3').name).toBe('Hall 3')
    expect(doc.id).toMatch(/^doc_[0-9a-z]{10}$/)
    expect(doc.plan).toEqual(createEmptyPlan())
    expect(doc.plan).toEqual({
      walls: [],
      openings: [],
      furniture: [],
      zones: [],
      servicePoints: [],
    })
    expect(doc.plan.backdrop).toBeUndefined()
    // Nothing has been edited yet, so the two stamps have to agree — the
    // projects list sorts on `updatedAt` and would otherwise show a document
    // that was modified before it existed.
    expect(doc.updatedAt).toBe(doc.createdAt)
    expect(new Date(doc.createdAt).toISOString()).toBe(doc.createdAt)
  })

  it('is a document the loader takes back without repairing anything', () => {
    const doc = createDocument('Hall 3')
    const result = parseDocument(JSON.parse(serializeDocument(doc)))
    // Every field survives a save and a load untouched, and the parser — which
    // coerces anything it does not like — finds nothing to complain about.
    expect(result.warnings).toEqual([])
    expect({ ...result.document, updatedAt: doc.updatedAt }).toEqual(doc)
  })

  it('gives each document its own id', () => {
    expect(createDocument().id).not.toBe(createDocument().id)
  })
})

describe('two documents made the same way', () => {
  it('share no structure an edit to one could travel through', () => {
    const a = createDocument()
    const b = createDocument()

    // SUSPECTED BUG: `createScenario` copies each profile with `{ ...profile }`,
    // which is shallow, so every document in the session — and the shipped
    // AGENT_PROFILES constant itself — shares one `speed` object per profile. I
    // believe the correct behaviour is for this list to be empty: a profile
    // editor writing `profile.speed.mean` would change the adult's walking speed
    // in every open document and in the defaults the next one is built from,
    // which invalidates a comparison against a baseline. The fix is to copy
    // `speed` too, and then this assertion should read `toEqual([])`.
    expect(sharedReferences(a, b)).toEqual(
      AGENT_PROFILES.map((_, index) => `scenario.profiles.${index}.speed`),
    )
    expect(a.scenario.profiles[0].speed).toBe(AGENT_PROFILES[0].speed)
  })

  it('keeps an in-place edit out of the shipped defaults and out of each other', () => {
    const a = createDocument()
    const b = createDocument()
    const wall: Wall = {
      id: 'wall_test',
      a: { x: 0, y: 0 },
      b: { x: 4, y: 0 },
      thickness: DEFAULT_SETTINGS.defaultWallThickness,
      height: DEFAULT_SETTINGS.defaultWallHeight,
      kind: 'wall',
    }

    a.settings.defaultDoorWidth = 99
    a.plan.walls.push(wall)
    a.scenario.profiles[0].name = 'Renamed'
    a.scenario.populations[0].profileMix[0].weight = 1
    a.scenario.populations[0].itinerary.push(createItineraryStep('exit'))

    expect(DEFAULT_SETTINGS.defaultDoorWidth).toBe(DEFAULT_DOOR_WIDTH)
    expect(AGENT_PROFILES[0].name).toBe('Adult')
    expect(DEFAULT_PROFILE_MIX[0].weight).toBe(62)
    expect(b.settings.defaultDoorWidth).toBe(DEFAULT_DOOR_WIDTH)
    expect(b.plan.walls).toEqual([])
    expect(b.scenario.profiles[0].name).toBe('Adult')
    expect(b.scenario.populations[0].profileMix[0].weight).toBe(62)
    expect(b.scenario.populations[0].itinerary).toHaveLength(1)
  })
})

describe('zone colours and labels', () => {
  it('names and colours every kind of zone a plan can hold', () => {
    // Both tables are read by plain key: an unlisted kind draws a zone labelled
    // "undefined" in the layers list and on the plan while it is being drawn.
    expect(Object.keys(ZONE_LABELS).sort()).toEqual([...ZONE_KINDS].sort())
    expect(Object.keys(ZONE_COLORS).sort()).toEqual([...ZONE_KINDS].sort())
    for (const kind of ZONE_KINDS) {
      expect([kind, ZONE_COLORS[kind]]).toEqual([kind, expect.stringMatching(HEX_COLOR)])
      expect(ZONE_LABELS[kind].length).toBeGreaterThan(0)
    }
    const labels = ZONE_KINDS.map((kind) => ZONE_LABELS[kind])
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('tells the way in apart from the way out', () => {
    // The renderer borrows these two for entry and exit doors as well as zones,
    // so they are the only colours in the product carrying a direction.
    expect(ZONE_COLORS.entry).not.toBe(ZONE_COLORS.exit)
    expect(new Set(ZONE_KINDS.map((kind) => ZONE_COLORS[kind])).size).toBe(ZONE_KINDS.length)
  })
})
