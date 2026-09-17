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
import type { AgentProfile, Wall, ZoneKind } from './types'
import { parseDocument, serializeDocument } from '../document/serialize'

const HEX_COLOR = /^#[0-9a-f]{6}$/

const MOBILITIES: AgentProfile['mobility'][] = ['walking', 'assisted', 'wheelchair']

/** The ids of the profiles that fail a check, so a failure names the culprit. */
const profilesFailing = (predicate: (profile: AgentProfile) => boolean): string[] =>
  AGENT_PROFILES.filter(predicate).map((profile) => profile.id)

const profile = (id: string): AgentProfile => {
  const found = AGENT_PROFILES.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`No profile called ${id}`)
  return found
}

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
    // A wall thicker than the door is wide is a tunnel, and the opening tool
    // has nowhere to put the jambs.
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
  it('keeps the roster of people a saved document refers to by id', () => {
    // A profile id is written into every `.crowd.json` as the key of a mix
    // entry, so the list is a file-format contract. The engine resolves a miss
    // to index 0: rename one and that share of every saved crowd silently
    // becomes adults.
    expect(AGENT_PROFILES.map((p) => p.id)).toEqual([
      'adult',
      'hurried',
      'senior',
      'child',
      'wheelchair',
      'staff',
      'luggage',
    ])
    expect(new Set(AGENT_PROFILES.map((p) => p.name)).size).toBe(AGENT_PROFILES.length)
    // The crowd is drawn coloured by profile, so two profiles sharing a colour
    // are two kinds of person nobody can tell apart in the viewport.
    expect(new Set(AGENT_PROFILES.map((p) => p.color)).size).toBe(AGENT_PROFILES.length)
    expect(profilesFailing((p) => !HEX_COLOR.test(p.color))).toEqual([])
    expect(profilesFailing((p) => !MOBILITIES.includes(p.mobility))).toEqual([])
    // Height scales the rendered character against the reference adult, so
    // nobody is drawn taller than one; caution multiplies the avoidance time
    // horizon, and at zero people walk through each other.
    expect(profilesFailing((p) => p.heightScale <= 0 || p.heightScale > 1)).toEqual([])
    expect(profilesFailing((p) => p.caution <= 0)).toEqual([])
    expect(profilesFailing((p) => p.assertiveness < 0 || p.assertiveness > 1)).toEqual([])
  })

  it('fits its widest body through the narrowest door the code allows', () => {
    const widest = [...AGENT_PROFILES].sort((a, b) => b.radius - a.radius)[0]
    const narrowest = [...AGENT_PROFILES].sort((a, b) => a.radius - b.radius)[0]
    expect([widest.id, narrowest.id]).toEqual(['wheelchair', 'child'])
    expect(widest.mobility).toBe('wheelchair')
    // Clearances are judged against the widest body that has to get through. If
    // that body no longer fits a code-minimum opening, a venue that passes
    // every compliance check still deadlocks at its own front door.
    expect(2 * widest.radius).toBeLessThan(CODE_MINIMUMS.egressDoorClearWidth)
    expect(2 * widest.radius).toBeLessThan(DEFAULT_SETTINGS.defaultDoorWidth)
    expect(narrowest.radius).toBeGreaterThan(0)
  })

  it('leaves room for two standard deviations inside every speed clamp', () => {
    // Speeds are sampled normally and then clamped. A clamp inside 2 sd throws
    // away a real tail and drags the sampled mean off the profile's own figure,
    // so the crowd walks at a speed nobody chose.
    expect(profilesFailing(({ speed }) => !(speed.sd > 0))).toEqual([])
    expect(
      profilesFailing(({ speed }) => !(speed.min < speed.mean && speed.mean < speed.max)),
    ).toEqual([])
    expect(profilesFailing(({ speed }) => speed.mean - 2 * speed.sd < speed.min)).toEqual([])
    expect(profilesFailing(({ speed }) => speed.mean + 2 * speed.sd > speed.max)).toEqual([])
  })

  it('walks the average adult at the speed Weidmann measured', () => {
    // The validation suite is a public claim, and it is measured against these
    // two numbers. Anything else here quietly re-baselines every run.
    const adult = profile('adult')
    expect(adult.speed.mean).toBeCloseTo(1.34, 6)
    expect(adult.speed.sd).toBeCloseTo(0.26, 6)
    expect(adult.radius).toBeCloseTo(0.23, 6)
    // Every other profile is described relative to this one; a hurried walker
    // slower than the average adult would make the label a lie.
    expect(profile('hurried').speed.mean).toBeGreaterThan(adult.speed.mean)
    expect(profile('senior').speed.mean).toBeLessThan(adult.speed.mean)
  })
})

