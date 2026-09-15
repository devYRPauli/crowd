import { describe, expect, it } from 'vitest'
import { documentFileName, parseDocument, parseDocumentJson, serializeDocument } from './serialize'
import {
  DEFAULT_SETTINGS,
  createDocument,
  createPopulation,
  createScenario,
} from '../model/defaults'
import { SCHEMA_VERSION } from '../model/types'
import type { CrowdDocument } from '../model/types'
import { PlanBuilder, step } from '../../library/planBuilder'
import { getTemplate } from '../../library/templates'

const reload = (doc: CrowdDocument) => parseDocumentJson(serializeDocument(doc))

/**
 * A venue that carries every optional field the parser is allowed to omit.
 *
 * The round trip is only interesting where a field may legitimately be absent:
 * anything the parser rebuilds unconditionally cannot be lost, but an optional
 * one is dropped by forgetting a single spread.
 */
const loadedVenue = (): CrowdDocument => {
  const b = new PlanBuilder()
  const room = b.room(0, 0, 12, 8, { height: 3.2, kind: 'glass', color: '#8899aa', locked: true })
  const doors = b.door(room.south, 3, 1.83, 'door', 'both')
  b.window(room.west, 2.5)
  b.place('chair', 5, 5, Math.PI / 3, {
    name: 'The wobbly one',
    color: '#ff0000',
    locked: true,
    blocking: false,
    size: { width: 0.5, depth: 0.5, height: 0.9 },
  })
  const bar = b.zone('waypoint', 2, 2, 5, 4, 'Bar', {
    cost: 3,
    capacity: 12,
    locked: true,
    dwell: { kind: 'lognormal', mean: 90, sd: 30, min: 20, max: 400 },
  })
  const desk = b.service(
    'Desk',
    8,
    6,
    Math.PI,
    2,
    { kind: 'uniform', mean: 30, min: 10, max: 60 },
    {
      queue: [
        { x: 8, y: 5 },
        { x: 8, y: 3 },
      ],
      color: '#00ff00',
      locked: true,
      opensAt: 60,
      closesAt: 1800,
    },
  )

  return {
    ...createDocument('Dockside hall'),
    plan: {
      ...b.build(),
      backdrop: {
        src: 'data:image/png;base64,iVBORw0KGgo=',
        position: { x: 6, y: 4 },
        rotation: 0.25,
        width: 24,
        depth: 16,
        opacity: 0.35,
        visible: false,
        locked: true,
      },
    },
    scenario: {
      ...createScenario(),
      populations: [
        {
          ...createPopulation(0),
          entryIds: [doors.id],
          groupSize: { min: 2, max: 4 },
          arrival: { kind: 'waves', startS: 30, windowS: 900, waves: 3 },
          itinerary: [
            step('service', undefined, { targetIds: [desk.id], probability: 0.6, label: 'Ticket' }),
            step('dwell', bar.id, { duration: { kind: 'uniform', mean: 120, min: 60, max: 300 } }),
            step('exit', doors.id),
          ],
        },
      ],
      evacuationAtS: 600,
    },
  }
}

describe('saving and reloading a document', () => {
  it('brings a starter venue back as the same venue', () => {
    const original = getTemplate('coffee-bar')!.build()
    const { document, warnings } = reload(original)

    expect(warnings).toEqual([])
    expect(document.plan).toEqual(original.plan)
    expect(document.scenario).toEqual(original.scenario)
    expect(document.settings).toEqual(original.settings)
    expect(document.id).toBe(original.id)
    expect(document.name).toBe(original.name)
  })

  it('keeps the optional fields a lazy parser would quietly drop', () => {
    const original = loadedVenue()
    const { document, warnings } = reload(original)

    expect(warnings).toEqual([])
    expect(document.plan).toEqual(original.plan)
    expect(document.scenario).toEqual(original.scenario)
    // `false` is the value a defaulting parser loses, and both of these default
    // to `true`: lose them and a traced backdrop reappears over the plan, and a
    // prop people were meant to walk through becomes an obstacle.
    expect(document.plan.backdrop?.visible).toBe(false)
    expect(document.plan.furniture[0].blocking).toBe(false)
  })

  it('keeps when the venue was made and restamps when it was saved', () => {
    const made = '2021-03-04T09:00:00.000Z'
    const { document } = reload({ ...loadedVenue(), createdAt: made, updatedAt: made })

    expect(document.createdAt).toBe(made)
    // `listProjects` orders the project list by `updatedAt`, so a reload that
    // carried the old stamp over would sort a just-opened venue as stale.
    expect(Date.parse(document.updatedAt)).toBeGreaterThan(Date.parse(made))
  })
})

