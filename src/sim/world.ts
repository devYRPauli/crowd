/**
 * The simulated world.
 *
 * A `SimWorld` is the compiled form of a plan: the navigation grid and its
 * masks, the exact obstacle edges people collide with, and the flattened lists
 * of destinations, seats, queues and counters the behaviour layer works
 * against. Compiling once, up front, keeps the per-tick loop free of any
 * document lookups.
 */

import type { Vec2 } from '../core/math/vec2'
import { add, distance, fromAngle, normalize, scale, sub } from '../core/math/vec2'
import type { Bounds, Polygon } from '../core/math/geometry'
import {
  boundsOf,
  pointInPolygon,
  polygonCentroid,
  polygonArea,
  rectPolygon,
  samplePolyline,
  polylineLength,
} from '../core/math/geometry'
import type { Distribution } from '../core/math/random'
import type { Plan, Scenario, Zone } from '../core/model/types'
import {
  furniturePolygon,
  isFurnitureBlocking,
  planBounds,
  planSeats,
  servicePositions,
  serverPositions,
  serviceFacing,
  servicePolygon,
  serviceQueue,
  solidSpans,
  wallDirection,
  type WorldSeat,
} from '../core/model/planGeometry'
import { perp } from '../core/math/vec2'
import type { NavGrid } from './nav/eikonal'
import {
  cellCenter,
  clearanceField,
  createNavGrid,
  gridIndex,
  rasterizePolygon,
  worldToCell,
} from './nav/eikonal'
import type { OrcaObstacle } from './avoidance/orca'
import { buildObstacles } from './avoidance/orca'

/** Nominal body radius used when dilating the navigation mask. */
export const NAV_CLEARANCE = 0.26

export interface SeatRecord extends WorldSeat {
  index: number
}

export interface QueueRecord {
  id: string
  name: string
  /** Counter footprint, for drawing and for obstacle building. */
  polygon: Polygon
  /** Where staff stand, behind the counter. */
  servers: Vec2[]
  /** Where a person stands to be served, in front of the counter. */
  stations: Vec2[]
  serverCount: number
  /** The queue centreline, head first. */
  line: Vec2[]
  lineLength: number
  /** Waiting positions, head first. */
  slots: Vec2[]
  /** Direction people face while queuing, per slot. */
  slotFacing: number[]
  /** Where the queue tail continues when every slot is taken. */
  overflowAnchor: Vec2
  overflowDirection: Vec2
  spacing: number
  serviceTime: Distribution
  opensAt: number
  closesAt: number
  /** Grid cells used as the flow-field goal for people heading here. */
  goalCells: number[]
  approach: Vec2
}

export interface DestinationRecord {
  id: string
  name: string
  kind: Zone['kind']
  polygon: Polygon
  center: Vec2
  area: number
  goalCells: number[]
  capacity: number
}

export interface WorldStats {
  /** Walkable floor area in square metres. */
  walkableArea: number
  blockedCells: number
  freeCells: number
}

export interface SimWorld {
  bounds: Bounds
  grid: NavGrid
  /** 1 where an agent centre cannot go (solid, dilated by NAV_CLEARANCE). */
  navBlocked: Uint8Array
  /** 1 where geometry is solid, undilated. */
  solid: Uint8Array
  /** Metres to the nearest solid cell. */
  clearance: Float32Array
  /** Base traversal speed multiplier in (0, 1]; keep-clear zones lower it. */
  baseSpeed: Float32Array
  obstacles: OrcaObstacle[]
  obstaclePolygons: Polygon[]
  entries: DestinationRecord[]
  exits: DestinationRecord[]
  waypoints: DestinationRecord[]
  measures: DestinationRecord[]
  queues: QueueRecord[]
  seats: SeatRecord[]
  stats: WorldStats
  /** Index from id to record, covering every destination and queue. */
  targets: Map<string, DestinationRecord | QueueRecord>
}

const isQueue = (value: DestinationRecord | QueueRecord): value is QueueRecord =>
  (value as QueueRecord).slots !== undefined

export const isQueueRecord = isQueue

