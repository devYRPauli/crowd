/**
 * Derived geometry.
 *
 * The document stores intent (a wall runs from A to B and is 0.1 m thick); the
 * renderer and the simulation both need the consequences (that wall's footprint
 * polygon, the gaps its doors leave, where its chairs put people). Those
 * consequences are computed here, once, and shared — so the picture on screen
 * and the world people walk through can never disagree.
 */

import type { Vec2 } from '../math/vec2'
import { add, angleOf, distance, fromAngle, normalize, perp, scale, sub } from '../math/vec2'
import type { Bounds, Polygon } from '../math/geometry'
import {
  EMPTY_BOUNDS,
  boundsOf,
  circlePolygon,
  pointInPolygon,
  polygonCentroid,
  rectPolygon,
  unionBounds,
} from '../math/geometry'
import type { FurnitureItem, Opening, Plan, ServicePoint, Wall, Zone } from './types'
import { resolveCatalogItem, type SeatSlot } from '../../library/catalog'

/** Openings at floor level let people through; windows and high gates do not. */
export const isWalkableOpening = (opening: Opening): boolean =>
  opening.sill <= 0.02 && opening.kind !== 'window'

export const wallLength = (wall: Wall): number => distance(wall.a, wall.b)

export const wallDirection = (wall: Wall): Vec2 => normalize(sub(wall.b, wall.a))

export const wallAngle = (wall: Wall): number => angleOf(sub(wall.b, wall.a))

export const wallCenter = (wall: Wall): Vec2 => ({
  x: (wall.a.x + wall.b.x) / 2,
  y: (wall.a.y + wall.b.y) / 2,
})

/** Point at distance `t` along the wall centreline from `a`. */
export const pointOnWall = (wall: Wall, t: number): Vec2 =>
  add(wall.a, scale(wallDirection(wall), t))

/** The wall's rectangular footprint, counter-clockwise. */
export const wallPolygon = (wall: Wall, inflate = 0): Polygon => {
  const dir = wallDirection(wall)
  const n = perp(dir)
  const half = wall.thickness / 2 + inflate
  const a = add(wall.a, scale(dir, -inflate))
  const b = add(wall.b, scale(dir, inflate))
  return [
    { x: a.x - n.x * half, y: a.y - n.y * half },
    { x: b.x - n.x * half, y: b.y - n.y * half },
    { x: b.x + n.x * half, y: b.y + n.y * half },
    { x: a.x + n.x * half, y: a.y + n.y * half },
  ]
}

export interface WallSpan {
  /** Distance along the wall from `a`. */
  start: number
  end: number
}

/**
 * The stretches of a wall that remain solid at floor level once walkable
 * openings are removed. Overlapping openings are merged.
 */
/**
 * The patch of floor an opening covers, straddling its wall.
 *
 * A door that people arrive or leave through needs somewhere to *be* — a
 * destination with area, not a line — and the honest one is the doorway itself:
 * as wide as the leaf and deep enough to stand on either side of the threshold.
 * Deriving it from the opening rather than asking an author to draw a zone near
 * one is what makes the door's own clear width meter the flow, which is the
 * number every egress calculation turns on.
 */
export const openingThreshold = (wall: Wall, opening: Opening, reach = 0.4): Polygon => {
  const dir = wallDirection(wall)
  const n = perp(dir)
  const halfWidth = opening.width / 2
  const halfDepth = wall.thickness / 2 + reach
  const centre = add(wall.a, scale(dir, opening.offset))
  const corner = (alongSign: number, acrossSign: number): Vec2 => ({
    x: centre.x + dir.x * halfWidth * alongSign + n.x * halfDepth * acrossSign,
    y: centre.y + dir.y * halfWidth * alongSign + n.y * halfDepth * acrossSign,
  })
  return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]
}

export const solidSpans = (wall: Wall, openings: readonly Opening[]): WallSpan[] => {
  const length = wallLength(wall)
  const gaps = openings
    .filter((o) => o.wallId === wall.id && isWalkableOpening(o))
    .map((o) => ({
      start: Math.max(0, o.offset - o.width / 2),
      end: Math.min(length, o.offset + o.width / 2),
    }))
    .filter((g) => g.end > g.start)
    .sort((a, b) => a.start - b.start)

  const merged: WallSpan[] = []
  for (const gap of gaps) {
    const last = merged[merged.length - 1]
    if (last && gap.start <= last.end + 1e-6) last.end = Math.max(last.end, gap.end)
    else merged.push({ ...gap })
  }

  const spans: WallSpan[] = []
  let cursor = 0
  for (const gap of merged) {
    if (gap.start > cursor + 1e-6) spans.push({ start: cursor, end: gap.start })
    cursor = Math.max(cursor, gap.end)
  }
  if (cursor < length - 1e-6) spans.push({ start: cursor, end: length })
  return spans
}

