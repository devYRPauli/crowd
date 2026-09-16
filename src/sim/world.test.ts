/**
 * Compiling a plan into a world.
 *
 * Almost everything `buildWorld` decides is invisible on the drawing: how fine
 * the navigation grid is, which doors are ways in and out, which furniture is
 * a wall. Every one of those has been wrong at some point in a way that still
 * produced a plausible-looking run, so these tests are about the decisions
 * rather than about the shape of the returned object.
 */

import { describe, expect, it } from 'vitest'
import {
  NAV_CLEARANCE,
  buildWorld,
  collectObstaclePolygons,
  isQueueRecord,
  nearestFreeCell,
  queueSlotFacing,
  queueSlotPosition,
  samplePointInDestination,
  servicePositionFor,
  type BuildWorldOptions,
  type DestinationRecord,
  type SimWorld,
} from './world'
import { PlanBuilder } from '../library/planBuilder'
import { createScenario } from '../core/model/defaults'
import { cellCenter, gridIndex, solveEikonal, worldToCell } from './nav/eikonal'
import { planSeats } from '../core/model/planGeometry'
import { computeNewVelocity } from './avoidance/orca'
import { DEFAULT_DOOR_WIDTH, DEFAULT_DOUBLE_DOOR_WIDTH } from '../core/model/standards'
import type { Distribution } from '../core/math/random'
import type { Vec2 } from '../core/math/vec2'
import type { Plan, ServicePoint } from '../core/model/types'

const scenario = createScenario()

const compile = (plan: Plan, options: BuildWorldOptions = {}): SimWorld =>
  buildWorld(plan, scenario, options)

const ids = (records: Array<{ id: string }>): string[] => records.map((record) => record.id)

const cellAt = (world: SimWorld, x: number, y: number): number => {
  const { col, row } = worldToCell(world.grid, x, y)
  return gridIndex(world.grid, col, row)
}

const centreOf = (world: SimWorld, cell: number): Vec2 =>
  cellCenter(world.grid, cell % world.grid.cols, Math.floor(cell / world.grid.cols))

/** Cost-to-goal over the navigation mask, for asking what can be reached. */
const timeFrom = (world: SimWorld, goalCells: readonly number[]): Float32Array =>
  solveEikonal(world.grid, world.navBlocked, world.baseSpeed, goalCells)

/** A room with one door of the given width on its south wall. */
const hall = (doorWidth: number, offset = 10): Plan => {
  const b = new PlanBuilder()
  const room = b.room(0, 0, 20, 12)
  b.door(room.south, offset, doorWidth)
  return b.build()
}

/**
 * Narrowest free cross-section the grid leaves through a doorway, in cells.
 *
 * This is what a door is worth to the simulation: not its drawn width, but the
 * count of cells an agent centre can occupy once the wall has been dilated by
 * body clearance. Rows are scanned rather than a single one sampled, because
 * the tightest row is the one level with the wall and where that falls depends
 * on the cell size.
 */
const doorwayCells = (world: SimWorld, doorX: number): number => {
  const { grid, navBlocked } = world
  let narrowest = Infinity
  for (let row = 0; row < grid.rows; row++) {
    const y = grid.originY + (row + 0.5) * grid.cellSize
    if (Math.abs(y) > 0.5) continue
    let free = 0
    for (let col = 0; col < grid.cols; col++) {
      const x = grid.originX + (col + 0.5) * grid.cellSize
      if (Math.abs(x - doorX) > 1.5) continue
      if (!navBlocked[gridIndex(grid, col, row)]) free++
    }
    narrowest = Math.min(narrowest, free)
  }
  return narrowest
}

