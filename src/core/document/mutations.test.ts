/**
 * Mutations are the only sanctioned way to edit a document, so these tests are
 * as much about the contract — a new document, the untouched arrays shared by
 * reference, the input left alone — as about what each edit computes.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  addFurniture,
  addOpening,
  addPopulation,
  addServicePoint,
  addWall,
  addWalls,
  addZone,
  findObject,
  isLocked,
  removeObjects,
  removePopulation,
  renameDocument,
  setBackdrop,
  updateBackdrop,
  updateFurniture,
  updateObject,
  updateOpening,
  updatePopulation,
  updateScenario,
  updateServicePoint,
  updateSettings,
  updateWall,
  updateZone,
} from './mutations'
import { PlanBuilder, step } from '../../library/planBuilder'
import { createDocument, createPopulation } from '../model/defaults'
import { wallLength } from '../model/planGeometry'
import {
  DEFAULT_DOOR_WIDTH,
  DEFAULT_WALL_HEIGHT,
  DEFAULT_WALL_THICKNESS,
  OPENING_JAMB,
} from '../model/standards'
import type { Backdrop, CrowdDocument, ItineraryStep, Opening, Wall } from '../model/types'

/** A 10 x 8 room with a door, a window, a chair, an entry zone and two counters. */
const scene = () => {
  const b = new PlanBuilder()
  const room = b.room(0, 0, 10, 8)
  const door = b.door(room.south, 5, DEFAULT_DOOR_WIDTH, 'door', 'entry')
  const glazing = b.window(room.east, 4)
  const chair = b.place('chair', 5, 4)
  const entry = b.zone('entry', 4, 0.2, 6, 1.4, 'Front door')
  const serviceTime = { kind: 'normal' as const, mean: 40, sd: 8 }
  const bar = b.service('Bar', 2, 7, -Math.PI / 2, 2, serviceTime)
  const kiosk = b.service('Kiosk', 8, 7, -Math.PI / 2, 1, serviceTime)

  const base = createDocument('Test venue')
  const population = {
    ...createPopulation(0),
    entryIds: [entry.id],
    itinerary: [step('service', bar.id), step('exit')],
  }
  const doc: CrowdDocument = {
    ...base,
    plan: b.build(),
    scenario: { ...base.scenario, populations: [population] },
  }
  return { doc, room, door, glazing, chair, entry, bar, kiosk, population }
}

type Scene = ReturnType<typeof scene>

type PlanArray = 'walls' | 'openings' | 'furniture' | 'zones' | 'servicePoints'

const PLAN_ARRAYS: PlanArray[] = ['walls', 'openings', 'furniture', 'zones', 'servicePoints']

/** Which of the plan's arrays came back as fresh arrays rather than shared ones. */
const rebuiltArrays = (before: CrowdDocument, after: CrowdDocument): PlanArray[] =>
  PLAN_ARRAYS.filter((key) => after.plan[key] !== before.plan[key])

const looseWall = (): Wall => ({
  id: 'wall_added',
  a: { x: 0, y: 4 },
  b: { x: 3, y: 4 },
  thickness: DEFAULT_WALL_THICKNESS,
  height: DEFAULT_WALL_HEIGHT,
  kind: 'partition',
})

const tracing = (): Backdrop => ({
  src: 'data:image/png;base64,iVBORw0KGgo=',
  position: { x: 0, y: 0 },
  rotation: 0,
  width: 20,
  depth: 14,
  opacity: 0.6,
  visible: true,
})

const withItinerary = (doc: CrowdDocument, itinerary: ItineraryStep[]): CrowdDocument => ({
  ...doc,
  scenario: {
    ...doc.scenario,
    populations: doc.scenario.populations.map((pop) => ({ ...pop, itinerary })),
  },
})

const openingById = (doc: CrowdDocument, id: string) => {
  const opening = doc.plan.openings.find((o) => o.id === id)
  if (!opening) throw new Error(`opening ${id} is gone`)
  return opening
}