/** Grid cells whose centres lie inside the polygon and are not solid. */
const cellsInPolygon = (grid: NavGrid, polygon: readonly Vec2[], blocked: Uint8Array): number[] => {
  const b = boundsOf(polygon)
  const min = worldToCell(grid, b.minX, b.minY)
  const max = worldToCell(grid, b.maxX, b.maxY)
  const out: number[] = []
  for (let row = Math.max(0, min.row); row <= Math.min(grid.rows - 1, max.row); row++) {
    for (let col = Math.max(0, min.col); col <= Math.min(grid.cols - 1, max.col); col++) {
      const index = gridIndex(grid, col, row)
      if (blocked[index]) continue
      const c = cellCenter(grid, col, row)
      if (pointInPolygon(c, polygon)) out.push(index)
    }
  }
  return out
}

/** Nearest free cell to a point, searched outward in rings. */
export const nearestFreeCell = (grid: NavGrid, blocked: Uint8Array, p: Vec2): number => {
  const { col, row } = worldToCell(grid, p.x, p.y)
  const maxRing = Math.max(grid.cols, grid.rows)
  for (let ring = 0; ring < maxRing; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue
        const c = col + dx
        const r = row + dy
        if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) continue
        const index = gridIndex(grid, c, r)
        if (!blocked[index]) return index
      }
    }
  }
  return -1
}

/**
 * Prefer cells with room to stand in.
 *
 * A destination polygon drawn over a dining floor includes the slivers between
 * a table and its chairs. Nobody chooses to stand wedged in there, and sending
 * someone to one produces a person who spends the whole run shuffling against
 * furniture. Cells with real clearance are used when enough of them exist; the
 * cramped ones stay available as a fallback so a genuinely tight space still
 * works.
 */
const preferOpenCells = (cells: number[], clearance: Float32Array, minClearance = 0.5): number[] => {
  const open = cells.filter((cell) => clearance[cell] >= minClearance)
  return open.length >= Math.max(4, cells.length * 0.15) ? open : cells
}

const destinationFrom = (
  zone: Zone,
  grid: NavGrid,
  blocked: Uint8Array,
  clearance: Float32Array,
): DestinationRecord => {
  const cells = preferOpenCells(cellsInPolygon(grid, zone.polygon, blocked), clearance)
  const center = polygonCentroid(zone.polygon)
  if (cells.length === 0) {
    const fallback = nearestFreeCell(grid, blocked, center)
    if (fallback >= 0) cells.push(fallback)
  }
  return {
    id: zone.id,
    name: zone.name,
    kind: zone.kind,
    polygon: zone.polygon,
    center,
    area: polygonArea(zone.polygon),
    goalCells: cells,
    capacity: zone.capacity ?? 0,
  }
}

/** Solid regions people must walk around, as counter-clockwise polygons. */
export const collectObstaclePolygons = (plan: Plan): Polygon[] => {
  const polys: Polygon[] = []
  for (const wall of plan.walls) {
    const dir = wallDirection(wall)
    const n = perp(dir)
    const half = wall.thickness / 2
    for (const span of solidSpans(wall, plan.openings)) {
      const p0 = add(wall.a, scale(dir, span.start))
      const p1 = add(wall.a, scale(dir, span.end))
      if (distance(p0, p1) < 1e-4) continue
      polys.push([
        { x: p0.x - n.x * half, y: p0.y - n.y * half },
        { x: p1.x - n.x * half, y: p1.y - n.y * half },
        { x: p1.x + n.x * half, y: p1.y + n.y * half },
        { x: p0.x + n.x * half, y: p0.y + n.y * half },
      ])
    }
  }
  for (const item of plan.furniture) {
    if (!isFurnitureBlocking(item)) continue
    polys.push(furniturePolygon(item))
  }
  for (const sp of plan.servicePoints) polys.push(servicePolygon(sp))
  for (const zone of plan.zones) {
    if (zone.kind === 'obstacle') polys.push(zone.polygon)
  }
  return polys
}

export interface BuildWorldOptions {
  /** Navigation grid resolution. Smaller is more accurate and slower. */
  cellSize?: number
  /** Padding added around the plan so people can approach from outside. */
  margin?: number
}

