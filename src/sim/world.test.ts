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
import { buildWorld, type BuildWorldOptions, type SimWorld } from './world'
import { PlanBuilder } from '../library/planBuilder'
import { createScenario } from '../core/model/defaults'
import { cellCenter, gridIndex, solveEikonal, worldToCell } from './nav/eikonal'
import { planSeats } from '../core/model/planGeometry'
import { DEFAULT_DOOR_WIDTH, DEFAULT_DOUBLE_DOOR_WIDTH } from '../core/model/standards'
import type { Vec2 } from '../core/math/vec2'
import type { Plan } from '../core/model/types'

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
    // an eikonal solve nobody waits for. The budget wins, and says so: the
    // resolution is an order of magnitude coarser than the door wanted.
    expect(world.grid.cellSize).toBeGreaterThan(0.9)
    expect(world.grid.cols * world.grid.rows).toBeLessThan(410_000)
  })

  it('refuses to go finer than a body can use', () => {
    const b = new PlanBuilder()
    const room = b.room(0, 0, 10, 8)
    // Not a door anybody hangs, but a plan gets drawn with one. Eight cells
    // across it would be 37 mm, and a person is 0.46 m across.
    b.door(room.south, 5, 0.3)

    expect(compile(b.build()).grid.cellSize).toBeCloseTo(0.05, 6)
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
    expect(centres.length).toBeGreaterThan(4)
    for (const c of centres) {
      expect(Math.abs(c.x - 5)).toBeLessThan(DEFAULT_DOUBLE_DOOR_WIDTH / 2 + world.grid.cellSize)
    }
    // The threshold straddles the wall, so somebody outside can aim at it and
    // somebody inside can leave through it.
    expect(centres.some((c) => c.y < 0)).toBe(true)
    expect(centres.some((c) => c.y > 0)).toBe(true)
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