describe('structural sharing', () => {
  const edits: Array<{ name: string; rebuilds: PlanArray[]; edit: (f: Scene) => CrowdDocument }> = [
    { name: 'addWall', rebuilds: ['walls'], edit: (f) => addWall(f.doc, looseWall()) },
    { name: 'addWalls', rebuilds: ['walls'], edit: (f) => addWalls(f.doc, [looseWall()]) },
    {
      // `openings` is in this list only because updateWall maps over every
      // opening in the plan to re-clamp the ones on this wall, and `map` hands
      // back a new array even when it changed nothing. See the reported miss.
      name: 'updateWall',
      rebuilds: ['walls'],
      edit: (f) => updateWall(f.doc, f.room.north.id, { kind: 'partition' }),
    },
    {
      name: 'addOpening',
      rebuilds: ['openings'],
      edit: (f) => addOpening(f.doc, { ...f.door, id: 'open_added', offset: 2 }),
    },
    {
      name: 'updateOpening',
      rebuilds: ['openings'],
      edit: (f) => updateOpening(f.doc, f.door.id, { sill: 0.1 }),
    },
    {
      name: 'addFurniture',
      rebuilds: ['furniture'],
      edit: (f) => addFurniture(f.doc, [{ ...f.chair, id: 'item_added' }]),
    },
    {
      name: 'updateFurniture',
      rebuilds: ['furniture'],
      edit: (f) => updateFurniture(f.doc, f.chair.id, { rotation: 1 }),
    },
    {
      name: 'addZone',
      rebuilds: ['zones'],
      edit: (f) => addZone(f.doc, { ...f.entry, id: 'zone_added' }),
    },
    {
      name: 'updateZone',
      rebuilds: ['zones'],
      edit: (f) => updateZone(f.doc, f.entry.id, { name: 'Main doors' }),
    },
    {
      name: 'addServicePoint',
      rebuilds: ['servicePoints'],
      edit: (f) => addServicePoint(f.doc, { ...f.bar, id: 'svc_added' }),
    },
    {
      name: 'updateServicePoint',
      rebuilds: ['servicePoints'],
      edit: (f) => updateServicePoint(f.doc, f.bar.id, { servers: 4 }),
    },
    { name: 'setBackdrop', rebuilds: [], edit: (f) => setBackdrop(f.doc, tracing()) },
  ]

  it.each(edits)('$name shares every array it did not touch', ({ rebuilds, edit }) => {
    const f = scene()
    const next = edit(f)

    expect(next).not.toBe(f.doc)
    expect(rebuiltArrays(f.doc, next)).toEqual(rebuilds)
    // The renderer diffs by array identity and undo keeps whole documents, so
    // the parts a plan edit has no opinion about must survive by reference.
    expect(next.scenario).toBe(f.doc.scenario)
    expect(next.settings).toBe(f.doc.settings)
    expect(next.id).toBe(f.doc.id)
    expect(next.createdAt).toBe(f.doc.createdAt)
  })

  it('never writes through to the document it was given', () => {
    const f = scene()
    const { doc } = f
    const deepFreeze = (value: unknown): void => {
      if (!value || typeof value !== 'object' || Object.isFrozen(value)) return
      Object.freeze(value)
      for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    }
    deepFreeze(doc)
    // Without this the assertion below would pass whether or not the freeze
    // reached the objects a mutation actually writes to.
    expect(Object.isFrozen(doc.plan.walls[0])).toBe(true)

    // Modules are strict mode, so a frozen document turns a stray write into a
    // TypeError here rather than into a corrupted undo stack much later.
    expect(() => {
      addWall(doc, looseWall())
      addWalls(doc, [looseWall()])
      updateWall(doc, f.room.south.id, { b: { x: 4, y: 0 } })
      addOpening(doc, { ...f.door, id: 'open_added' })
      updateOpening(doc, f.door.id, { width: 1.2 })
      addFurniture(doc, [{ ...f.chair, id: 'item_added' }])
      updateFurniture(doc, f.chair.id, { rotation: 2 })
      addZone(doc, { ...f.entry, id: 'zone_added' })
      updateZone(doc, f.entry.id, { name: 'Renamed' })
      addServicePoint(doc, { ...f.bar, id: 'svc_added' })
      updateServicePoint(doc, f.bar.id, { servers: 9 })
      updateObject(doc, { kind: 'wall', id: f.room.east.id }, { kind: 'glass' })
      removeObjects(doc, [
        { kind: 'wall', id: f.room.south.id },
        { kind: 'zone', id: f.entry.id },
        { kind: 'service', id: f.bar.id },
      ])
      updateScenario(doc, { seed: 12 })
      updatePopulation(doc, f.population.id, { count: 7 })
      addPopulation(doc, createPopulation(1))
      removePopulation(doc, f.population.id)
      updateSettings(doc, { units: 'imperial' })
      renameDocument(doc, 'Renamed')
      setBackdrop(setBackdrop(doc, tracing()), undefined)
    }).not.toThrow()
  })

  it('shares the whole plan across scenario, settings and name edits', () => {
    const f = scene()
    for (const next of [
      updateScenario(f.doc, { seed: 7 }),
      updatePopulation(f.doc, f.population.id, { count: 500 }),
      addPopulation(f.doc, createPopulation(1)),
      removePopulation(f.doc, f.population.id),
      updateSettings(f.doc, { units: 'imperial' }),
      renameDocument(f.doc, 'Renamed'),
    ]) {
      expect(next).not.toBe(f.doc)
      expect(next.plan).toBe(f.doc.plan)
    }
    // A patch that does not mention the populations must not re-wrap them.
    expect(updateScenario(f.doc, { seed: 7 }).scenario.populations).toBe(f.doc.scenario.populations)
  })
})