export const buildWorld = (
  plan: Plan,
  scenario: Scenario,
  options: BuildWorldOptions = {},
): SimWorld => {
  const margin = options.margin ?? 2
  const bounds = planBounds(plan, margin)
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
  // Keep the grid under ~400k cells however large the venue is.
  const cellSize = options.cellSize ?? Math.max(0.2, Math.min(0.5, span / 420))
  const grid = createNavGrid(bounds, cellSize)
  const cells = grid.cols * grid.rows

  const solid = new Uint8Array(cells)
  const navBlocked = new Uint8Array(cells)
  const baseSpeed = new Float32Array(cells).fill(1)

  const obstaclePolygons = collectObstaclePolygons(plan)
  for (const poly of obstaclePolygons) {
    // Dilate by half a cell before rasterising: a 150 mm wall is thinner than a
    // grid cell and would otherwise fall between cell centres and vanish from
    // the mask entirely, taking the clearance field with it.
    rasterizePolygon(grid, poly, solid, 1, cellSize * 0.5)
    rasterizePolygon(grid, poly, navBlocked, 1, NAV_CLEARANCE)
  }

  // Everything outside the outer walls is unreachable anyway, but a plan can be
  // open-sided; the margin ring keeps agents from wandering off the grid.
  for (let col = 0; col < grid.cols; col++) {
    navBlocked[gridIndex(grid, col, 0)] = 1
    navBlocked[gridIndex(grid, col, grid.rows - 1)] = 1
  }
  for (let row = 0; row < grid.rows; row++) {
    navBlocked[gridIndex(grid, 0, row)] = 1
    navBlocked[gridIndex(grid, grid.cols - 1, row)] = 1
  }

  for (const zone of plan.zones) {
    if (zone.kind !== 'keep-clear') continue
    const cost = Math.max(1, zone.cost ?? 4)
    const mask = new Uint8Array(cells)
    rasterizePolygon(grid, zone.polygon, mask, 1, 0)
    for (let i = 0; i < cells; i++) if (mask[i]) baseSpeed[i] = Math.min(baseSpeed[i], 1 / cost)
  }

  // Signed clearance: positive is metres to the nearest solid, negative is
  // metres inside one. Keeping the sign means the gradient still points out of
  // a wall when somebody has been pressed into it, which is exactly the case
  // where a plain distance field gives no useful direction at all.
  const outside = clearanceField(grid, solid)
  const inverted = new Uint8Array(cells)
  for (let i = 0; i < cells; i++) inverted[i] = solid[i] ? 0 : 1
  const inside = clearanceField(grid, inverted)
  const clearance = new Float32Array(cells)
  for (let i = 0; i < cells; i++) {
    clearance[i] = solid[i] ? -inside[i] : outside[i]
  }

  const entries: DestinationRecord[] = []
  const exits: DestinationRecord[] = []
  const waypoints: DestinationRecord[] = []
  const measures: DestinationRecord[] = []
  for (const zone of plan.zones) {
    const record = destinationFrom(zone, grid, navBlocked, clearance)
    if (zone.kind === 'entry') entries.push(record)
    else if (zone.kind === 'exit') exits.push(record)
    else if (zone.kind === 'measure') measures.push(record)
    else if (zone.kind === 'waypoint' || zone.kind === 'seating') waypoints.push(record)
  }

  const queues: QueueRecord[] = plan.servicePoints.map((sp) => {
    const line = serviceQueue(sp)
    const spacing = Math.max(0.35, sp.queueSpacing)
    const length = polylineLength(line)
    const slotCount = Math.max(1, Math.floor(length / spacing) + 1)
    // A queue can be drawn across a table or through a column. Snapping each
    // waiting position onto walkable floor keeps the line usable instead of
    // sending people to stand somewhere they can never reach.
    const slots = samplePolyline(line, spacing, slotCount).map((slot) => {
      const { col, row } = worldToCell(grid, slot.x, slot.y)
      const inside =
        col >= 0 && row >= 0 && col < grid.cols && row < grid.rows &&
        !navBlocked[gridIndex(grid, col, row)]
      if (inside) return slot
      const cell = nearestFreeCell(grid, navBlocked, slot)
      if (cell < 0) return slot
      return cellCenter(grid, cell % grid.cols, (cell / grid.cols) | 0)
    })
    const slotFacing = slots.map((_, i) => {
      const ahead = slots[Math.max(0, i - 1)]
      const here = slots[i]
      const dir = i === 0 ? sub(sp.position, here) : sub(ahead, here)
      return Math.atan2(dir.y, dir.x)
    })
    const tail = slots[slots.length - 1]
    const beforeTail = slots[Math.max(0, slots.length - 2)]
    const overflowDirection =
      slots.length > 1 ? normalize(sub(tail, beforeTail)) : scale(serviceFacing(sp), 1)
    const approach = slots[slots.length - 1]
    return {
      id: sp.id,
      name: sp.name,
      polygon: servicePolygon(sp),
      line,
      lineLength: length,
      servers: serverPositions(sp),
      stations: servicePositions(sp),
      serverCount: Math.max(1, Math.floor(sp.servers)),
      slots,
      slotFacing,
      overflowAnchor: tail,
      overflowDirection,
      spacing,
      serviceTime: sp.serviceTime,
      opensAt: sp.opensAt ?? 0,
      closesAt: sp.closesAt ?? Infinity,
      goalCells: [],
      approach,
    }
  })

  // The flow-field goal for a queue is its tail, so people walk to the back of
  // the line rather than pushing towards the counter.
  for (const queue of queues) {
    const tailPoly = rectPolygon(queue.overflowAnchor, queue.spacing * 2, queue.spacing * 2, 0)
    const cellsAt = cellsInPolygon(grid, tailPoly, navBlocked)
    if (cellsAt.length === 0) {
      const fallback = nearestFreeCell(grid, navBlocked, queue.overflowAnchor)
      if (fallback >= 0) cellsAt.push(fallback)
    }
    queue.goalCells = cellsAt
  }

  // Only offer seats somebody can actually get to. A chair pushed against a
  // wall, or one that ended up inside the stage, is a seat on the drawing and
  // a trap in the simulation.
  const seats: SeatRecord[] = planSeats(plan)
    .filter((seat) => {
      const { col, row } = worldToCell(grid, seat.position.x, seat.position.y)
      if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return false
      return !navBlocked[gridIndex(grid, col, row)]
    })
    .map((seat, index) => ({ ...seat, index }))

  let freeCells = 0
  for (let i = 0; i < cells; i++) if (!solid[i]) freeCells++

  const targets = new Map<string, DestinationRecord | QueueRecord>()
  for (const record of [...entries, ...exits, ...waypoints, ...measures]) targets.set(record.id, record)
  for (const queue of queues) targets.set(queue.id, queue)

  void scenario

  return {
    bounds,
    grid,
    navBlocked,
    solid,
    clearance,
    baseSpeed,
    obstacles: buildObstacles(obstaclePolygons),
    obstaclePolygons,
    entries,
    exits,
    waypoints,
    measures,
    queues,
    seats,
    stats: {
      walkableArea: freeCells * cellSize * cellSize,
      blockedCells: cells - freeCells,
      freeCells,
    },
    targets,
  }
}

