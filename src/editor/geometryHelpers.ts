/**
 * Geometry helpers shared by the editing tools.
 */

import type { Vec2 } from '../core/math/vec2'
import { add, angleOf, distance, normalize, rotate, scale, sub } from '../core/math/vec2'
import type { CrowdDocument, FurnitureItem, Wall } from '../core/model/types'
import { closestPointOnSegment, rectPolygon } from '../core/math/geometry'
import { wallLength } from '../core/model/planGeometry'
import { newId } from '../core/model/ids'
import { resolveCatalogItem } from '../library/catalog'

export const makeWall = (
  a: Vec2,
  b: Vec2,
  options: { thickness: number; height: number; kind: Wall['kind'] },
): Wall => ({
  id: newId('wall'),
  a: { ...a },
  b: { ...b },
  thickness: options.thickness,
  height: options.height,
  kind: options.kind,
})

/** Four walls forming a closed rectangle. */
export const makeRoomWalls = (
  start: Vec2,
  end: Vec2,
  options: { thickness: number; height: number; kind: Wall['kind'] },
): Wall[] => {
  const minX = Math.min(start.x, end.x)
  const maxX = Math.max(start.x, end.x)
  const minY = Math.min(start.y, end.y)
  const maxY = Math.max(start.y, end.y)
  const corners: Vec2[] = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ]
  return corners.map((corner, index) => makeWall(corner, corners[(index + 1) % 4], options))
}

export const makeFurniture = (catalogId: string, position: Vec2, rotation = 0): FurnitureItem => ({
  id: newId('item'),
  catalogId,
  position: { ...position },
  rotation,
})

/** The wall nearest to a point, within `maxDistance`. */
export const nearestWall = (
  doc: CrowdDocument,
  point: Vec2,
  maxDistance: number,
): { wall: Wall; closest: Vec2; distance: number; offset: number } | null => {
  let best: { wall: Wall; closest: Vec2; distance: number; offset: number } | null = null
  for (const wall of doc.plan.walls) {
    const closest = closestPointOnSegment(point, wall.a, wall.b)
    const d = distance(closest, point)
    if (d > maxDistance) continue
    if (!best || d < best.distance) {
      best = { wall, closest, distance: d, offset: distance(wall.a, closest) }
    }
  }
  return best
}

/**
 * Orientation for an object placed near a wall: back to the wall, front to the
 * room. Returns null when no wall is close enough to matter.
 */
export const wallAlignedPlacement = (
  doc: CrowdDocument,
  point: Vec2,
  depth: number,
  reach = 1.2,
): { position: Vec2; rotation: number; wall: Wall } | null => {
  const near = nearestWall(doc, point, reach)
  if (!near) return null

  const outward = normalize(sub(point, near.closest))
  if (outward.x === 0 && outward.y === 0) return null
  // The object's local +Z faces into the room.
  const rotation = angleOf(outward) - Math.PI / 2
  const offset = near.wall.thickness / 2 + depth / 2
  return {
    position: add(near.closest, scale(outward, offset)),
    rotation: Math.abs(rotation) < 1e-6 ? 0 : rotation,
    wall: near.wall,
  }
}

export const rectangleFrom = (a: Vec2, b: Vec2): Vec2[] => [
  { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
  { x: Math.max(a.x, b.x), y: Math.min(a.y, b.y) },
  { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
  { x: Math.min(a.x, b.x), y: Math.max(a.y, b.y) },
]

export const rectangleSize = (a: Vec2, b: Vec2): { width: number; depth: number } => ({
  width: Math.abs(b.x - a.x),
  depth: Math.abs(b.y - a.y),
})

/** Footprint polygon for any plan object, used for rubber-band selection. */
export const objectFootprint = (doc: CrowdDocument, kind: string, id: string): Vec2[] | null => {
  switch (kind) {
    case 'wall': {
      const wall = doc.plan.walls.find((w) => w.id === id)
      if (!wall) return null
      const dir = normalize(sub(wall.b, wall.a))
      // A wall drawn without length still has to be selectable. There is no
      // direction to take a normal from, so the four corners below would all
      // land on `a`: nearestWall would keep finding the wall while the marquee
      // could never pick it up, leaving the user no way to rubber-band it away.
      if (dir.x === 0 && dir.y === 0) {
        return rectPolygon(wall.a, wall.thickness, wall.thickness)
      }
      const n = rotate(dir, Math.PI / 2)
      const half = wall.thickness / 2
      return [
        add(wall.a, scale(n, -half)),
        add(wall.b, scale(n, -half)),
        add(wall.b, scale(n, half)),
        add(wall.a, scale(n, half)),
      ]
    }
    case 'furniture': {
      const item = doc.plan.furniture.find((f) => f.id === id)
      if (!item) return null
      const size = item.size ?? resolveCatalogItem(item.catalogId).size
      return rectPolygon(item.position, size.width, size.depth, item.rotation)
    }
    case 'zone': {
      const zone = doc.plan.zones.find((z) => z.id === id)
      // A copy, like every other kind returns: a caller that takes the result
      // for its own and edits it would otherwise rewrite the document in place,
      // past `apply` and past undo.
      return zone ? zone.polygon.map((p) => ({ ...p })) : null
    }
    case 'service': {
      const point = doc.plan.servicePoints.find((s) => s.id === id)
      return point ? rectPolygon(point.position, point.width, point.depth, point.rotation) : null
    }
    default:
      return null
  }
}

/** Midpoint of a wall, where its move handle sits. */
export const wallMidpoint = (wall: Wall): Vec2 => ({
  x: (wall.a.x + wall.b.x) / 2,
  y: (wall.a.y + wall.b.y) / 2,
})

export const wallLabel = (wall: Wall): { position: Vec2; length: number; angle: number } => ({
  position: wallMidpoint(wall),
  length: wallLength(wall),
  angle: angleOf(sub(wall.b, wall.a)),
})