describe('walls and the openings cut into them', () => {
  it('keeps a door inside a wall that has been dragged shorter', () => {
    const f = scene()
    const next = updateWall(f.doc, f.room.south.id, { b: { x: 5, y: 0 } })
    const door = openingById(next, f.door.id)

    expect(door.width).toBeCloseTo(DEFAULT_DOOR_WIDTH, 6)
    expect(door.offset).toBeCloseTo(5 - DEFAULT_DOOR_WIDTH / 2 - OPENING_JAMB, 6)
    expect(openingById(f.doc, f.door.id).offset).toBe(5)
  })

  it('narrows a door that no longer fits, and leaves a jamb either side', () => {
    const f = scene()
    // Half a metre of wall cannot hold a 3'0" leaf. It used to be allowed to
    // span the whole wall, which leaves nothing to carry the head and nothing
    // for the leaf to hang from — and deletes the wall from the plan without
    // deleting it from the document.
    const next = updateWall(f.doc, f.room.south.id, { b: { x: 0.5, y: 0 } })
    const door = openingById(next, f.door.id)

    expect(door.width).toBeCloseTo(0.5 - 2 * OPENING_JAMB, 6)
    expect(door.offset).toBeCloseTo(0.25, 6)
  })

  it('erases a door when its wall is collapsed, and does not bring it back', () => {
    const f = scene()
    const collapsed = updateWall(f.doc, f.room.south.id, { b: { ...f.room.south.a } })
    const wall = collapsed.plan.walls.find((w) => w.id === f.room.south.id)

    expect(wall && wallLength(wall)).toBe(0)
    // Nothing fits in a wall of no length, so the door shrinks to the floor the
    // fit allows rather than to literally nothing.
    expect(openingById(collapsed, f.door.id)).toMatchObject({ width: 0.05, offset: 0 })

    // Dragging the endpoint back out restores the wall but not the doorway: the
    // width was squeezed on the way through and nothing remembers what it was.
    // Only undo gets the door back.
    const reopened = updateWall(collapsed, f.room.south.id, { b: { x: 10, y: 0 } })
    expect(openingById(reopened, f.door.id).width).toBe(0.05)
  })

  it('keeps the whole openings array when a wall edit moves none of them', () => {
    const f = scene()
    const next = updateWall(f.doc, f.room.south.id, { kind: 'partition' })

    // The renderer diffs by array identity, so a wall edit that touches no
    // opening must not hand it a rebuilt array to walk.
    expect(next.plan.openings).toBe(f.doc.plan.openings)
  })

  it('cuts an opening to fit as it is edited, not at the next wall edit', () => {
    const f = scene()
    // The inspector's stock-size picker applies a width without knowing the
    // wall, so a 6'0" pair can be aimed at a 1 m wall. It used to be stored as
    // typed and only repaired the next time the wall itself was touched, which
    // means a plan could be saved, loaded and simulated in the broken state.
    const wide = updateOpening(f.doc, f.door.id, { width: 24 })
    expect(openingById(wide, f.door.id).width).toBeCloseTo(10 - 2 * OPENING_JAMB, 6)
    expect(openingById(wide, f.door.id).offset).toBeCloseTo(5, 6)
  })

  it('pulls an opening back from beyond the end of its wall', () => {
    const f = scene()
    const off = updateOpening(f.doc, f.door.id, { offset: 40 })

    expect(openingById(off, f.door.id).offset).toBeCloseTo(
      10 - DEFAULT_DOOR_WIDTH / 2 - OPENING_JAMB,
      6,
    )
  })

  it('will not let a doorway stand taller than the wall it is cut into', () => {
    const f = scene()
    const wall = f.doc.plan.walls.find((w) => w.id === f.room.south.id)
    const tall = updateOpening(f.doc, f.door.id, { height: 40 })

    expect(openingById(tall, f.door.id).height).toBeCloseTo(wall?.height ?? 0, 6)
  })
})