describe('doors marked as ways in and out', () => {
  it('survives a round trip, and an unmarked door stays unmarked', () => {
    const b = new PlanBuilder()
    const room = b.room(0, 0, 12, 8)
    const entry = b.door(room.south, 3, 1.0, 'door', 'entry')
    const exit = b.door(room.north, 3, 1.0, 'door', 'exit')
    const both = b.door(room.east, 3, 1.0, 'door', 'both')
    const plain = b.door(room.west, 3, 1.0)
    const { document } = reload({ ...createDocument('Ways out'), plan: b.build() })

    const byId = new Map(document.plan.openings.map((o) => [o.id, o]))
    expect(byId.get(entry.id)?.use).toBe('entry')
    expect(byId.get(exit.id)?.use).toBe('exit')
    expect(byId.get(both.id)?.use).toBe('both')
    expect(Object.hasOwn(byId.get(plain.id)!, 'use')).toBe(false)
  })

  it('drops a use it does not recognise rather than passing it on', () => {
    // `buildWorld` stands a destination on any opening with a truthy `use`, but
    // only adds it to the entries or the exits when the value is one of the
    // three it knows. A surviving 'emergency' would therefore be a doorway
    // everybody can route to and nobody arrives or leaves through.
    const { document } = parseDocument({
      plan: {
        walls: [{ id: 'w1', a: [0, 0], b: [8, 0] }],
        openings: [
          { id: 'o1', wallId: 'w1', offset: 2, width: 1, use: 'emergency' },
          { id: 'o2', wallId: 'w1', offset: 5, width: 1, use: true },
        ],
      },
    })

    expect(document.plan.openings).toHaveLength(2)
    for (const opening of document.plan.openings) {
      expect(Object.hasOwn(opening, 'use')).toBe(false)
    }
  })
})

describe('fields a file leaves out', () => {
  it('fills settings from the shipped defaults, keeping what the file did carry', () => {
    expect(parseDocument({ plan: {} }).document.settings).toEqual(DEFAULT_SETTINGS)

    const { document } = parseDocument({ settings: { units: 'imperial', gridSize: 0.25 } })
    expect(document.settings).toEqual({ ...DEFAULT_SETTINGS, units: 'imperial', gridSize: 0.25 })
  })

  it('sizes a dimensionless opening as a door or a window, not as a round metre', () => {
    const walls = [{ id: 'w1', a: [0, 0], b: [10, 0] }]
    const openings = [
      { id: 'o1', wallId: 'w1', offset: 2 },
      { id: 'o2', wallId: 'w1', offset: 6, kind: 'window' },
      { id: 'o3', wallId: 'w1', offset: 8, kind: 'gate' },
    ]
    const { document } = parseDocument({ plan: { walls, openings } })
    const [doorway, pane, gate] = document.plan.openings

    // Every default dimension is an orderable size from standards.ts; a literal
    // here would silently re-dimension a plan on reload.
    expect(doorway.width).toBe(DEFAULT_SETTINGS.defaultDoorWidth)
    expect(doorway.height).toBe(DEFAULT_SETTINGS.defaultDoorHeight)
    expect(doorway.sill).toBe(0)
    expect(pane.width).toBe(DEFAULT_SETTINGS.defaultWindowWidth)
    expect(pane.height).toBe(DEFAULT_SETTINGS.defaultWindowHeight)
    expect(pane.sill).toBe(DEFAULT_SETTINGS.defaultWindowSill)
    expect(gate.width).toBe(DEFAULT_SETTINGS.defaultDoorWidth)
  })

  it('sizes it from the defaults of the file it came in, not the app-wide ones', () => {
    // A venue whose doors are 2.4 m carries that in its own settings, and those
    // settings survive the reload — the door sized from them has to as well, or
    // a plan with wide doors comes back with standard ones and clears an
    // evacuation it should not.
    const { document, warnings } = parseDocument({
      settings: {
        defaultDoorWidth: 2.4,
        defaultDoorHeight: 2.6,
        defaultWindowWidth: 3,
        defaultWindowHeight: 1.1,
        defaultWindowSill: 0.4,
      },
      plan: {
        walls: [{ id: 'w1', a: [0, 0], b: [10, 0] }],
        openings: [
          { id: 'o1', wallId: 'w1', offset: 2 },
          { id: 'o2', wallId: 'w1', offset: 6, kind: 'window' },
          { id: 'o3', wallId: 'w1', offset: 8, kind: 'gate' },
        ],
      },
    })
    const [doorway, pane, gate] = document.plan.openings

    expect(warnings).toEqual([])
    expect(doorway.width).toBe(2.4)
    expect(doorway.height).toBe(2.6)
    expect(doorway.sill).toBe(0)
    expect(pane.width).toBe(3)
    expect(pane.height).toBe(1.1)
    expect(pane.sill).toBe(0.4)
    // A gate is a way through, not a pane: it takes the door family's numbers.
    expect(gate.width).toBe(2.4)
    expect(gate.sill).toBe(0)
  })
})