describe('grid resolution', () => {
  it('is set by the narrowest door, not by the size of the venue', () => {
    const narrow = compile(hall(0.8))
    const wide = compile(hall(DEFAULT_DOUBLE_DOOR_WIDTH))

    // Eight cells across the leaf, which for a 0.8 m door is 0.1 m.
    expect(narrow.grid.cellSize).toBeCloseTo(0.1, 6)
    // The same room, and a door wide enough that the extent cap binds instead.
    expect(wide.grid.cellSize).toBeCloseTo(0.2, 6)
  })

  it('resolves a narrow door wherever on the wall it happens to sit', () => {
    // The bug this replaced: on a fixed 0.3 m grid a 0.8 m door passed a fifth
    // of what it should, and the answer moved on three millimetres of geometry
    // — because what survived dilation was one cell, if any cell centre landed
    // in the 0.28 m channel at all. Sweeping a full cell pitch of door
    // positions is how that shows up as more than an unlucky example: four of
    // these positions close the door completely.
    const coarse: number[] = []
    const chosen: number[] = []
    for (let offset = 10; offset <= 10.3001; offset += 0.005) {
      coarse.push(doorwayCells(compile(hall(0.8, offset), { cellSize: 0.3 }), offset))
      chosen.push(doorwayCells(compile(hall(0.8, offset)), offset))
    }

    expect(Math.min(...coarse)).toBe(0)
    expect(Math.max(...coarse)).toBe(1)
    expect(Math.min(...chosen)).toBeGreaterThanOrEqual(2)
  })

  it('is not driven finer by a window, which is no way through', () => {
    const b = new PlanBuilder()
    const room = b.room(0, 0, 20, 12)
    b.door(room.south, 10, DEFAULT_DOUBLE_DOOR_WIDTH)
    // Narrower than the door, so a window counted as an opening would more
    // than halve the cell size and cost four times the cells for a resolution
    // nobody walks through.
    b.window(room.north, 8, 0.6)

    expect(compile(b.build()).grid.cellSize).toBeCloseTo(
      compile(hall(DEFAULT_DOUBLE_DOOR_WIDTH)).grid.cellSize,
      6,
    )
  })

  it('keeps a huge venue inside the cell budget', () => {
    const b = new PlanBuilder()
    const room = b.room(0, 0, 600, 600)
    b.door(room.south, 300, 0.8)

    const world = compile(b.build())

    // The door asks for 0.1 m, which over 600 m square is 36 million cells and
    // an eikonal solve nobody waits for. The budget wins, and says so: close to
    // a metre, ten times coarser than the door asked for.
    expect(world.grid.cellSize).toBeGreaterThan(0.9)
    expect(world.grid.cellSize).toBeLessThan(1)
    // The budget buys a cell size, and the grid then rounds up to whole rows
    // and columns, so it lands a shade over the ceiling rather than under it.
    expect(world.grid.cols * world.grid.rows).toBeGreaterThan(395_000)
    expect(world.grid.cols * world.grid.rows).toBeLessThan(405_000)
  })

  it('refuses to go finer than a body can use', () => {
    const b = new PlanBuilder()
    const room = b.room(0, 0, 10, 8)
    // Not a door anybody hangs, but a plan gets drawn with one. Eight cells
    // across it would be 37 mm, and a person is 0.46 m across.
    b.door(room.south, 5, 0.3)

    expect(compile(b.build()).grid.cellSize).toBeCloseTo(0.05, 6)
  })

  it('falls back on the venue when there is no way in to size it by', () => {
    const sealed = (side: number): Plan => {
      const b = new PlanBuilder()
      b.room(0, 0, side, side)
      return b.build()
    }

    // With nothing to resolve, extent is all there is — and it is held between
    // 0.2 m and 0.5 m either way. A small room does not get a needlessly fine
    // grid, and a hangar does not get one too coarse to put a person on.
    expect(compile(sealed(10)).grid.cellSize).toBeCloseTo(0.2, 6)
    expect(compile(sealed(250)).grid.cellSize).toBeCloseTo(0.5, 6)
  })

  it('refines for a hatch nobody can climb through', () => {
    // SUSPECTED BUG — asserted as it behaves today. `chooseCellSize` excludes
    // windows by kind, but `isWalkableOpening`, which is what decides whether
    // the wall is solid there, also excludes anything with a sill. A serving
    // hatch is therefore solid wall people route around, and still sets the
    // resolution for the whole venue.
    const withHatch = (sill: number): Plan => {
      const b = new PlanBuilder()
      const room = b.room(0, 0, 20, 12)
      b.door(room.south, 10, DEFAULT_DOUBLE_DOOR_WIDTH)
      const hatch = b.door(room.north, 10, 0.6, 'opening')
      const plan = b.build()
      return {
        ...plan,
        openings: plan.openings.map((o) => (o.id === hatch.id ? { ...o, sill } : o)),
      }
    }

    const walkThrough = compile(withHatch(0))
    const overCounter = compile(withHatch(1.0))

    // The hatch at counter height leaves no gap in the wall at all...
    expect(overCounter.solid[cellAt(overCounter, 10, 12)]).toBe(1)
    expect(walkThrough.solid[cellAt(walkThrough, 10, 12)]).toBe(0)
    // ...and is still costing the same 0.6 / 8 m cell as the one people use.
    expect(overCounter.grid.cellSize).toBeCloseTo(walkThrough.grid.cellSize, 6)
    expect(overCounter.grid.cellSize).toBeCloseTo(0.075, 6)
  })
})

describe('doors people arrive and leave through', () => {
  const marked = () => {
    const b = new PlanBuilder()
    const room = b.room(0, 0, 20, 12)
    const entry = b.door(room.south, 5, DEFAULT_DOUBLE_DOOR_WIDTH, 'door', 'entry')
    const exit = b.door(room.north, 5, DEFAULT_DOUBLE_DOOR_WIDTH, 'door', 'exit')
    const both = b.door(room.east, 6, DEFAULT_DOUBLE_DOOR_WIDTH, 'door', 'both')
    const plain = b.door(room.west, 6, DEFAULT_DOUBLE_DOOR_WIDTH)
    const glazing = b.window(room.south, 15)
    const built = b.build()
    const plan: Plan = {
      ...built,
      openings: built.openings.map((o) =>
        o.id === glazing.id ? { ...o, use: 'entry' as const } : o,
      ),
    }
    return { plan, entry, exit, both, plain, glazing }
  }

  it('reads the use off the door, and ignores one written on a window', () => {
    const { plan, entry, exit, both, plain, glazing } = marked()
    const world = compile(plan)

    expect(ids(world.entries)).toEqual([entry.id, both.id])
    expect(ids(world.exits)).toEqual([exit.id, both.id])
    // An unmarked door is a hole people may walk through, not somewhere to go.
    expect(world.targets.has(plain.id)).toBe(false)
    // A window is glass over solid wall: a destination standing on one sends
    // people at it, and the nearest-free-cell fallback can put them through it
    // and outside the building.
    expect(world.targets.has(glazing.id)).toBe(false)
  })

  it('stands the destination on the doorway itself', () => {
    const { plan, entry } = marked()
    const world = compile(plan)
    const record = world.entries.find((r) => r.id === entry.id)!

    // The south wall runs along y = 0, so this is the door's own centre — the
    // opening's clear width is then what meters the flow through it.
    expect(record.center.x).toBeCloseTo(5, 6)
    expect(record.center.y).toBeCloseTo(0, 6)

    const centres = record.goalCells.map((cell) => centreOf(world, cell))
    const xs = centres.map((c) => c.x)
    const left = Math.min(...xs)
    const right = Math.max(...xs)

    // Somewhere several people can stand, all of it between the jambs and
    // centred between them. A patch that ran past the leaf would put arrivals
    // against the wall beside the door; one that drifted off centre would meter
    // the flow by wherever it drifted to rather than by the door's clear width.
    expect(centres.length).toBeGreaterThan(12)
    expect(left).toBeGreaterThan(5 - DEFAULT_DOUBLE_DOOR_WIDTH / 2)
    expect(right).toBeLessThan(5 + DEFAULT_DOUBLE_DOOR_WIDTH / 2)
    expect(Math.abs((left + right) / 2 - 5)).toBeLessThan(world.grid.cellSize)

    // The threshold straddles the wall, so somebody outside can aim at it and
    // somebody inside can leave through it.
    expect(centres.some((c) => c.y < 0)).toBe(true)
    expect(centres.some((c) => c.y > 0)).toBe(true)
  })

  it('makes a door that works both ways one place, not two', () => {
    const { plan, both } = marked()
    const world = compile(plan)
    const asEntry = world.entries.find((r) => r.id === both.id)!
    const asExit = world.exits.find((r) => r.id === both.id)!

    // The same record on both lists. Two copies would each carry their own goal
    // cells, and `targets` — which is keyed by id — could only hold one of them,
    // so an itinerary step aiming at this door would reach a different doorway
    // from the one the arrivals used.
    expect(asEntry).toBe(asExit)
    expect(world.targets.get(both.id)).toBe(asEntry)
  })

  it('keeps zone entries and exits alongside the door-based ones', () => {
    const b = new PlanBuilder()
    const room = b.room(0, 0, 20, 12)
    const doorOut = b.door(room.north, 10, DEFAULT_DOUBLE_DOOR_WIDTH, 'door', 'exit')
    const entryZone = b.zone('entry', 1, 1, 4, 4, 'In')
    const exitZone = b.zone('exit', 16, 8, 19, 11, 'Out')
    const stage = b.zone('waypoint', 8, 8, 12, 11, 'Stage')
    const gate = b.zone('measure', 9, 0.5, 11, 2, 'Gate line')
    const pit = b.zone('obstacle', 5, 5, 6, 6, 'Pit')

    const world = compile(b.build())

    expect(ids(world.entries)).toEqual([entryZone.id])
    expect(ids(world.exits)).toEqual([exitZone.id, doorOut.id])
    expect(ids(world.waypoints)).toEqual([stage.id])
    expect(ids(world.measures)).toEqual([gate.id])
    // An obstacle zone is geometry, not somewhere anybody is sent.
    expect(world.targets.has(pit.id)).toBe(false)
    expect(world.obstaclePolygons).toContainEqual(pit.polygon)
  })
})