describe('the default crowd mix', () => {
  it('splits a hundred people across profiles that exist', () => {
    const total = DEFAULT_PROFILE_MIX.reduce((sum, entry) => sum + entry.weight, 0)
    expect(total).toBe(100)
    const ids = DEFAULT_PROFILE_MIX.map((entry) => entry.profileId)
    expect(new Set(ids).size).toBe(ids.length)
    // The engine resolves a mix entry with `findIndex` and clamps a miss to
    // index 0 — so a misspelt id does not throw, it silently turns that share
    // of the crowd into adults and the mix stops meaning anything.
    expect(ids.filter((id) => !AGENT_PROFILES.some((p) => p.id === id))).toEqual([])
    expect(DEFAULT_PROFILE_MIX.filter((entry) => !(entry.weight > 0))).toEqual([])
    const heaviest = [...DEFAULT_PROFILE_MIX].sort((a, b) => b.weight - a.weight)[0]
    expect(heaviest.profileId).toBe('adult')
  })

  it('puts somebody in a wheelchair in every crowd the editor opens with', () => {
    // The widest body is the one that finds a door too narrow or a queue lane
    // too tight. Drop it from the default mix and the first run of a new venue
    // reports clearances nobody in it was ever wide enough to test.
    const wheelchair = DEFAULT_PROFILE_MIX.find((entry) => entry.profileId === 'wheelchair')
    expect(wheelchair?.weight).toBeGreaterThan(0)
  })
})