describe('removing objects', () => {
  it('takes a wall’s doors and windows with it, and leaves other walls’ alone', () => {
    const f = scene()
    const next = removeObjects(f.doc, [{ kind: 'wall', id: f.room.south.id }])

    expect(next.plan.walls.map((w) => w.id)).not.toContain(f.room.south.id)
    expect(next.plan.openings.map((o) => o.id)).not.toContain(f.door.id)
    expect(next.plan.openings.map((o) => o.id)).toContain(f.glazing.id)
  })

  it('rebuilds every plan array even when only one kind was removed', () => {
    const f = scene()
    const next = removeObjects(f.doc, [{ kind: 'zone', id: f.entry.id }])

    // Asserted as-is: removeObjects filters all five arrays unconditionally, so
    // nothing survives by reference. The objects inside still do.
    expect(rebuiltArrays(f.doc, next)).toEqual(PLAN_ARRAYS)
    expect(next.plan.walls).toEqual(f.doc.plan.walls)
    expect(next.plan.walls[0]).toBe(f.doc.plan.walls[0])
    expect(next.plan.zones).toEqual([])
  })

  it('unlinks a deleted entry zone and drops the step that led to a deleted counter', () => {
    const f = scene()
    const next = removeObjects(f.doc, [
      { kind: 'zone', id: f.entry.id },
      { kind: 'service', id: f.bar.id },
    ])
    const pop = next.scenario.populations[0]

    expect(pop.entryIds).toEqual([])
    expect(pop.itinerary.map((s) => s.kind)).toEqual(['exit'])
  })

  it('prunes a deleted counter out of a step that listed several', () => {
    const f = scene()
    const doc = withItinerary(f.doc, [
      step('service', undefined, { targetIds: [f.bar.id, f.kiosk.id] }),
      step('exit'),
    ])
    const next = removeObjects(doc, [{ kind: 'service', id: f.kiosk.id }])

    // "Did this population change?" used to be decided by comparing entry and
    // itinerary *lengths*, and pruning ids out of a step changes neither — so
    // the pruned itinerary was computed and then thrown away, and the plan lost
    // a counter the itinerary still named.
    expect(next.scenario.populations[0].itinerary[0].targetIds).toEqual([f.bar.id])
  })

  it('drops a service step once every counter it named is gone', () => {
    const f = scene()
    const doc = withItinerary(f.doc, [
      step('service', undefined, { targetIds: [f.kiosk.id] }),
      step('exit'),
    ])
    const next = removeObjects(doc, [{ kind: 'service', id: f.kiosk.id }])
    const pop = next.scenario.populations[0]

    // A step written with a single `targetId` has always been dropped when its
    // target goes. Two spellings of one thing must not disagree.
    expect(pop.itinerary).toHaveLength(1)
    expect(pop.itinerary[0].kind).toBe('exit')
  })

  it('forgets a door the population arrived through when the door goes', () => {
    const f = scene()
    const doc = withItinerary(f.doc, [step('exit')])
    const wall = doc.plan.walls[0]
    const door: Opening = {
      id: 'open_way_in',
      wallId: wall.id,
      offset: wallLength(wall) / 2,
      width: 0.914,
      height: 2.032,
      sill: 0,
      kind: 'door',
      use: 'entry',
    }
    const withDoor = updatePopulation(addOpening(doc, door), doc.scenario.populations[0].id, {
      entryIds: [door.id],
    })

    // A door marked as a way in is a destination in its own right now, so it
    // has to be forgotten like one. It is not enough to handle the door being
    // deleted directly: taking the wall takes its openings with it, which is
    // the way somebody actually loses an entrance by accident.
    expect(
      removeObjects(withDoor, [{ kind: 'opening', id: door.id }]).scenario.populations[0].entryIds,
    ).toEqual([])
    expect(
      removeObjects(withDoor, [{ kind: 'wall', id: wall.id }]).scenario.populations[0].entryIds,
    ).toEqual([])
  })

  it('removes the backdrop by ref, and removing nothing is free', () => {
    const f = scene()
    const traced = setBackdrop(f.doc, tracing())
    const next = removeObjects(traced, [{ kind: 'backdrop', id: 'backdrop' }])

    expect('backdrop' in next.plan).toBe(false)
    expect(removeObjects(f.doc, [])).toBe(f.doc)
  })

  it('still makes a new document when the thing was already gone', () => {
    const f = scene()
    const next = removeObjects(f.doc, [{ kind: 'wall', id: 'wall_gone' }])

    // `apply` only skips history when the document comes back identical, so a
    // delete that matched nothing costs a real undo step and marks the file
    // dirty. Asserted as-is.
    expect(next).not.toBe(f.doc)
    expect(next.plan.walls).toEqual(f.doc.plan.walls)
  })
})