describe('what is solid', () => {
  it('blocks a wall thinner than one grid cell', () => {
    // A 165 mm partition on a 0.4 m grid is thinner than the sampling, so
    // without the half-cell dilation it falls between cell centres, vanishes
    // from the mask, and two rooms quietly become one.
    const b = new PlanBuilder()
    b.room(0, 0, 20, 12)
    b.wall({ x: 10, y: 0 }, { x: 10, y: 12 })
    const split = compile(b.build(), { cellSize: 0.4 })

    const o = new PlanBuilder()
    o.room(0, 0, 20, 12)
    const undivided = compile(o.build(), { cellSize: 0.4 })

    const acrossSplit = timeFrom(split, [cellAt(split, 5, 6)])[cellAt(split, 15, 6)]
    const acrossUndivided = timeFrom(undivided, [cellAt(undivided, 5, 6)])[cellAt(undivided, 15, 6)]

    expect(acrossSplit).toBe(Infinity)
    // The same grid without the partition — ten metres at unit speed — so the
    // line above is the wall and not a grid too coarse to route on at all.
    expect(acrossUndivided).toBeLessThan(11)
    // The clearance field is built from the undilated mask, which has to see it too.
    expect(split.clearance[cellAt(split, 10, 6)]).toBeLessThan(0)
  })

  it('signs the clearance field so it still points out of a solid', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 20, 12)
    b.zone('obstacle', 8, 5, 10, 7, 'Plinth')
    const world = compile(b.build(), { cellSize: 0.1 })

    // Dead centre of a 2 m block is a metre inside it. Somebody shoved in here
    // needs a gradient that leads out; an unsigned field is flat zero and gives
    // no direction at all.
    expect(world.clearance[cellAt(world, 9, 6)]).toBeLessThan(-0.9)
    // Two metres of clear floor west of the block, with the walls further off
    // than that; the bound is loose by a cell for where the sample lands.
    expect(world.clearance[cellAt(world, 6, 6)]).toBeGreaterThan(1.8)
    expect(world.clearance[cellAt(world, 6, 6)]).toBeLessThan(2.2)
  })

  it('cuts a doorway out of the wall and leaves a window glazed', () => {
    const pierced = (kind: 'door' | 'window'): Plan => {
      const b = new PlanBuilder()
      const room = b.room(0, 0, 20, 12)
      if (kind === 'door') b.door(room.south, 10, DEFAULT_DOUBLE_DOOR_WIDTH)
      else b.window(room.south, 10, DEFAULT_DOUBLE_DOOR_WIDTH)
      return b.build()
    }

    const withDoor = compile(pierced('door'), { cellSize: 0.2 })
    const withWindow = compile(pierced('window'), { cellSize: 0.2 })

    // Four walls, and the doored one broken into the two stretches either side
    // of the leaf. A window takes nothing out: the wall stays one piece.
    expect(collectObstaclePolygons(pierced('door'))).toHaveLength(5)
    expect(collectObstaclePolygons(pierced('window'))).toHaveLength(4)
    expect(withDoor.solid[cellAt(withDoor, 10, 0)]).toBe(0)
    expect(withWindow.solid[cellAt(withWindow, 10, 0)]).toBe(1)

    // Seven metres of floor from a metre outside the wall to the middle of the
    // room, or no way in at all — which is what a building with only windows is.
    const outside = (world: SimWorld) =>
      timeFrom(world, [cellAt(world, 10, -1)])[cellAt(world, 10, 6)]
    expect(outside(withDoor)).toBeCloseTo(7, 1)
    expect(outside(withWindow)).toBe(Infinity)
  })

  it('holds an agent centre a body clear of anything solid', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 20, 12)
    b.zone('obstacle', 8, 5, 10, 7, 'Plinth')
    const world = compile(b.build(), { cellSize: 0.1 })

    // Two masks, and the difference between them is the body. `solid` is the
    // geometry the clearance field and the metrics measure; `navBlocked` is
    // where a centre may not sit, which is a body radius further out.
    // Conflating them puts people's shoulders inside the furniture.
    expect(world.solid[cellAt(world, 10.15, 6)]).toBe(0)
    expect(world.navBlocked[cellAt(world, 10.15, 6)]).toBe(1)

    // Walking east along the centreline, the first cell a centre may occupy is
    // a body radius past the plinth's east face at x = 10, and no further — the
    // mask is dilated by exactly that and not by a guessed margin on top.
    const row = worldToCell(world.grid, 0, 6).row
    let standoff = Infinity
    for (let col = 0; col < world.grid.cols; col++) {
      const c = cellCenter(world.grid, col, row)
      if (c.x > 10 && !world.navBlocked[gridIndex(world.grid, col, row)]) {
        standoff = c.x - 10
        break
      }
    }
    expect(standoff).toBeGreaterThanOrEqual(NAV_CLEARANCE)
    expect(standoff).toBeLessThan(NAV_CLEARANCE + world.grid.cellSize)
  })

  it('takes the plan at its word about what people can walk through', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 20, 12)
    const table = b.place('table-conference', 5, 6)
    const propTable = b.place('table-conference', 15, 6, 0, { blocking: false })
    const chair = b.place('chair', 10, 2)
    const boltedChair = b.place('chair', 10, 10, 0, { blocking: true })
    const world = compile(b.build(), { cellSize: 0.1 })

    // The catalog's answer is only a default. A table drawn as scenery people
    // pass behind, or a chair bolted to the floor, is the author overriding it,
    // and the world has to honour that or the picture and the run disagree.
    expect(world.solid[cellAt(world, table.position.x, table.position.y)]).toBe(1)
    expect(world.solid[cellAt(world, propTable.position.x, propTable.position.y)]).toBe(0)
    expect(world.solid[cellAt(world, chair.position.x, chair.position.y)]).toBe(0)
    expect(world.solid[cellAt(world, boltedChair.position.x, boltedChair.position.y)]).toBe(1)
    // Four walls plus the two items that block; the other two are not obstacles
    // for ORCA either, not merely absent from the grid.
    expect(world.obstaclePolygons).toHaveLength(6)
  })

  it('leaves nothing behind a door as wide as the wall it is cut into', () => {
    const b = new PlanBuilder()
    const room = b.room(0, 0, 20, 12)
    b.door(room.south, 10, 20)
    const plan = b.build()
    const world = compile(plan, { cellSize: 0.2 })

    // Three walls and no south one at all — not a fourth of no length. A sliver
    // polygon would reach ORCA with edges that have no direction, and the
    // normalised zero vector that comes out steers nobody anywhere.
    expect(collectObstaclePolygons(plan)).toHaveLength(3)
    for (const o of world.obstacles) {
      expect(Math.hypot(o.direction.x, o.direction.y)).toBeCloseTo(1, 6)
    }
    expect(world.solid[cellAt(world, 10, 0)]).toBe(0)
    expect(world.solid[cellAt(world, 19, 0)]).toBe(0)
  })

  it('leaves loose chairs walkable, so a ring of them cannot seal its table off', () => {
    const b = new PlanBuilder()
    const room = b.room(0, 0, 10, 10)
    const door = b.door(room.south, 5, DEFAULT_DOOR_WIDTH, 'door', 'entry')
    b.tableWithChairs('table-round-8', 5, 5)
    const plan = b.build()

    const world = compile(plan)

    // Four walls, the doored one in two stretches, and the table. The eight
    // chairs are furniture you pull out: blocking, they would ring the table
    // with obstacle at body clearance and nobody could take their seat.
    expect(world.obstaclePolygons).toHaveLength(6)
    // Eight places at the table and one on each chair, none of them dropped as
    // somewhere an agent could never stand.
    expect(planSeats(plan)).toHaveLength(16)
    expect(world.seats).toHaveLength(16)

    const time = timeFrom(world, world.entries.find((r) => r.id === door.id)!.goalCells)
    const stranded = world.seats.filter(
      (seat) => !Number.isFinite(time[cellAt(world, seat.position.x, seat.position.y)]),
    )
    expect(ids(stranded)).toEqual([])
  })
})