/** A straight impassable edge used by the simulation's obstacle handling. */
export interface ObstacleSegment {
  a: Vec2
  b: Vec2
  /** Height above the floor; low barriers still block movement but not sight. */
  height: number
  sourceId: string
}

/** Every solid wall stretch as a pair of collision edges offset by half thickness. */
export const wallObstacleSegments = (plan: Plan): ObstacleSegment[] => {
  const out: ObstacleSegment[] = []
  for (const wall of plan.walls) {
    const dir = wallDirection(wall)
    const n = perp(dir)
    const half = wall.thickness / 2
    for (const span of solidSpans(wall, plan.openings)) {
      const p0 = add(wall.a, scale(dir, span.start))
      const p1 = add(wall.a, scale(dir, span.end))
      for (const side of [-1, 1]) {
        out.push({
          a: { x: p0.x + n.x * half * side, y: p0.y + n.y * half * side },
          b: { x: p1.x + n.x * half * side, y: p1.y + n.y * half * side },
          height: wall.height,
          sourceId: wall.id,
        })
      }
      // Cap the ends so people cannot slip through the thickness at a doorway.
      out.push({
        a: { x: p0.x - n.x * half, y: p0.y - n.y * half },
        b: { x: p0.x + n.x * half, y: p0.y + n.y * half },
        height: wall.height,
        sourceId: wall.id,
      })
      out.push({
        a: { x: p1.x - n.x * half, y: p1.y - n.y * half },
        b: { x: p1.x + n.x * half, y: p1.y + n.y * half },
        height: wall.height,
        sourceId: wall.id,
      })
    }
  }
  return out
}

export const furnitureSize = (item: FurnitureItem) => {
  const entry = resolveCatalogItem(item.catalogId)
  return item.size ?? entry.size
}

export const isFurnitureBlocking = (item: FurnitureItem): boolean =>
  item.blocking ?? resolveCatalogItem(item.catalogId).blocking

/** The footprint people must walk around. */
export const furniturePolygon = (item: FurnitureItem, inflate = 0): Polygon => {
  const entry = resolveCatalogItem(item.catalogId)
  const size = furnitureSize(item)
  const inset = entry.inset
  if (entry.footprint === 'circle') {
    const r = Math.max(0.02, Math.min(size.width, size.depth) / 2 - inset + inflate)
    return circlePolygon(item.position, r, 14)
  }
  return rectPolygon(
    item.position,
    Math.max(0.02, size.width - inset * 2 + inflate * 2),
    Math.max(0.02, size.depth - inset * 2 + inflate * 2),
    item.rotation,
  )
}

/** Visual extent, ignoring the collision inset. */
export const furnitureVisualPolygon = (item: FurnitureItem): Polygon => {
  const size = furnitureSize(item)
  return rectPolygon(item.position, size.width, size.depth, item.rotation)
}

export interface WorldSeat {
  id: string
  furnitureId: string
  position: Vec2
  /** Direction the seated person faces, in world radians. */
  facing: number
  kind: SeatSlot['kind']
}

/** Two places closer than this are one place. */
const SAME_SEAT = 0.2

/** Every seat and standing place the plan offers, in world coordinates. */
export const planSeats = (plan: Plan): WorldSeat[] => {
  const out: WorldSeat[] = []
  for (const item of plan.furniture) {
    const entry = resolveCatalogItem(item.catalogId)
    if (!entry.seats) continue
    const size = furnitureSize(item)
    const slots = entry.seats(size)
    const c = Math.cos(item.rotation)
    const s = Math.sin(item.rotation)
    slots.forEach((slot, index) => {
      const position = {
        x: item.position.x + slot.x * c - slot.z * s,
        y: item.position.y + slot.x * s + slot.z * c,
      }
      // A table offers its covers and a chair set at one offers its seat, at
      // the same spot. Counted twice, two guests claimed every chair and the
      // one pushed off it sat down wherever they were shoved.
      if (out.some((seat) => distance(seat.position, position) < SAME_SEAT)) return
      out.push({
        id: `${item.id}:${index}`,
        furnitureId: item.id,
        position,
        facing: slot.facing + item.rotation,
        kind: slot.kind,
      })
    })
  }
  return out
}

