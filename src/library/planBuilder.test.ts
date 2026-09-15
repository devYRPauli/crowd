/**
 * The builder every venue in the product is written with.
 *
 * The starter templates, the engine's fixtures and the validation harness all
 * describe their venues through this class, so a slip here is not one wrong
 * plan — it is every plan at once, and it still draws as a floor plan. A corner
 * that misses by a millimetre, a door hung past the end of its wall or a chair
 * turned a quarter-turn out all look fine on screen and change who gets out.
 *
 * So these tests ask what the plan *means* to the things downstream — room
 * detection, the solid stretches of a wall, the world the engine compiles, the
 * file it saves as — rather than what the object literal looks like.
 */

import { describe, expect, it } from 'vitest'
import { PlanBuilder, step } from './planBuilder'
import {
  DEFAULT_DOOR_HEIGHT,
  DEFAULT_DOOR_WIDTH,
  DEFAULT_WALL_HEIGHT,
  DEFAULT_WALL_THICKNESS,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_SILL,
  DEFAULT_WINDOW_WIDTH,
  DOUBLE_DOOR_FROM,
  OPENING_JAMB,
} from '../core/model/standards'
import {
  isWalkableOpening,
  openingThreshold,
  planSeats,
  pointOnWall,
  solidSpans,
  wallLength,
  type WorldSeat,
} from '../core/model/planGeometry'
import { detectRooms } from '../core/model/rooms'
import { isCounterClockwise, polygonArea } from '../core/math/geometry'
import { ZONE_COLORS, ZONE_LABELS, createDocument, createScenario } from '../core/model/defaults'
import { parseDocument, serializeDocument } from '../core/document/serialize'
import { feetToMetres } from '../core/model/units'
import { buildWorld } from '../sim/world'
import type { Plan } from '../core/model/types'

const INCH = 0.0254

/** A venue described the way a template describes one. */
const venue = (): Plan => {
  const b = new PlanBuilder()
  const room = b.room(0, 0, 20, 12)
  b.door(room.south, 6, 1.829, 'door', 'entry')
  b.door(room.north, 6, 1.829, 'door', 'exit')
  b.window(room.west, 4)
  b.zone('waypoint', 2, 8, 6, 11, 'Cloakroom')
  b.service('Bar', 16, 10, Math.PI, 2, { kind: 'normal', mean: 35, sd: 9 })
  b.tableWithChairs('table-round-8', 10, 5)
  b.seatingBlock(4, 2, 2, 3)
  return b.build()
}

/**
 * A plan with its minted ids replaced by what each object *is* and where it
 * sits, so two builds can be compared without comparing their ids — while a
 * reference (an opening's `wallId`) still has to point at the same wall.
 */
const canonical = (plan: Plan): string => {
  const names = new Map<string, string>()
  const label = (things: Array<{ id: string }>, prefix: string): void => {
    things.forEach((thing, index) => names.set(thing.id, `${prefix}#${index}`))
  }
  label(plan.walls, 'wall')
  label(plan.openings, 'opening')
  label(plan.furniture, 'item')
  label(plan.zones, 'zone')
  label(plan.servicePoints, 'service')
  let text = JSON.stringify(plan)
  for (const [id, name] of names) text = text.replaceAll(`"${id}"`, `"${name}"`)
  return text
}

const byPlace = (a: WorldSeat, b: WorldSeat): number =>
  a.position.x - b.position.x || a.position.y - b.position.y