describe('keep-clear zones', () => {
  /** A room with a band across it the plan asks people to stay off. */
  const banded = (cost?: number): Plan => {
    const b = new PlanBuilder()
    b.room(0, 0, 20, 12)
    b.zone('keep-clear', 0, 5, 20, 7, 'Fire lane', cost === undefined ? {} : { cost })
    return b.build()
  }

  it('makes a fire lane expensive to cross without closing it', () => {
    const lane = compile(banded(10), { cellSize: 0.2 })
    const bare = (() => {
      const b = new PlanBuilder()
      b.room(0, 0, 20, 12)
      return compile(b.build(), { cellSize: 0.2 })
    })()

    expect(lane.baseSpeed[cellAt(lane, 10, 6)]).toBeCloseTo(0.1, 6)
    expect(lane.baseSpeed[cellAt(lane, 10, 2)]).toBe(1)
    // Cost is not obstruction. An evacuation with nowhere else to go must still
    // be able to come through here, slowly, rather than find the room sealed.
    expect(lane.navBlocked[cellAt(lane, 10, 6)]).toBe(0)
    expect(lane.solid[cellAt(lane, 10, 6)]).toBe(0)

    // Ten metres of floor end to end: eight seconds of walking plus two metres
    // of lane at a tenth speed. The band runs wall to wall, so this is the price
    // of crossing it and not the price of a detour somebody could take instead.
    expect(timeFrom(bare, [cellAt(bare, 10, 1)])[cellAt(bare, 10, 11)]).toBeCloseTo(10, 2)
    expect(timeFrom(lane, [cellAt(lane, 10, 1)])[cellAt(lane, 10, 11)]).toBeCloseTo(28, 2)
  })

  it('never lets a keep-clear zone make anybody faster than open floor', () => {
    const unstated = compile(banded(), { cellSize: 0.2 })
    const generous = compile(banded(0.5), { cellSize: 0.2 })

    expect(unstated.baseSpeed[cellAt(unstated, 10, 6)]).toBe(0.25)
    // A cost under 1 would be a lane people preferred to walk down, which is
    // not something "keep clear" can mean.
    expect(generous.baseSpeed[cellAt(generous, 10, 6)]).toBe(1)
  })

  it('takes the stricter of two keep-clear zones where they overlap', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 20, 12)
    b.zone('keep-clear', 4, 4, 12, 8, 'Cross aisle', { cost: 2 })
    b.zone('keep-clear', 8, 4, 16, 8, 'Stage door', { cost: 8 })
    const world = compile(b.build(), { cellSize: 0.2 })

    expect(world.baseSpeed[cellAt(world, 6, 6)]).toBe(0.5)
    expect(world.baseSpeed[cellAt(world, 14, 6)]).toBe(0.125)
    // Last zone drawn wins would let a mild one laid on top quietly reopen the
    // strict one underneath it.
    expect(world.baseSpeed[cellAt(world, 10, 6)]).toBe(0.125)
  })
})