describe('edits that hit nothing', () => {
  it('returns the very same document when the wall does not exist', () => {
    const f = scene()
    expect(updateWall(f.doc, 'wall_gone', { height: 3 })).toBe(f.doc)
    expect(updateBackdrop(f.doc, { opacity: 0.2 })).toBe(f.doc)
  })

  it('returns a new wrapper for every other miss, sharing all the arrays', () => {
    const f = scene()
    // updateWall and updateOpening short-circuit, the rest do not. Harmless for
    // the data, but it is the difference between a no-op and an undo step.
    // Asserted as-is for the ones that still rebuild.
    expect(updateOpening(f.doc, 'open_gone', { width: 1 })).toBe(f.doc)
    for (const next of [
      updateFurniture(f.doc, 'item_gone', { rotation: 1 }),
      updateZone(f.doc, 'zone_gone', { name: 'Nowhere' }),
      updateServicePoint(f.doc, 'svc_gone', { servers: 3 }),
    ]) {
      expect(next).not.toBe(f.doc)
      expect(rebuiltArrays(f.doc, next)).toEqual([])
    }
    expect(updatePopulation(f.doc, 'pop_gone', { count: 5 }).scenario.populations).toBe(
      f.doc.scenario.populations,
    )
    expect(removePopulation(f.doc, 'pop_gone').scenario.populations).toEqual(
      f.doc.scenario.populations,
    )
  })

  it('adds nothing for an empty batch', () => {
    const f = scene()
    expect(addWalls(f.doc, [])).toBe(f.doc)
    expect(addFurniture(f.doc, [])).toBe(f.doc)
  })
})