describe('a room', () => {
  it('closes corner to corner, with no gap for anybody to leak through', () => {
    const b = new PlanBuilder()
    const room = b.room(0, 0, 10, 8)

    // Exactly, not nearly. Room detection snaps endpoints at a millimetre, and
    // a corner that misses by more than that is a hole in the building that
    // nothing on screen shows.
    expect(room.south.b).toEqual(room.east.a)
    expect(room.east.b).toEqual(room.north.a)
    expect(room.north.b).toEqual(room.west.a)
    expect(room.west.b).toEqual(room.south.a)

    const [enclosed, ...others] = detectRooms(b.build().walls)
    expect(others).toEqual([])
    expect(enclosed.area).toBe(80)
    expect(enclosed.center).toEqual({ x: 5, y: 4 })
    expect(new Set(enclosed.wallIds)).toEqual(new Set(room.all.map((wall) => wall.id)))
  })

  it('takes its corners south-west first, and encloses the floor either way round', () => {
    const b = new PlanBuilder()
    const room = b.room(0, 0, 10, 8)

    expect(room.south.a).toEqual({ x: 0, y: 0 })
    expect(room.south.b).toEqual({ x: 10, y: 0 })
    expect(room.north.a).toEqual({ x: 10, y: 8 })
    expect(isCounterClockwise(room.all.map((wall) => wall.a))).toBe(true)

    // Given the far corner first the names follow the corners rather than the
    // compass — but the floor it encloses is the same floor.
    const flipped = new PlanBuilder()
    const upsideDown = flipped.room(10, 8, 0, 0)
    expect(upsideDown.south.a).toEqual({ x: 10, y: 8 })
    expect(detectRooms(flipped.build().walls)[0].area).toBe(80)
  })

  it('builds all four walls from one set of options, each with its own identity', () => {
    const b = new PlanBuilder()
    const plain = b.room(0, 0, 4, 4)
    const glazed = b.room(10, 0, 14, 4, { kind: 'glass', thickness: 0.05, height: 3 })

    for (const wall of plain.all) {
      expect(wall.thickness).toBe(DEFAULT_WALL_THICKNESS)
      expect(wall.height).toBe(DEFAULT_WALL_HEIGHT)
      expect(wall.kind).toBe('wall')
    }
    for (const wall of glazed.all) {
      expect(wall.kind).toBe('glass')
      expect(wall.thickness).toBe(0.05)
      expect(wall.height).toBe(3)
    }

    // Doors are hung on a wall id. Two walls sharing one would put every door
    // in the room on the same wall and leave the others solid.
    expect(new Set(b.build().walls.map((wall) => wall.id)).size).toBe(8)
  })

  it('copies the points it is handed, so moving them later cannot move the wall', () => {
    const corner = { x: 1, y: 2 }
    const b = new PlanBuilder()
    const wall = b.wall(corner, { x: 5, y: 2 })

    corner.x = 99
    expect(wall.a).toEqual({ x: 1, y: 2 })
    expect(wall.a).not.toBe(corner)
    expect(wallLength(wall)).toBe(4)
  })
})