describe('obstacle zones', () => {
  const PLINTH: Vec2[] = [
    { x: 8, y: 5 },
    { x: 10, y: 5 },
    { x: 10, y: 7 },
    { x: 8, y: 7 },
  ]

  const withPlinth = (polygon: Vec2[]): SimWorld => {
    const b = new PlanBuilder()
    b.room(0, 0, 20, 12)
    const zone = b.zone('obstacle', 0, 0, 1, 1, 'Plinth')
    const plan = b.build()
    return compile(
      { ...plan, zones: plan.zones.map((z) => (z.id === zone.id ? { ...z, polygon } : z)) },
      { cellSize: 0.2 },
    )
  }

  /** What local avoidance does to somebody walking due east straight at it. */
  const walkInto = (world: SimWorld): Vec2 => {
    const end = world.obstacles.length
    return computeNewVelocity(
      {
        position: { x: 7.4, y: 6 },
        velocity: { x: 1.2, y: 0 },
        radius: 0.23,
        maxSpeed: 1.4,
        prefVelocity: { x: 1.2, y: 0 },
        timeHorizon: 2,
        timeHorizonObst: 1.5,
        responsibility: 1,
      },
      [],
      world.obstacles,
      [end - 4, end - 3, end - 2, end - 1],
    )
  }

  it('turns a plinth into something people route round and are pushed off', () => {
    const world = withPlinth(PLINTH)

    expect(world.solid[cellAt(world, 9, 6)]).toBe(1)
    expect(world.navBlocked[cellAt(world, 9, 6)]).toBe(1)
    expect(world.obstacles.slice(-4).map((o) => o.convex)).toEqual([true, true, true, true])
    // Walked at head-on, the avoidance takes the walker sideways rather than
    // letting them put a foot on it.
    expect(walkInto(world).y).toBeLessThan(-0.5)
  })

  it('stops seeing a plinth whose outline was clicked the other way round', () => {
    // SUSPECTED BUG. `buildObstacles` says it wants counter-clockwise loops, and
    // every polygon `collectObstaclePolygons` builds for itself is one — but a
    // zone carries whatever outline the author clicked, and the zone tool's
    // free-form mode is happy to go clockwise. Reversed, each edge's solid side
    // faces inward and every corner comes out concave, so local avoidance stops
    // constraining anybody. The grid still blocks the cells, so routing goes
    // round it and the run looks fine — until somebody shoved off their path
    // walks through the plinth instead of being pushed off it, which is the one
    // case obstacle avoidance exists for. `collectObstaclePolygons` should put
    // zone polygons through `ensureWinding` as it does not today.
    const clockwise = withPlinth([...PLINTH].reverse())

    expect(clockwise.solid[cellAt(clockwise, 9, 6)]).toBe(1)
    expect(clockwise.navBlocked[cellAt(clockwise, 9, 6)]).toBe(1)
    expect(clockwise.obstacles.slice(-4).map((o) => o.convex)).toEqual([false, false, false, false])

    const straightOn = walkInto(clockwise)
    expect(straightOn.x).toBeCloseTo(1.2, 6)
    expect(straightOn.y).toBeCloseTo(0, 6)
  })
})