describe('identity and merging', () => {
  it('merges the patch and keeps the id and the fields it did not mention', () => {
    const f = scene()
    const next = updateZone(f.doc, f.entry.id, { name: 'Main doors' })
    const zone = next.plan.zones[0]

    expect(zone.id).toBe(f.entry.id)
    expect(zone.kind).toBe('entry')
    expect(zone.name).toBe('Main doors')
    // Untouched members are shared, not cloned: a zone edit must not make the
    // renderer think its polygon moved.
    expect(zone.polygon).toBe(f.entry.polygon)
    expect(f.entry.name).toBe('Front door')
  })

  it('appends new objects and leaves the existing ones by reference', () => {
    const f = scene()
    const wall = looseWall()
    const next = addWall(f.doc, wall)

    expect(next.plan.walls).toHaveLength(f.doc.plan.walls.length + 1)
    expect(next.plan.walls[next.plan.walls.length - 1]).toBe(wall)
    expect(next.plan.walls[0]).toBe(f.doc.plan.walls[0])
  })

  it('stores what it is handed; validation is not a mutation’s job', () => {
    const f = scene()
    const next = updateFurniture(f.doc, f.chair.id, {
      size: { width: -1, depth: -1, height: 0 },
    })
    expect(next.plan.furniture[0].size).toEqual({ width: -1, depth: -1, height: 0 })
    expect(updateServicePoint(f.doc, f.bar.id, { servers: -2 }).plan.servicePoints[0].servers).toBe(
      -2,
    )
  })

  it('applies the scenario, settings and name edits it advertises', () => {
    const f = scene()
    expect(updateScenario(f.doc, { seed: 7 }).scenario.seed).toBe(7)
    expect(
      updatePopulation(f.doc, f.population.id, { count: 500 }).scenario.populations[0],
    ).toMatchObject({ id: f.population.id, count: 500 })
    expect(addPopulation(f.doc, createPopulation(1)).scenario.populations).toHaveLength(2)
    expect(removePopulation(f.doc, f.population.id).scenario.populations).toEqual([])

    const imperial = updateSettings(f.doc, { units: 'imperial' })
    expect(imperial.settings.units).toBe('imperial')
    expect(imperial.settings.gridSize).toBe(f.doc.settings.gridSize)
  })

  it('stamps updatedAt and never touches createdAt', () => {
    const f = scene()
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
      const next = renameDocument(f.doc, 'Renamed')
      expect(next.name).toBe('Renamed')
      expect(next.updatedAt).toBe('2030-01-01T00:00:00.000Z')
      expect(next.createdAt).toBe(f.doc.createdAt)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the backdrop', () => {
  it('deletes the key rather than storing undefined', () => {
    const f = scene()
    const traced = setBackdrop(f.doc, tracing())
    expect(traced.plan.backdrop?.opacity).toBe(0.6)

    const cleared = setBackdrop(traced, undefined)
    // A `backdrop: undefined` key would survive a spread and be written out by
    // the serialiser as a null-ish backdrop; the key has to go.
    expect('backdrop' in cleared.plan).toBe(false)
  })

  it('patches the backdrop in place and keeps the bitmap', () => {
    const f = scene()
    const traced = setBackdrop(f.doc, tracing())
    const next = updateBackdrop(traced, { opacity: 0.2, visible: false })

    expect(next.plan.backdrop).toMatchObject({ opacity: 0.2, visible: false })
    expect(next.plan.backdrop?.src).toBe(traced.plan.backdrop?.src)
    expect(next.plan.walls).toBe(f.doc.plan.walls)
  })
})

describe('updateObject', () => {
  it('routes each ref kind to its own updater', () => {
    const f = scene()
    const traced = setBackdrop(f.doc, tracing())

    expect(
      updateObject(f.doc, { kind: 'zone', id: f.entry.id }, { name: 'Doors' }).plan.zones[0].name,
    ).toBe('Doors')
    expect(
      updateObject(f.doc, { kind: 'furniture', id: f.chair.id }, { rotation: 1 }).plan.furniture[0]
        .rotation,
    ).toBe(1)
    expect(
      updateObject(f.doc, { kind: 'service', id: f.bar.id }, { servers: 5 }).plan.servicePoints[0]
        .servers,
    ).toBe(5)
    expect(
      updateObject(f.doc, { kind: 'opening', id: f.door.id }, { sill: 0.3 }).plan.openings[0].sill,
    ).toBe(0.3)
    expect(
      updateObject(traced, { kind: 'backdrop', id: 'backdrop' }, { opacity: 0.1 }).plan.backdrop
        ?.opacity,
    ).toBe(0.1)
  })

  it('takes the wall path, cascade and all', () => {
    const f = scene()
    // The generic path is what the inspector and the drag tools call, so it
    // must not be a way to shorten a wall without re-clamping its doors.
    const next = updateObject(f.doc, { kind: 'wall', id: f.room.south.id }, { b: { x: 5, y: 0 } })

    expect(openingById(next, f.door.id).offset).toBeCloseTo(
      5 - DEFAULT_DOOR_WIDTH / 2 - OPENING_JAMB,
      6,
    )
  })
})

describe('lookups', () => {
  it('finds an object by ref and says nothing for a ref that has gone stale', () => {
    const f = scene()

    expect(findObject(f.doc, { kind: 'wall', id: f.room.east.id })).toBe(f.room.east)
    expect(findObject(f.doc, { kind: 'service', id: f.bar.id })).toBe(f.bar)
    expect(findObject(f.doc, { kind: 'opening', id: f.glazing.id })).toBe(f.glazing)
    expect(findObject(f.doc, { kind: 'furniture', id: 'item_gone' })).toBeUndefined()
    expect(findObject(f.doc, { kind: 'backdrop', id: 'backdrop' })).toBeUndefined()
  })

  it('reports a lock, and treats a vanished object as unlocked', () => {
    const f = scene()
    const locked = updateFurniture(f.doc, f.chair.id, { locked: true })

    expect(isLocked(locked, { kind: 'furniture', id: f.chair.id })).toBe(true)
    expect(isLocked(f.doc, { kind: 'furniture', id: f.chair.id })).toBe(false)
    // A selection outlives what it points at — delete with something selected —
    // so the lock check has to answer rather than throw.
    expect(isLocked(f.doc, { kind: 'furniture', id: 'item_gone' })).toBe(false)
  })
})