describe('doors and windows', () => {
  it('hangs a door on the wall it was given, within it, with wall left either side', () => {
    const b = new PlanBuilder()
    const room = b.room(0, 0, 10, 8)
    const door = b.door(room.south, 5)
    const plan = b.build()

    expect(door.wallId).toBe(room.south.id)
    expect(pointOnWall(room.south, door.offset)).toEqual({ x: 5, y: 0 })
    expect(door.width).toBe(DEFAULT_DOOR_WIDTH)
    expect(door.height).toBe(DEFAULT_DOOR_HEIGHT)
    expect(door.sill).toBe(0)
    expect(isWalkableOpening(door)).toBe(true)

    const [west, east] = solidSpans(room.south, plan.openings)
    expect(west.start).toBe(0)
    expect(west.end).toBeCloseTo(5 - DEFAULT_DOOR_WIDTH / 2, 9)
    expect(east.start).toBeCloseTo(5 + DEFAULT_DOOR_WIDTH / 2, 9)
    expect(east.end).toBeCloseTo(wallLength(room.south), 9)
    // A leaf has to hang from something and the head has to be carried: a door
    // that eats the whole wall deletes the wall without deleting it.
    expect(west.end - west.start).toBeGreaterThan(OPENING_JAMB)
    expect(east.end - east.start).toBeGreaterThan(OPENING_JAMB)
  })

  it('draws a pair of leaves once one leaf would be wider than anybody makes', () => {
    const b = new PlanBuilder()
    const wall = b.wall({ x: 0, y: 0 }, { x: 20, y: 0 })

    expect(b.door(wall, 2).kind).toBe('door')
    expect(b.door(wall, 4, DOUBLE_DOOR_FROM - 0.001).kind).toBe('door')
    expect(b.door(wall, 6, DOUBLE_DOOR_FROM).kind).toBe('double-door')
    // A pair is how it is drawn, not what it is worth: the clear width people
    // are metered through is the width that was asked for.
    expect(b.door(wall, 8, 1.829).width).toBe(1.829)
    // Something named is what it was named. A 2.4 m gate is not a pair of doors.
    expect(b.door(wall, 12, 2.4, 'gate').kind).toBe('gate')
    expect(b.door(wall, 16, 2.4, 'opening').kind).toBe('opening')
  })

  it('glazes a window above the floor, where it is no way through', () => {
    const b = new PlanBuilder()
    const room = b.room(0, 0, 10, 8)
    const glazing = b.window(room.west, 4)

    expect(glazing.kind).toBe('window')
    expect(glazing.width).toBe(DEFAULT_WINDOW_WIDTH)
    expect(glazing.height).toBe(DEFAULT_WINDOW_HEIGHT)
    expect(glazing.sill).toBe(DEFAULT_WINDOW_SILL)
    expect(isWalkableOpening(glazing)).toBe(false)
    // The wall under a window is still wall. Counted as an opening it would
    // also drive the navigation grid finer for a gap nobody walks through.
    expect(solidSpans(room.west, b.build().openings)).toEqual([{ start: 0, end: 8 }])
  })

  it('gives the engine the marked doors, and only those, as the ways in and out', () => {
    const b = new PlanBuilder()
    const room = b.room(0, 0, 20, 12)
    const entrance = b.door(room.south, 6, 1.829, 'door', 'entry')
    const fireExit = b.door(room.north, 14, 1.829, 'door', 'exit')
    const internal = b.door(room.west, 6)
    const world = buildWorld(b.build(), createScenario())

    expect(world.entries.map((record) => record.id)).toEqual([entrance.id])
    expect(world.exits.map((record) => record.id)).toEqual([fireExit.id])
    // An unmarked door is a hole people may walk through, not a destination.
    expect(world.targets.has(internal.id)).toBe(false)
    // The doorway stands on the wall the door was hung on, and on floor an
    // agent can actually occupy — an entry with no reachable cell spawns
    // nobody and the run comes back empty.
    expect(world.entries[0].center.x).toBeCloseTo(6, 6)
    expect(world.entries[0].center.y).toBeCloseTo(0, 6)
    expect(world.entries[0].goalCells.length).toBeGreaterThan(0)
  })

  it('hangs a door wherever it is told, including where there is no wall', () => {
    // SUSPECTED BUG: `door()` never checks the offset against the wall it
    // names. Twenty-five metres along a twenty-metre wall is accepted, kept in
    // the plan and saved; `solidSpans` clamps it to nothing, so the wall stays
    // solid, and `buildWorld` still takes it as a way in — standing five metres
    // outside the building. A population told to arrive through that door is
    // spawned in the car park with no way into a sealed room, and the run
    // reports people who could not reach anything rather than the typo.
    // Correct, I think, is what the placement tool and the inspector already
    // do: clamp the offset so the leaf stays on the wall with OPENING_JAMB of
    // wall either side of it.
    const b = new PlanBuilder()
    const room = b.room(0, 0, 20, 12)
    const stray = b.door(room.south, 25, DEFAULT_DOOR_WIDTH, 'door', 'entry')
    const plan = b.build()

    expect(plan.openings.map((opening) => opening.offset)).toEqual([25])
    expect(stray.wallId).toBe(room.south.id)
    expect(solidSpans(room.south, plan.openings)).toEqual([{ start: 0, end: 20 }])
    expect(Math.min(...openingThreshold(room.south, stray).map((p) => p.x))).toBeGreaterThan(20)
    expect(buildWorld(plan, createScenario()).entries[0].center.x).toBeCloseTo(25, 6)

    // The same at a corner, where half the leaf falls off the end of the wall
    // and the other half opens the room with no jamb to hang it from.
    const flush = new PlanBuilder()
    const flushRoom = flush.room(0, 0, 20, 12)
    flush.door(flushRoom.south, 0)
    const spans = solidSpans(flushRoom.south, flush.build().openings)
    expect(spans).toHaveLength(1)
    expect(spans[0].start).toBeCloseTo(DEFAULT_DOOR_WIDTH / 2, 9)
  })
})