describe('files that are not documents', () => {
  const hostile: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', 'not a plan'],
    ['an array of plans', [{ walls: [] }]],
    ['a document with no plan', { schemaVersion: SCHEMA_VERSION, name: 'No plan' }],
    ['a plan whose lists are not lists', { plan: { walls: 'four', openings: 7, zones: null } }],
    [
      'a plan of junk entries',
      {
        plan: { walls: [null, 3, 'wall'], furniture: [null], zones: [[]], servicePoints: ['desk'] },
      },
    ],
    ['a scenario that is a string', { scenario: 'busy' }],
  ]

  it.each(hostile)('reads %s without throwing', (_label, input) => {
    const { document } = parseDocument(input)

    expect(document.plan.walls).toEqual([])
    expect(document.settings).toEqual(DEFAULT_SETTINGS)
    // Whatever came in, what comes out has to be runnable — the app opens onto
    // this document and offers to simulate it.
    expect(document.scenario.populations.length).toBeGreaterThan(0)
    expect(document.scenario.profiles.length).toBeGreaterThan(0)
  })

  it('reports the JSON failure ahead of the empty document it fell back to', () => {
    const result = parseDocumentJson('{"schemaVersion": 1, "plan": {')

    expect(result.warnings[0]).toMatch(/not valid JSON/i)
    expect(result.warnings).toHaveLength(2)
    expect(result.document.settings).toEqual(DEFAULT_SETTINGS)
  })

  it('opens an exported report as the venue the run was on', () => {
    // A report is the file that gets emailed, so it is the file that comes back.
    const original = loadedVenue()
    const bundle = {
      format: 'crowd-report',
      document: JSON.parse(serializeDocument(original)),
      summary: { completed: 12 },
    }
    const result = parseDocument(bundle)

    expect(result.warnings).toEqual([])
    expect(result.document.plan).toEqual(original.plan)
    expect(result.document.name).toBe(original.name)
  })
})