/** A point inside a destination that an agent can actually stand on. */
export const samplePointInDestination = (
  world: SimWorld,
  record: DestinationRecord,
  random: () => number,
): Vec2 => {
  if (record.goalCells.length === 0) return { ...record.center }
  const index = record.goalCells[Math.floor(random() * record.goalCells.length)]
  const col = index % world.grid.cols
  const row = (index / world.grid.cols) | 0
  const c = cellCenter(world.grid, col, row)
  const jitter = world.grid.cellSize * 0.4
  return { x: c.x + (random() - 0.5) * jitter, y: c.y + (random() - 0.5) * jitter }
}

/** Where a person stands to be served at a given server position. */
export const servicePositionFor = (queue: QueueRecord, serverIndex: number): Vec2 =>
  queue.stations[serverIndex % queue.stations.length]

export const queueSlotPosition = (queue: QueueRecord, slot: number): Vec2 => {
  if (slot < queue.slots.length) return queue.slots[slot]
  const extra = slot - queue.slots.length + 1
  return add(queue.overflowAnchor, scale(queue.overflowDirection, extra * queue.spacing))
}

export const queueSlotFacing = (queue: QueueRecord, slot: number): number => {
  if (slot < queue.slotFacing.length) return queue.slotFacing[slot]
  const dir = scale(queue.overflowDirection, -1)
  return Math.atan2(dir.y, dir.x)
}

export const directionTo = (from: Vec2, to: Vec2): Vec2 => normalize(sub(to, from))

export const facingFromAngle = (angle: number): Vec2 => fromAngle(angle)