describe('metres', () => {
  it('stamps its defaults as the imperial sizes they are named for, to the millimetre', () => {
    const b = new PlanBuilder()
    const wall = b.wall({ x: 0, y: 0 }, { x: 10, y: 0 })
    const door = b.door(wall, 5)
    const glazing = b.window(wall, 8)

    // A 3'0" leaf, a 6'8" head, a 6½" 2x6 partition, a 9'0" commercial ceiling.
    expect(door.width).toBe(0.914)
    expect(door.height).toBe(2.032)
    expect(wall.thickness).toBe(0.165)
    expect(wall.height).toBe(2.743)
    expect(glazing.width).toBe(1.219)
    expect(glazing.sill).toBe(0.914)

    // The same sizes the imperial display and parser mean by those names,
    // carried to the millimetre the document rounds them to.
    expect(door.width).toBeCloseTo(feetToMetres(3), 3)
    expect(door.height).toBeCloseTo(feetToMetres(6 + 8 / 12), 3)
    expect(wall.height).toBeCloseTo(feetToMetres(9), 3)
    expect(glazing.width).toBeCloseTo(feetToMetres(4), 3)
    expect(wall.thickness).toBeCloseTo(6.5 * INCH, 3)
    for (const metres of [door.width, door.height, wall.thickness, wall.height, glazing.sill]) {
      expect(Math.abs(metres * 1000 - Math.round(metres * 1000))).toBeLessThan(1e-9)
    }
  })

  it('reads the coordinates it is given as metres and converts nothing', () => {
    const b = new PlanBuilder()
    const wall = b.wall({ x: 0, y: 0 }, { x: 3.5, y: 0 })
    const measured = b.zone('measure', 0, 0, 4, 2.5)
    const desk = b.service('Desk', 6, 1.5, Math.PI / 2, 2, { kind: 'constant', mean: 30 })

    expect(wallLength(wall)).toBeCloseTo(3.5, 12)
    expect(polygonArea(measured.polygon)).toBeCloseTo(10, 12)
    expect(desk.position).toEqual({ x: 6, y: 1.5 })
    // A counter 1.8 m along its face and 0.65 m between people in its queue:
    // metres, like everything else the builder writes down.
    expect(desk.width).toBe(1.8)
    expect(desk.depth).toBe(0.7)
    expect(desk.queueSpacing).toBe(0.65)
    expect(desk.servers).toBe(2)
  })
})

describe('the plan it emits', () => {
  it('survives the save and reload the rest of the system puts it through', () => {
    const plan = venue()
    const document = { ...createDocument('Round trip'), plan }
    const reloaded = parseDocument(JSON.parse(serializeDocument(document)))

    // Every warning here is something the reader dropped on the way in.
    expect(reloaded.warnings).toEqual([])
    expect(reloaded.document.plan).toEqual(plan)
  })

  it('paints a zone in the colour and name its kind is always drawn with', () => {
    const b = new PlanBuilder()
    const arrivals = b.zone('entry', 0, 0, 4, 3)
    const stage = b.zone('obstacle', 10, 0, 14, 3, 'Stage')

    expect(arrivals.name).toBe(ZONE_LABELS.entry)
    expect(arrivals.color).toBe(ZONE_COLORS.entry)
    expect(stage.name).toBe('Stage')
    expect(stage.color).toBe(ZONE_COLORS.obstacle)
    expect(arrivals.polygon).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 3 },
      { x: 0, y: 3 },
    ])
    expect(polygonArea(arrivals.polygon)).toBe(12)
    expect(isCounterClockwise(arrivals.polygon)).toBe(true)
  })

  it('hands out the arrays it goes on writing to', () => {
    // SUSPECTED BUG: `build()` returns the builder's own arrays rather than
    // copies of them. A document is meant to be a snapshot — plain, immutable,
    // and diffed by array identity by the renderer — but anything added to the
    // builder afterwards appears inside a plan that was already handed over,
    // behind undo's back and without the array identity changing to say so.
    // A fixture that builds a plan and then goes on to build a variant of it
    // gets two references to one growing plan. `build()` should copy.
    const b = new PlanBuilder()
    b.room(0, 0, 4, 4)
    const plan = b.build()
    expect(plan.walls).toHaveLength(4)

    b.wall({ x: 10, y: 0 }, { x: 14, y: 0 })
    expect(plan.walls).toHaveLength(5)
    expect(b.build().walls).toBe(plan.walls)
  })
})