describe('where a destination puts people', () => {
  it('prefers floor with room to stand to the slivers round a table', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 14, 14)
    b.tableWithChairs('table-round-8', 7, 7)
    b.zone('waypoint', 4, 4, 10, 10, 'Around the table')
    const world = compile(b.build(), { cellSize: 0.1 })
    const record = world.waypoints[0]

    // Somebody sent to the gap between a chair and the table spends the whole
    // run shuffling against furniture, so those cells go while roomy ones last.
    expect(
      Math.min(...record.goalCells.map((cell) => world.clearance[cell])),
    ).toBeGreaterThanOrEqual(0.5)
    // 6 m square of 0.1 m cells is 3600. Five sixths of it survives; the table,
    // its ring of chairs and the gaps between them do not.
    expect(record.goalCells.length).toBeGreaterThan(2800)
    expect(record.goalCells.length).toBeLessThan(3200)
  })

  it('still offers a genuinely tight space rather than nowhere at all', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 20, 12)
    b.wall({ x: 9, y: 12 }, { x: 9, y: 9 })
    b.wall({ x: 9.8, y: 12 }, { x: 9.8, y: 9 })
    b.zone('waypoint', 9.2, 9.4, 9.6, 11.6, 'Alcove')
    const world = compile(b.build(), { cellSize: 0.1 })
    const record = world.waypoints[0]

    // Nothing in a 0.8 m alcove has half a metre of clearance. Insisting on it
    // would leave this destination one cell and stack everybody on that spot.
    expect(record.goalCells.length).toBeGreaterThan(15)
    expect(Math.max(...record.goalCells.map((cell) => world.clearance[cell]))).toBeLessThan(0.5)
  })

  it('falls back to the nearest floor when a destination is drawn on solid', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 20, 12)
    const column = b.place('column-square', 10, 6)
    b.zone('waypoint', 9.8, 5.8, 10.2, 6.2, 'On the column')
    const world = compile(b.build(), { cellSize: 0.2 })
    const record = world.waypoints[0]

    // A zone snapped onto a column owns no cell of its own. One cell beside it
    // beats none: an empty goal list is a flow field with no source, and
    // everybody routed here would stand where they were instead.
    expect(record.goalCells).toHaveLength(1)
    expect(world.navBlocked[record.goalCells[0]]).toBe(0)
    const c = centreOf(world, record.goalCells[0])
    expect(Math.hypot(c.x - column.position.x, c.y - column.position.y)).toBeLessThan(1)
  })

  it('files a seating area with the destinations and carries what it holds', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 20, 12)
    const stalls = b.zone('seating', 2, 2, 6, 6, 'Stalls')
    const bar = b.zone('waypoint', 12, 2, 16, 6, 'Bar area', { capacity: 25 })
    const world = compile(b.build(), { cellSize: 0.2 })

    expect(ids(world.waypoints)).toEqual([stalls.id, bar.id])
    expect(world.waypoints[0].kind).toBe('seating')
    expect(world.waypoints[0].area).toBeCloseTo(16, 6)
    expect(world.waypoints[0].center.x).toBeCloseTo(4, 6)
    expect(world.waypoints[0].center.y).toBeCloseTo(4, 6)
    // Capacity is what holds people back at a destination already full. A zone
    // that never said one is unlimited, not full.
    expect(world.waypoints[0].capacity).toBe(0)
    expect(world.waypoints[1].capacity).toBe(25)
  })

  it('stands somebody inside a goal cell wherever the dice fall', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 20, 12)
    b.zone('waypoint', 8, 5, 12, 7, 'Stage')
    const world = compile(b.build(), { cellSize: 0.2 })
    const record = world.waypoints[0]
    const draw = (...values: number[]) => {
      let i = 0
      return () => values[i++ % values.length]
    }

    // The jitter spreads arrivals over the cell they were given and has to stay
    // inside it: half a cell further and people would be placed on a neighbour
    // the destination never checked, which can be solid. Both ends of the draw
    // are swept, since it is the extremes that would escape.
    for (const pick of [0, 0.25, 0.5, 0.75, 0.999]) {
      const expected = record.goalCells[Math.floor(pick * record.goalCells.length)]
      const centre = centreOf(world, expected)
      for (const spin of [0, 0.5, 0.999]) {
        const p = samplePointInDestination(world, record, draw(pick, spin, spin))
        expect(cellAt(world, p.x, p.y)).toBe(expected)
        expect(Math.abs(p.x - centre.x)).toBeLessThan(world.grid.cellSize / 2)
        expect(Math.abs(p.y - centre.y)).toBeLessThan(world.grid.cellSize / 2)
      }
    }

    const nowhere: DestinationRecord = { ...record, goalCells: [] }
    const centre = samplePointInDestination(world, nowhere, () => 0.5)
    expect(centre).toEqual(nowhere.center)
    // A copy. The caller walks the point it is handed around, and handing back
    // the record's own centre would drag the destination across the plan.
    expect(centre).not.toBe(nowhere.center)
  })
})

describe('finding floor near a point', () => {
  const room = (): SimWorld => {
    const b = new PlanBuilder()
    b.room(0, 0, 20, 12)
    b.place('column-square', 10, 6)
    return compile(b.build(), { cellSize: 0.2 })
  }

  it('steps out of a column to the nearest cell somebody could stand on', () => {
    const world = room()
    const cell = nearestFreeCell(world.grid, world.navBlocked, { x: 10, y: 6 })
    const c = centreOf(world, cell)

    expect(world.navBlocked[cell]).toBe(0)
    // A 0.6 m column with the mask dilated by a body radius: the nearest floor
    // is most of a metre out, and it is out, not the column's own centre back.
    expect(Math.hypot(c.x - 10, c.y - 6)).toBeGreaterThan(0.5)
    expect(Math.hypot(c.x - 10, c.y - 6)).toBeLessThan(1)
  })

  it('answers for a point off the edge of the grid instead of reading past it', () => {
    const world = room()
    const cell = nearestFreeCell(world.grid, world.navBlocked, { x: 1000, y: 1000 })
    const c = centreOf(world, cell)

    // Clamped to the far corner and then walked in off the margin fence, which
    // is the outermost ring and blocked. Without the clamp the ring search
    // starts thousands of cells away, never reaches the grid inside its own
    // bound, and reports nothing free in a room that is mostly floor.
    expect(world.navBlocked[cell]).toBe(0)
    expect(world.bounds.maxX - c.x).toBeLessThan(2 * world.grid.cellSize)
    expect(world.bounds.maxY - c.y).toBeLessThan(2 * world.grid.cellSize)
  })

  it('reports no floor at all rather than handing back cell zero', () => {
    const world = room()
    // Cell zero is the corner of the margin fence, and a caller that trusted it
    // would stand somebody inside the fence and leave them stuck there.
    const sealed = new Uint8Array(world.grid.cols * world.grid.rows).fill(1)
    expect(nearestFreeCell(world.grid, sealed, { x: 10, y: 6 })).toBe(-1)
  })
})