describe('repairs the parser reports', () => {
  it('accounts for everything a damaged file lost, counted under its own kind', () => {
    const result = parseDocument({
      plan: {
        walls: [
          { id: 'w1', a: [0, 0], b: [8, 0] },
          // A wall with no length is not geometry; the door on it goes with it.
          { id: 'w2', a: [4, 4], b: [4, 4] },
        ],
        openings: [
          { id: 'o1', wallId: 'w1', offset: 2, width: 1 },
          { id: 'o2', wallId: 'w2', offset: 1, width: 1 },
          { id: 'o3', wallId: 'gone', offset: 1, width: 1 },
          'not an opening',
        ],
        furniture: [{ id: 'f1', catalogId: 'chair', position: [1, 1] }, { position: [2, 2] }],
        zones: [
          {
            id: 'z1',
            kind: 'entry',
            name: 'Way in',
            polygon: [
              [0, 0],
              [1, 0],
            ],
          },
        ],
        servicePoints: ['a desk'],
      },
    })

    expect(result.document.plan.walls.map((w) => w.id)).toEqual(['w1'])
    expect(result.document.plan.openings.map((o) => o.id)).toEqual(['o1'])
    expect(result.document.plan.furniture.map((f) => f.id)).toEqual(['f1'])

    // Someone opening a file this broken is about to simulate a venue that is
    // missing a wall, three doors, a chair, the only entry and the desk people
    // queue at. One line per kind is what tells them so.
    const said = result.warnings.join('\n')
    expect(result.warnings).toHaveLength(5)
    expect(said).toContain('1 wall(s)')
    expect(said).toContain('3 opening(s)')
    expect(said).toContain('1 furniture item(s)')
    expect(said).toContain('1 zone(s)')
    expect(said).toContain('1 service point(s)')
  })

  it('says nothing about a plan it read whole', () => {
    const result = parseDocument({
      plan: {
        walls: [{ id: 'w1', a: [0, 0], b: [8, 0] }],
        openings: [{ id: 'o1', wallId: 'w1', offset: 2, width: 1 }],
        furniture: [],
        zones: [],
      },
    })

    expect(result.warnings).toEqual([])
  })

  it('warns about a file from a newer build but keeps what it understands', () => {
    const result = parseDocument({
      schemaVersion: SCHEMA_VERSION + 1,
      name: 'From the future',
      plan: { walls: [{ id: 'w1', a: [0, 0], b: [5, 0] }] },
    })

    expect(result.warnings.join(' ')).toContain(`schema ${SCHEMA_VERSION + 1}`)
    expect(result.document.schemaVersion).toBe(SCHEMA_VERSION)
    expect(result.document.plan.walls).toHaveLength(1)
    expect(result.document.name).toBe('From the future')
  })

  it('keeps NaN and Infinity out of every number, optional ones included', () => {
    const result = parseDocument({
      plan: {
        walls: [{ id: 'w1', a: [0, 0], b: [Number.NaN, 4] }],
        zones: [
          {
            id: 'z1',
            kind: 'keep-clear',
            name: 'Aisle',
            polygon: [
              [0, 0],
              [2, 0],
              [2, 2],
            ],
            cost: Number.NaN,
            capacity: Number.POSITIVE_INFINITY,
            dwell: { kind: 'lognormal', mean: 60, sd: Number.NaN, max: Number.POSITIVE_INFINITY },
          },
        ],
        servicePoints: [
          {
            id: 's1',
            name: 'Desk',
            position: [2, 2],
            serviceTime: { kind: 'lognormal', mean: 20, sd: Number.NaN },
            opensAt: Number.NaN,
            closesAt: Number.NEGATIVE_INFINITY,
          },
        ],
      },
      scenario: {
        evacuationAtS: Number.NaN,
        populations: [
          {
            id: 'p1',
            name: 'Crowd',
            arrival: { kind: 'peak', startS: 0, windowS: 600, peakAt: Number.NaN, waves: Infinity },
            itinerary: [{ id: 'st1', kind: 'goto', targetId: 'z1', probability: Number.NaN }],
          },
        ],
      },
    })
    const zone = result.document.plan.zones[0]
    const desk = result.document.plan.servicePoints[0]
    const { arrival, itinerary } = result.document.scenario.populations[0]

    expect(result.document.plan.walls[0].b.x).toBe(0)
    expect(result.document.scenario.evacuationAtS).toBeNull()

    // An unusable optional number has to arrive as an absent one, so the engine
    // falls back to a figure it can run on. Admitted, a NaN spreads: it survives
    // every comparison it meets, so a routing cost or a service time carries it
    // into the results and the whole run comes back unreadable.
    expect(Object.hasOwn(zone, 'cost')).toBe(false)
    expect(Object.hasOwn(zone, 'capacity')).toBe(false)
    expect(Object.hasOwn(zone.dwell!, 'sd')).toBe(false)
    expect(Object.hasOwn(zone.dwell!, 'max')).toBe(false)
    expect(zone.dwell!.mean).toBe(60)
    expect(Object.hasOwn(desk.serviceTime, 'sd')).toBe(false)
    expect(Object.hasOwn(desk, 'opensAt')).toBe(false)
    expect(Object.hasOwn(desk, 'closesAt')).toBe(false)
    expect(Object.hasOwn(arrival, 'peakAt')).toBe(false)
    expect(Object.hasOwn(arrival, 'waves')).toBe(false)
    expect(Object.hasOwn(itinerary[0], 'probability')).toBe(false)
  })
})

describe('the name a save lands under', () => {
  it('turns a venue name into a filename, and never into an empty one', () => {
    const doc = createDocument('Café ~ Main Hall!')

    expect(documentFileName(doc)).toBe('caf-main-hall.crowd.json')
    expect(documentFileName({ ...doc, name: '!!!' })).toBe('venue.crowd.json')
  })
})