describe('furniture', () => {
  it('sets a chair at every place a table lays, facing the table', () => {
    const b = new PlanBuilder()
    // Turned off-axis, because an unrotated table hides every mistake in the
    // rotation of the chairs around it.
    b.tableWithChairs('table-round-8', 4, 3, 0.7)
    const plan = b.build()

    const [table, ...chairs] = plan.furniture
    expect(table.catalogId).toBe('table-round-8')
    expect(chairs).toHaveLength(8)
    expect(new Set(chairs.map((chair) => chair.catalogId))).toEqual(new Set(['chair']))

    const seats = planSeats(plan)
    const laid = seats.filter((seat) => seat.furnitureId === table.id).sort(byPlace)
    const seated = seats.filter((seat) => seat.furnitureId !== table.id).sort(byPlace)
    expect(laid).toHaveLength(8)
    expect(seated).toHaveLength(8)
    laid.forEach((place, index) => {
      expect(seated[index].position.x).toBeCloseTo(place.position.x, 12)
      expect(seated[index].position.y).toBeCloseTo(place.position.y, 12)
      // The chair's own occupant has to end up looking where the table's place
      // setting looks, or everybody at the table sits with their back to it.
      expect(seated[index].facing).toBeCloseTo(place.facing, 12)
    })
  })

  it('lays a grid of tables out on the spacing it was given', () => {
    const b = new PlanBuilder()
    b.tableGrid('table-round-4', 2, 3, 3, 2, 2.5, 3)
    const plan = b.build()

    const tables = plan.furniture.filter((item) => item.catalogId === 'table-round-4')
    expect(tables.map((table) => table.position)).toEqual([
      { x: 2, y: 3 },
      { x: 4.5, y: 3 },
      { x: 7, y: 3 },
      { x: 2, y: 6 },
      { x: 4.5, y: 6 },
      { x: 7, y: 6 },
    ])
    // Every table comes set: four places apiece here, and a chair on each.
    expect(plan.furniture.filter((item) => item.catalogId === 'chair')).toHaveLength(24)
    expect(planSeats(plan)).toHaveLength(48)
  })

  it('stacks rows of theatre seating back from the front row', () => {
    const b = new PlanBuilder()
    b.seatingBlock(5, 2, 3, 4)
    const plan = b.build()

    expect(plan.furniture).toHaveLength(3)
    plan.furniture.forEach((row, index) => {
      expect(row.catalogId).toBe('seat-row')
      expect(row.position.x).toBe(5)
      expect(row.position.y).toBeCloseTo(2 + index * 0.95, 9)
      expect(row.size).toEqual({ width: 4, depth: 0.7, height: 0.95 })
    })

    // SUSPECTED BUG: the JSDoc says these rows face +Y, and they face -Y. The
    // geometry is the self-consistent reading — rows recede in +Y, so the
    // audience looks back down the block at a stage in front of row one — which
    // makes the comment the thing that is wrong. It is not harmless: a template
    // author who believes it puts the stage behind the audience, and every
    // seated person in the venue faces away from what they came to watch.
    for (const seat of planSeats(plan)) {
      expect(Math.sin(seat.facing)).toBeCloseTo(-1, 9)
      expect(Math.cos(seat.facing)).toBeCloseTo(0, 9)
    }
  })
})

describe('the same description built twice', () => {
  it('produces structurally identical plans, ids aside', () => {
    const first = venue()
    const second = venue()

    expect(canonical(second)).toBe(canonical(first))
    // A venue that differs by one door has to come out different, or the
    // comparison above is comparing nothing.
    const moved = new PlanBuilder()
    const room = moved.room(0, 0, 20, 12)
    moved.door(room.south, 6.5, 1.829, 'door', 'entry')
    expect(canonical(moved.build())).not.toBe(canonical(first))

    // And the ids themselves are not identical, which is the whole reason the
    // simulation names its random streams after where a thing sits rather than
    // after its id: a baseline compared against a rebuild of the same venue
    // would otherwise be measuring the ids.
    expect(second.walls[0].id).not.toBe(first.walls[0].id)
    expect(second.openings[0].id).not.toBe(first.openings[0].id)
  })

  it('gives everything in a plan an id of its own, prefixed with what it is', () => {
    const plan = venue()
    const everything = [
      ...plan.walls,
      ...plan.openings,
      ...plan.furniture,
      ...plan.zones,
      ...plan.servicePoints,
    ]

    expect(new Set(everything.map((thing) => thing.id)).size).toBe(everything.length)
    expect(plan.walls.every((wall) => wall.id.startsWith('wall_'))).toBe(true)
    expect(plan.openings.every((opening) => opening.id.startsWith('open_'))).toBe(true)
    expect(plan.furniture.every((item) => item.id.startsWith('item_'))).toBe(true)
    expect(plan.zones.every((zone) => zone.id.startsWith('zone_'))).toBe(true)
    expect(plan.servicePoints.every((point) => point.id.startsWith('svc_'))).toBe(true)
    // Openings still point at walls that are in the plan.
    const wallIds = new Set(plan.walls.map((wall) => wall.id))
    expect(plan.openings.every((opening) => wallIds.has(opening.wallId))).toBe(true)
  })

  it('leaves an itinerary step that needs no target without one', () => {
    const leave = step('exit')
    const served = step('service', 'svc_1', { duration: { kind: 'constant', mean: 30 } })

    expect(leave.kind).toBe('exit')
    expect('targetId' in leave).toBe(false)
    expect(served.targetId).toBe('svc_1')
    expect(served.duration).toEqual({ kind: 'constant', mean: 30 })
    expect(step('exit').id).not.toBe(leave.id)
  })
})