describe('places to sit', () => {
  it('drops a seat nobody can reach and renumbers the rest', () => {
    const b = new PlanBuilder()
    b.room(0, 0, 10, 10)
    const middle = b.place('chair', 5, 5)
    b.place('chair', 0.2, 5)
    const corner = b.place('chair', 8, 8)
    const plan = b.build()
    const world = compile(plan, { cellSize: 0.1 })

    // A chair shoved into the west wall is a seat on the drawing and a trap in
    // the run: whoever is sent to it never arrives and never sits down.
    expect(planSeats(plan)).toHaveLength(3)
    expect(world.seats.map((seat) => seat.furnitureId)).toEqual([middle.id, corner.id])
    // `index` is a position in this list, and the engine holds one while
    // somebody walks to their seat. Numbering before the filter would seat them
    // on the chair that was dropped.
    expect(world.seats.map((seat) => seat.index)).toEqual([0, 1])
  })
})

describe('queues at a counter', () => {
  const SERVICE: Distribution = { kind: 'constant', mean: 20 }

  /** A bar across the north of a room, its queue running back into the floor. */
  const counter = (
    options: Partial<ServicePoint> = {},
    extras: (b: PlanBuilder) => void = () => {},
  ) => {
    const b = new PlanBuilder()
    b.room(0, 0, 20, 14)
    extras(b)
    const point = b.service('Bar', 10, 12, 0, 3, SERVICE, options)
    return { plan: b.build(), point }
  }

  it('lines people up away from the counter with everybody facing it', () => {
    const { plan, point } = counter()
    const world = compile(plan, { cellSize: 0.1 })
    const queue = world.queues[0]

    // The counter faces -Y, so the line runs south from it, head first.
    expect(queue.lineLength).toBeCloseTo(6, 6)
    expect(queue.spacing).toBeCloseTo(0.65, 6)
    expect(queue.slots).toHaveLength(10)
    expect(queue.slots[0].y).toBeCloseTo(10.65, 6)
    expect(queue.slots[9].y).toBeCloseTo(4.8, 6)
    expect(queue.overflowAnchor).toBe(queue.slots[9])
    expect(queue.overflowDirection.y).toBeCloseTo(-1, 6)
    for (const facing of queue.slotFacing) expect(facing).toBeCloseTo(Math.PI / 2, 6)

    // Staff behind the counter, the person being served in front of it, one of
    // each per staffed position.
    expect(queue.serverCount).toBe(3)
    expect(queue.servers).toHaveLength(3)
    expect(queue.stations).toHaveLength(3)
    expect(queue.servers[0].y).toBeGreaterThan(point.position.y)
    expect(queue.stations[0].y).toBeLessThan(point.position.y)
    expect(servicePositionFor(queue, 3)).toBe(queue.stations[0])
    expect(queue.serviceTime).toBe(point.serviceTime)
  })

  it('sends people to the back of the line rather than at the counter', () => {
    const world = compile(counter().plan, { cellSize: 0.1 })
    const queue = world.queues[0]
    const centres = queue.goalCells.map((cell) => centreOf(world, cell))

    // A box a slot wide either side of the tail, so around 169 cells at 0.1 m.
    // A single cell would funnel the whole approach through one point.
    expect(centres.length).toBeGreaterThan(140)
    expect(centres.length).toBeLessThan(200)
    for (const c of centres) {
      // A flow field aimed at the counter walks everybody into the side of the
      // line. Aimed at the tail, they join it.
      const reach = queue.spacing + world.grid.cellSize
      expect(Math.abs(c.x - queue.overflowAnchor.x)).toBeLessThanOrEqual(reach)
      expect(Math.abs(c.y - queue.overflowAnchor.y)).toBeLessThanOrEqual(reach)
    }
  })

  it('keeps every waiting position on floor somebody can stand on', () => {
    const clear = compile(counter().plan, { cellSize: 0.1 }).queues[0]
    const blocked = compile(counter({}, (b) => b.place('column-square', 10, 8)).plan, {
      cellSize: 0.1,
    })
    const obstructed = blocked.queues[0]

    // The drawn line runs dead straight down the middle of the room...
    expect(Math.max(...clear.slots.map((slot) => Math.abs(slot.x - 10)))).toBeLessThan(1e-9)
    // ...and through a column somebody later put in the way of it. The position
    // that landed inside steps aside; it does not become a place nobody reaches
    // and the line does not lose its length over it.
    expect(obstructed.slots).toHaveLength(clear.slots.length)
    expect(obstructed.slots.filter((slot) => Math.abs(slot.x - 10) > 0.3)).toHaveLength(1)
    for (const slot of obstructed.slots) {
      expect(blocked.navBlocked[cellAt(blocked, slot.x, slot.y)]).toBe(0)
    }
  })

  it('carries the line on past its last drawn place when more people come', () => {
    const world = compile(counter().plan, { cellSize: 0.1 })
    const queue = world.queues[0]
    const last = queue.slots.length

    expect(queueSlotPosition(queue, last - 1)).toBe(queue.slots[last - 1])
    expect(queueSlotPosition(queue, last).y).toBeCloseTo(4.8 - queue.spacing, 6)
    expect(queueSlotPosition(queue, last + 1).y).toBeCloseTo(4.8 - 2 * queue.spacing, 6)
    // Facing back up the line, the way everybody already in it faces. Somebody
    // joining the overflow should not be the one person turned around.
    expect(queueSlotFacing(queue, last)).toBeCloseTo(queue.slotFacing[0], 6)
  })

  it('will not pack a queue tighter than people stand or staff it with nobody', () => {
    const world = compile(counter({ queueSpacing: 0.1, servers: 0.4 }).plan, { cellSize: 0.2 })
    const queue = world.queues[0]

    expect(queue.spacing).toBeCloseTo(0.35, 6)
    expect(queue.serverCount).toBe(1)
    expect(queue.stations).toHaveLength(1)
    // A counter that never said when it works is open from the start and never
    // shuts, rather than closed for the whole run.
    expect(queue.opensAt).toBe(0)
    expect(queue.closesAt).toBe(Infinity)

    const scheduled = compile(counter({ opensAt: 60, closesAt: 600 }).plan, { cellSize: 0.2 })
      .queues[0]
    expect(scheduled.opensAt).toBe(60)
    expect(scheduled.closesAt).toBe(600)
  })

  it('grows a queue too short to hold two people away from its counter', () => {
    const { plan, point } = counter({
      queue: [
        { x: 10, y: 10.65 },
        { x: 10, y: 10.45 },
      ],
    })
    const queue = compile(plan, { cellSize: 0.2 }).queues[0]

    // A 0.2 m line holds one person, and with only one waiting position there is
    // no pair of them to read a direction from. The counter's own facing is what
    // is left, and it has to be used the right way round: pointing the overflow
    // the other way would grow the line through the counter and the staff.
    expect(queue.slots).toHaveLength(1)
    expect(queue.overflowDirection.x).toBeCloseTo(0, 6)
    expect(queue.overflowDirection.y).toBeCloseTo(-1, 6)
    expect(queueSlotPosition(queue, 1).y).toBeCloseTo(10.65 - queue.spacing, 6)
    expect(queueSlotPosition(queue, 4).y).toBeCloseTo(10.65 - 4 * queue.spacing, 6)
    // Everybody in it faces the counter, the one at the front included.
    expect(queue.slotFacing[0]).toBeCloseTo(Math.PI / 2, 6)
    expect(queueSlotFacing(queue, 1)).toBeCloseTo(Math.PI / 2, 6)
    expect(queue.slots[0].y).toBeLessThan(point.position.y)
  })

  it('answers to its id in the same index as the places people are sent', () => {
    const b = new PlanBuilder()
    const room = b.room(0, 0, 20, 14)
    const way = b.door(room.south, 10, DEFAULT_DOUBLE_DOOR_WIDTH, 'door', 'both')
    const point = b.service('Bar', 10, 12, 0, 2, SERVICE)
    const world = compile(b.build(), { cellSize: 0.2 })

    // An itinerary names a counter exactly as it names a room, so both live in
    // one map and this is where the engine tells them apart.
    expect(world.targets.get(point.id)).toBe(world.queues[0])
    expect(isQueueRecord(world.targets.get(point.id)!)).toBe(true)
    expect(isQueueRecord(world.targets.get(way.id)!)).toBe(false)
  })
})