describe('a new population', () => {
  it('is a group of attendees who all arrive with time left to walk out', () => {
    const scenario = createScenario()
    const population = scenario.populations[0]
    expect(population.name).toBe('Attendees')
    expect(population.count).toBe(120)
    // An empty entry list means every entry in the plan, which is the only
    // thing a document with no zones drawn yet can mean.
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
    expect(createPopulation(POPULATION_COLORS.length).name).toBe('Group 7')
    expect(createPopulation(POPULATION_COLORS.length).color).toBe(POPULATION_COLORS[0])
    expect(new Set(POPULATION_COLORS).size).toBe(POPULATION_COLORS.length)
    expect(POPULATION_COLORS.filter((color) => !HEX_COLOR.test(color))).toEqual([])
    expect(createPopulation(1).id).not.toBe(createPopulation(1).id)
  })

  it('gives two steps of the same kind ids of their own', () => {
    const first = createItineraryStep('goto', 'zone_a')
    const second = createItineraryStep('goto', 'zone_a')
    expect(first.id).not.toBe(second.id)
    // Nothing beyond the three fields: a step carries its optional duration and
    // probability only once somebody sets them, and the loader drops the keys
    // it does not find rather than inventing defaults for them.
    expect(second).toEqual({ id: second.id, kind: 'goto', targetId: 'zone_a' })
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
    // Field for field, not just id for id: the scenario copies the shipped
    // profiles, and a copy that dropped a field would leave the engine sampling
    // a speed or a radius of `undefined`.
    expect(scenario.profiles).toEqual(AGENT_PROFILES)
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
    expect(doc.plan).toEqual({
      walls: [],
      openings: [],
      furniture: [],
      zones: [],
      servicePoints: [],
    })
    expect(doc.plan.backdrop).toBeUndefined()
    // Every document gets its own arrays; a shared empty one would collect the
    // walls of every venue opened in the session.
    expect(createEmptyPlan().walls).not.toBe(doc.plan.walls)
    // Nothing has been edited yet, so the two stamps have to agree — the
    // projects list sorts on `updatedAt` and would otherwise show a document
    // that was modified before it existed.
    expect(doc.updatedAt).toBe(doc.createdAt)
    expect(new Date(doc.createdAt).toISOString()).toBe(doc.createdAt)
  })

  it('is a document the loader takes back without repairing anything', () => {
    const doc = createDocument('Hall 3')
    const result = parseDocument(JSON.parse(serializeDocument(doc)))
    // The parser coerces everything it does not like — clamping a speed, a
    // radius or a routing weight into range without a word — so a fresh
    // document that comes back unchanged is the proof that every number shipped
    // here is one the loader accepts as it stands.
    expect(result.warnings).toEqual([])
    // `updatedAt` is the one field a load is meant to move: opening a file
    // stamps it. Everything else, `createdAt` included, is the file's.
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

    // A shallow `{ ...profile }` copied everything but the one nested object a
    // profile has, so every document's speeds were the shipped defaults' own
    // objects: an editor writing `profile.speed.mean` in place would have moved
    // the adult's walking speed in every open venue and in the next document
    // built, which is exactly the baseline a seeded comparison rests on.
    expect(sharedReferences(a, b)).toEqual([])
    expect(a.scenario.profiles[0].speed).not.toBe(AGENT_PROFILES[0].speed)
    expect(a.scenario.profiles[0].speed).toEqual(AGENT_PROFILES[0].speed)
    // Only this path is fixed. A document built from a template
    // (templates.ts:46) or handed back by the loader (serialize.ts:347) — which
    // between them is most documents — still copies the profiles shallowly and
    // shares one `speed` object with the constants and with each other.
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
    // The one nested object a profile owns. Nothing in the product writes to it
    // today — the engine only reads it (engine.ts:535) and there is no profile
    // editor yet — so this is the guard that makes adding one safe rather than a
    // regression test for a bug users have hit. A shallow copy left it pointing
    // at the shipped adult, so the first in-place write would move one venue's
    // walking speed in every venue, and in the baseline a seeded comparison is
    // measured against.
    a.scenario.profiles[0].speed.mean = 0.4
    a.scenario.populations[0].profileMix[0].weight = 1
    a.scenario.populations[0].itinerary.push(createItineraryStep('exit'))

    expect(DEFAULT_SETTINGS.defaultDoorWidth).toBe(DEFAULT_DOOR_WIDTH)
    expect(AGENT_PROFILES[0].name).toBe('Adult')
    expect(AGENT_PROFILES[0].speed.mean).toBeCloseTo(1.34, 6)
    expect(DEFAULT_PROFILE_MIX[0].weight).toBe(62)
    expect(b.settings.defaultDoorWidth).toBe(DEFAULT_DOOR_WIDTH)
    expect(b.plan.walls).toEqual([])
    expect(b.scenario.profiles[0].name).toBe('Adult')
    expect(b.scenario.profiles[0].speed.mean).toBeCloseTo(1.34, 6)
    expect(b.scenario.populations[0].profileMix[0].weight).toBe(62)
    expect(b.scenario.populations[0].itinerary).toHaveLength(1)
    // The venue that was edited keeps the edit; the copy is not a freeze.
    expect(a.scenario.profiles[0].speed.mean).toBeCloseTo(0.4, 6)
  })
})

describe('zone colours and labels', () => {
  it('names and colours every kind of zone a plan can hold', () => {
    // The tables are keyed by plain string, so an unlisted kind is only found
    // at runtime: the draw tool names the zone it just created `undefined 1`
    // and labels the outline the same while it is being dragged.
    expect(Object.keys(ZONE_LABELS).sort()).toEqual([...ZONE_KINDS].sort())
    expect(Object.keys(ZONE_COLORS).sort()).toEqual([...ZONE_KINDS].sort())
    expect(ZONE_KINDS.filter((kind) => !HEX_COLOR.test(ZONE_COLORS[kind]))).toEqual([])
    expect(ZONE_KINDS.filter((kind) => ZONE_LABELS[kind].length === 0)).toEqual([])
    const labels = ZONE_KINDS.map((kind) => ZONE_LABELS[kind])
    expect(new Set(labels).size).toBe(labels.length)
    expect(new Set(ZONE_KINDS.map((kind) => ZONE_COLORS[kind])).size).toBe(ZONE_KINDS.length)
  })

  it('tells the way in apart from the way out', () => {
    // The renderer reaches into this table for entry and exit doors as well as
    // zones, so these two are the only colours in the product that carry a
    // direction: match them and a plan stops saying which way people go.
    expect(ZONE_COLORS.entry).not.toBe(ZONE_COLORS.exit)
  })
})