/** The counter footprint of a service point. */
export const servicePolygon = (point: ServicePoint, inflate = 0): Polygon =>
  rectPolygon(point.position, point.width + inflate * 2, point.depth + inflate * 2, point.rotation)

/** Unit vector pointing away from the counter face, towards the people served. */
export const serviceFacing = (point: ServicePoint): Vec2 => fromAngle(point.rotation - Math.PI / 2)

const serverOffsets = (point: ServicePoint): Vec2[] => {
  const along = fromAngle(point.rotation)
  const n = Math.max(1, Math.floor(point.servers))
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0 : (i / (n - 1) - 0.5) * (point.width - 0.6)
    return add(point.position, scale(along, t))
  })
}

/** Where staff stand: behind the counter, on the opposite side from the queue. */
export const serverPositions = (point: ServicePoint): Vec2[] => {
  const out = serviceFacing(point)
  return serverOffsets(point).map((base) => add(base, scale(out, -(point.depth / 2 + 0.5))))
}

/** Where a person stands to be served: in front of the counter, facing it. */
export const servicePositions = (point: ServicePoint): Vec2[] => {
  const out = serviceFacing(point)
  return serverOffsets(point).map((base) => add(base, scale(out, point.depth / 2 + 0.45)))
}

/** The queue centreline, generated straight out from the counter when unset. */
export const serviceQueue = (point: ServicePoint): Vec2[] => {
  if (point.queue && point.queue.length >= 2) return point.queue
  const out = serviceFacing(point)
  const head = add(point.position, scale(out, point.depth / 2 + 1.0))
  const tail = add(head, scale(out, 6))
  return [head, tail]
}

export const zonePolygon = (zone: Zone): Polygon => zone.polygon

export const zoneCenter = (zone: Zone): Vec2 => polygonCentroid(zone.polygon)

export const pointInZone = (p: Vec2, zone: Zone): boolean => pointInPolygon(p, zone.polygon)

/** Bounding box of everything in the plan, plus a margin. */
export const planBounds = (plan: Plan, margin = 0): Bounds => {
  let bounds = { ...EMPTY_BOUNDS }
  const consume = (points: readonly Vec2[]) => {
    if (points.length) bounds = unionBounds(bounds, boundsOf(points))
  }
  for (const wall of plan.walls) consume(wallPolygon(wall))
  for (const item of plan.furniture) consume(furnitureVisualPolygon(item))
  for (const zone of plan.zones) consume(zone.polygon)
  for (const sp of plan.servicePoints) {
    consume(servicePolygon(sp))
    consume(serviceQueue(sp))
  }
  if (plan.backdrop?.visible) {
    consume(
      rectPolygon(
        plan.backdrop.position,
        plan.backdrop.width,
        plan.backdrop.depth,
        plan.backdrop.rotation,
      ),
    )
  }
  if (bounds.minX === Infinity) return { minX: -10, minY: -10, maxX: 10, maxY: 10 }
  return {
    minX: bounds.minX - margin,
    minY: bounds.minY - margin,
    maxX: bounds.maxX + margin,
    maxY: bounds.maxY + margin,
  }
}

export const planIsEmpty = (plan: Plan): boolean =>
  plan.walls.length === 0 &&
  plan.furniture.length === 0 &&
  plan.zones.length === 0 &&
  plan.servicePoints.length === 0

/** The wall an opening belongs to, or undefined if the document is inconsistent. */
export const openingWall = (plan: Plan, opening: Opening): Wall | undefined =>
  plan.walls.find((w) => w.id === opening.wallId)

/** World position and facing of an opening's centre. */
export const openingTransform = (
  plan: Plan,
  opening: Opening,
): { position: Vec2; angle: number; wall: Wall } | undefined => {
  const wall = openingWall(plan, opening)
  if (!wall) return undefined
  return { position: pointOnWall(wall, opening.offset), angle: wallAngle(wall), wall }
}