describe('what the world says about itself', () => {
  const venue = (margin: number): SimWorld => {
    const b = new PlanBuilder()
    const room = b.room(0, 0, 20, 12)
    b.door(room.south, 10, DEFAULT_DOUBLE_DOOR_WIDTH, 'door', 'entry')
    return compile(b.build(), { cellSize: 0.2, margin })
  }

  it('fences the grid so nobody walks off the edge of the world', () => {
    const world = venue(2)
    const { grid } = world
    for (let col = 0; col < grid.cols; col++) {
      expect(world.navBlocked[gridIndex(grid, col, 0)]).toBe(1)
      expect(world.navBlocked[gridIndex(grid, col, grid.rows - 1)]).toBe(1)
    }
    for (let row = 0; row < grid.rows; row++) {
      expect(world.navBlocked[gridIndex(grid, 0, row)]).toBe(1)
      expect(world.navBlocked[gridIndex(grid, grid.cols - 1, row)]).toBe(1)
    }

    // The fence is not geometry. Marking it solid would put a phantom wall in
    // the clearance field, which is what corner-shaving and density read.
    expect(world.solid[gridIndex(grid, 0, 0)]).toBe(0)
    // And it leaves the approach outside the front door walkable, which is the
    // whole reason there is a margin.
    expect(world.navBlocked[cellAt(world, 10, -1)]).toBe(0)
  })

  it('reports the floor inside the venue, not the ground the grid covers', () => {
    const tight = venue(2)
    const roomy = venue(6)
    const awkward = venue(3.37)

    // 20 x 12 to the wall centrelines leaves about 19.6 by 11.6 of floor. The
    // figure is printed as "Walkable floor area" next to the peak density, so a
    // reader divides one by the other; counting the unblocked margin too put it
    // at 367 m² here and made every person per square metre come out low.
    expect(tight.stats.walkableArea).toBeGreaterThan(19.4 * 11.4)
    expect(tight.stats.walkableArea).toBeLessThan(19.7 * 11.7)

    // And the answer is a fact about the venue, so a simulation setting cannot
    // move it — not even one that lands the grid on different cell centres.
    expect(roomy.stats.walkableArea).toBeCloseTo(tight.stats.walkableArea, 6)
    expect(awkward.stats.walkableArea).toBeCloseTo(tight.stats.walkableArea, 6)

    // `freeCells` still counts the whole grid, margin included; it is what the
    // area is derived from that changed, and the gap between them is the margin.
    expect(tight.stats.freeCells + tight.stats.blockedCells).toBe(tight.grid.cols * tight.grid.rows)
    expect(tight.stats.walkableArea).toBeLessThan(
      0.8 * tight.stats.freeCells * tight.grid.cellSize * tight.grid.cellSize,
    )
  })
})
