import { describe, expect, it } from 'vitest'
import {
  makeFurniture,
  makeRoomWalls,
  makeWall,
  nearestWall,
  objectFootprint,
  rectangleFrom,
  rectangleSize,
  wallAlignedPlacement,
  wallLabel,
  wallMidpoint,
} from './geometryHelpers'
import { boundsOf, pointInPolygon, polygonArea, signedArea } from '../core/math/geometry'
import { distance, fromAngle } from '../core/math/vec2'
import { createDocument } from '../core/model/defaults'
import { resolveCatalogItem } from '../library/catalog'
import type { Vec2 } from '../core/math/vec2'
import type {
  CrowdDocument,
  FurnitureItem,
  Plan,
  ServicePoint,
  Wall,
  Zone,
} from '../core/model/types'

const WALL_OPTIONS = { thickness: 0.2, height: 3, kind: 'wall' as const }

let counter = 0

const wall = (ax: number, ay: number, bx: number, by: number, thickness = 0.2): Wall => ({
  id: `w${counter++}`,
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  thickness,
  height: 3,
  kind: 'wall',
})

const docWith = (plan: Partial<Plan>): CrowdDocument => {
  const doc = createDocument()
  return { ...doc, plan: { ...doc.plan, ...plan } }
}

const furniture = (over: Partial<FurnitureItem> = {}): FurnitureItem => ({
  id: `f${counter++}`,
  catalogId: 'table-rect-6ft',
  position: { x: 0, y: 0 },
  rotation: 0,
  ...over,
})

describe('makeWall', () => {
  it('copies its endpoints', () => {
    // The document is immutable; a tool that keeps dragging its cursor vector
    // must not reach back into the wall it already committed.
    const a: Vec2 = { x: 1, y: 2 }
    const b: Vec2 = { x: 5, y: 2 }
    const made = makeWall(a, b, WALL_OPTIONS)
    a.x = 99
    b.y = -99
    expect(made.a).toEqual({ x: 1, y: 2 })
    expect(made.b).toEqual({ x: 5, y: 2 })
  })

  it('mints a distinct prefixed id for every wall', () => {
    const ids = Array.from({ length: 64 }, () =>
      makeWall({ x: 0, y: 0 }, { x: 1, y: 0 }, WALL_OPTIONS),
    ).map((w) => w.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.startsWith('wall_'))).toBe(true)
  })

  it('carries the thickness, height and kind it was given', () => {
    const made = makeWall(
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      {
        thickness: 0.05,
        height: 1.1,
        kind: 'glass',
      },
    )
    expect(made.thickness).toBe(0.05)
    expect(made.height).toBe(1.1)
    expect(made.kind).toBe('glass')
  })
})

describe('makeRoomWalls', () => {
  it('closes the loop: every wall ends where the next one starts', () => {
    const walls = makeRoomWalls({ x: 1, y: 2 }, { x: 7, y: 6 }, WALL_OPTIONS)
    expect(walls).toHaveLength(4)
    for (let i = 0; i < 4; i++) {
      expect(walls[i].b).toEqual(walls[(i + 1) % 4].a)
    }
  })

  it('normalises the drag so all four corner-to-corner drags build the same room', () => {
    const corners = (s: Vec2, e: Vec2) => makeRoomWalls(s, e, WALL_OPTIONS).map((w) => w.a)
    const canonical = corners({ x: 1, y: 2 }, { x: 7, y: 6 })
    expect(corners({ x: 7, y: 6 }, { x: 1, y: 2 })).toEqual(canonical)
    expect(corners({ x: 1, y: 6 }, { x: 7, y: 2 })).toEqual(canonical)
    expect(corners({ x: 7, y: 2 }, { x: 1, y: 6 })).toEqual(canonical)
  })

  it('winds its corners the same way the marquee rectangle does', () => {
    // Both feed polygon code that assumes a consistent winding; if the room
    // tool and rectangleFrom ever disagreed, areas would come out negative.
    const start = { x: -3, y: 4 }
    const end = { x: 2, y: -1 }
    const corners = makeRoomWalls(start, end, WALL_OPTIONS).map((w) => w.a)
    expect(corners).toEqual(rectangleFrom(start, end))
    expect(polygonArea(corners)).toBeCloseTo(25, 9)
  })

  it('gives every wall the same build-up and its own id', () => {
    const walls = makeRoomWalls(
      { x: 0, y: 0 },
      { x: 4, y: 3 },
      {
        thickness: 0.3,
        height: 2.7,
        kind: 'partition',
      },
    )
    expect(
      walls.every((w) => w.thickness === 0.3 && w.height === 2.7 && w.kind === 'partition'),
    ).toBe(true)
    expect(new Set(walls.map((w) => w.id)).size).toBe(4)
  })

  it('still emits four walls for a zero-area drag', () => {
    // Current behaviour: the degenerate room is the caller's problem. The room
    // tool refuses anything under 0.3 m a side before it gets here.
    const walls = makeRoomWalls({ x: 2, y: 2 }, { x: 2, y: 2 }, WALL_OPTIONS)
    expect(walls).toHaveLength(4)
    expect(walls.every((w) => w.a.x === 2 && w.a.y === 2 && w.b.x === 2 && w.b.y === 2)).toBe(true)
  })
})

describe('makeFurniture', () => {
  it('copies the position and defaults the rotation to zero', () => {
    const position: Vec2 = { x: 3, y: -1 }
    const item = makeFurniture('chair', position)
    position.x = 99
    expect(item.position).toEqual({ x: 3, y: -1 })
    expect(item.rotation).toBe(0)
    expect(item.catalogId).toBe('chair')
    expect(item.id.startsWith('item_')).toBe(true)
  })

  it('keeps an explicit rotation', () => {
    expect(makeFurniture('chair', { x: 0, y: 0 }, Math.PI / 3).rotation).toBeCloseTo(
      Math.PI / 3,
      12,
    )
  })
})

describe('nearestWall', () => {
  it('returns null when the plan has no walls', () => {
    expect(nearestWall(docWith({ walls: [] }), { x: 0, y: 0 }, 5)).toBeNull()
  })

  it('picks the nearer wall and reports where on it the point lands', () => {
    const near = wall(0, 0, 6, 0)
    const far = wall(0, 3, 6, 3)
    const hit = nearestWall(docWith({ walls: [far, near] }), { x: 4, y: 0.4 }, 2)
    expect(hit?.wall.id).toBe(near.id)
    expect(hit?.distance).toBeCloseTo(0.4, 9)
    expect(hit?.closest).toEqual({ x: 4, y: 0 })
  })

  it('measures the offset from the wall a end, which is what anchors an opening', () => {
    const forwards = wall(0, 0, 4, 0)
    const backwards = wall(4, 0, 0, 0)
    const point = { x: 3, y: 0.1 }
    expect(nearestWall(docWith({ walls: [forwards] }), point, 1)?.offset).toBeCloseTo(3, 9)
    expect(nearestWall(docWith({ walls: [backwards] }), point, 1)?.offset).toBeCloseTo(1, 9)
  })

  it('includes a wall at exactly maxDistance and drops it just past', () => {
    const doc = docWith({ walls: [wall(0, 0, 6, 0)] })
    const point = { x: 2, y: 0.5 }
    expect(nearestWall(doc, point, 0.5)?.distance).toBeCloseTo(0.5, 12)
    expect(nearestWall(doc, point, 0.4999999)).toBeNull()
    expect(nearestWall(doc, point, 0)).toBeNull()
  })

  it('clamps past the end of a wall instead of running off it', () => {
    // The opening tool turns `offset` straight into a position along the wall;
    // an unclamped projection would park a door out in mid-air.
    const doc = docWith({ walls: [wall(0, 0, 4, 0)] })
    const hit = nearestWall(doc, { x: 5, y: 0 }, 2)
    expect(hit?.closest).toEqual({ x: 4, y: 0 })
    expect(hit?.distance).toBeCloseTo(1, 9)
    expect(hit?.offset).toBeCloseTo(4, 9)
  })

  it('reports zero distance for a point sitting exactly on a wall end', () => {
    const hit = nearestWall(docWith({ walls: [wall(0, 0, 4, 0)] }), { x: 4, y: 0 }, 1)
    expect(hit?.distance).toBe(0)
    expect(hit?.offset).toBeCloseTo(4, 9)
  })

  it('treats a zero-length wall as the single point it is', () => {
    const degenerate = wall(2, 2, 2, 2)
    const hit = nearestWall(docWith({ walls: [degenerate] }), { x: 2, y: 2.4 }, 1)
    expect(hit?.wall.id).toBe(degenerate.id)
    expect(hit?.closest).toEqual({ x: 2, y: 2 })
    expect(hit?.distance).toBeCloseTo(0.4, 9)
    expect(hit?.offset).toBe(0)
  })

  it('breaks a tie on document order, so a hover preview does not flicker', () => {
    const left = wall(0, 0, 0, 4)
    const right = wall(2, 0, 2, 4)
    const point = { x: 1, y: 1 }
    expect(nearestWall(docWith({ walls: [left, right] }), point, 5)?.wall.id).toBe(left.id)
    expect(nearestWall(docWith({ walls: [right, left] }), point, 5)?.wall.id).toBe(right.id)
  })

  it('breaks the corner tie the same way, where two walls are both at zero', () => {
    const along = wall(0, 0, 4, 0)
    const up = wall(0, 0, 0, 4)
    const corner = { x: 0, y: 0 }
    const first = nearestWall(docWith({ walls: [along, up] }), corner, 1)
    expect(first?.wall.id).toBe(along.id)
    expect(first?.distance).toBe(0)
    expect(nearestWall(docWith({ walls: [up, along] }), corner, 1)?.wall.id).toBe(up.id)
  })
})

describe('wallAlignedPlacement', () => {
  const horizontal = wall(0, 0, 6, 0, 0.3)
  const doc = docWith({ walls: [horizontal] })

  it('backs the object onto the wall face, not its centreline', () => {
    const placed = wallAlignedPlacement(doc, { x: 3, y: 0.5 }, 0.6)
    expect(placed?.wall.id).toBe(horizontal.id)
    expect(placed?.position.x).toBeCloseTo(3, 9)
    // thickness/2 + depth/2 puts the object's back exactly on the wall face.
    expect(placed?.position.y).toBeCloseTo(0.15 + 0.3, 9)
    expect((placed?.position.y ?? 0) - 0.6 / 2).toBeCloseTo(horizontal.thickness / 2, 9)
  })

  it('turns the object local +Z into the room', () => {
    const placed = wallAlignedPlacement(doc, { x: 3, y: 0.5 }, 0.6)
    const forward = fromAngle((placed?.rotation ?? 0) + Math.PI / 2)
    expect(forward.x).toBeCloseTo(0, 9)
    expect(forward.y).toBeCloseTo(1, 9)
  })

  it('flips when the same wall is approached from the other side', () => {
    const above = wallAlignedPlacement(doc, { x: 3, y: 0.5 }, 0.6)
    const below = wallAlignedPlacement(doc, { x: 3, y: -0.5 }, 0.6)
    expect(below?.position.y).toBeCloseTo(-(0.15 + 0.3), 9)
    const forward = fromAngle((below?.rotation ?? 0) + Math.PI / 2)
    expect(forward.y).toBeCloseTo(-1, 9)
    expect(Math.abs((above?.rotation ?? 0) - (below?.rotation ?? 0))).toBeCloseTo(Math.PI, 9)
  })

  it('honours the reach, measured to the wall centreline', () => {
    expect(wallAlignedPlacement(doc, { x: 3, y: 1.2 }, 0.6)).not.toBeNull()
    expect(wallAlignedPlacement(doc, { x: 3, y: 1.21 }, 0.6)).toBeNull()
    expect(wallAlignedPlacement(doc, { x: 3, y: 1.21 }, 0.6, 1.4)).not.toBeNull()
  })

  it('gives up when the point is exactly on the centreline', () => {
    // There is no outward direction to align to, so the placement tools fall
    // back to a free-standing drop rather than guessing a side.
    expect(wallAlignedPlacement(doc, { x: 3, y: 0 }, 0.6)).toBeNull()
  })

  it('snaps a hair of rotation away to exactly zero', () => {
    // Clamping past a wall end tilts `outward` by whatever the overshoot was.
    // Left alone, an object dropped at the end of a wall would serialise with a
    // rotation of -1e-9 and never compare equal to the same object elsewhere.
    const nudged = wallAlignedPlacement(doc, { x: 6 + 1e-9, y: 1 }, 0.6)
    expect(nudged?.rotation).toBe(0)

    // A real overshoot is kept: the snap must not swallow a visible tilt.
    const tilted = wallAlignedPlacement(doc, { x: 6.001, y: 1 }, 0.6)
    expect(tilted?.rotation).toBeCloseTo(-0.001, 6)
    expect(tilted?.rotation).not.toBe(0)
  })

  it('aligns to the nearest of several walls', () => {
    const inner = wall(0, 2, 6, 2, 0.1)
    const multi = docWith({ walls: [horizontal, inner] })
    expect(wallAlignedPlacement(multi, { x: 3, y: 1.6 }, 0.4)?.wall.id).toBe(inner.id)
    expect(wallAlignedPlacement(multi, { x: 3, y: 0.6 }, 0.4)?.wall.id).toBe(horizontal.id)
  })
})

describe('rectangleFrom and rectangleSize', () => {
  it('returns min-min, max-min, max-max, min-max whichever way the drag went', () => {
    const expected = [
      { x: 1, y: 2 },
      { x: 5, y: 2 },
      { x: 5, y: 7 },
      { x: 1, y: 7 },
    ]
    expect(rectangleFrom({ x: 1, y: 2 }, { x: 5, y: 7 })).toEqual(expected)
    expect(rectangleFrom({ x: 5, y: 7 }, { x: 1, y: 2 })).toEqual(expected)
    expect(rectangleFrom({ x: 5, y: 2 }, { x: 1, y: 7 })).toEqual(expected)
  })

  it('collapses to four coincident points for a zero-size drag', () => {
    const points = rectangleFrom({ x: 2, y: 2 }, { x: 2, y: 2 })
    expect(points).toHaveLength(4)
    expect(polygonArea(points)).toBe(0)
  })

  it('reports width along x and depth along y, whichever way the drag went', () => {
    expect(rectangleSize({ x: 1, y: 2 }, { x: 5, y: 7 })).toEqual({ width: 4, depth: 5 })
    expect(rectangleSize({ x: 5, y: 7 }, { x: 1, y: 2 })).toEqual({ width: 4, depth: 5 })
  })
})

describe('objectFootprint', () => {
  it('gives a wall a rectangle of its length by its thickness', () => {
    const w = wall(0, 0, 4, 0, 0.3)
    const poly = objectFootprint(docWith({ walls: [w] }), 'wall', w.id)
    expect(poly).not.toBeNull()
    expect(polygonArea(poly ?? [])).toBeCloseTo(4 * 0.3, 9)
    const b = boundsOf(poly ?? [])
    expect(b.minY).toBeCloseTo(-0.15, 9)
    expect(b.maxY).toBeCloseTo(0.15, 9)
  })

  it('centres the wall footprint on the centreline, so clicks near it hit', () => {
    const w = wall(0, 0, 4, 0, 0.3)
    const poly = objectFootprint(docWith({ walls: [w] }), 'wall', w.id) ?? []
    expect(pointInPolygon(wallMidpoint(w), poly)).toBe(true)
    expect(pointInPolygon({ x: 2, y: 0.14 }, poly)).toBe(true)
    expect(pointInPolygon({ x: 2, y: 0.16 }, poly)).toBe(false)
  })

  it('handles a diagonal wall', () => {
    const w = wall(0, 0, 3, 4, 0.5)
    const poly = objectFootprint(docWith({ walls: [w] }), 'wall', w.id) ?? []
    expect(polygonArea(poly)).toBeCloseTo(5 * 0.5, 9)
    expect(pointInPolygon({ x: 1.5, y: 2 }, poly)).toBe(true)
  })

  it('gives a zero-length wall a thickness-sized square so it can still be picked', () => {
    // nearestWall finds a wall with no length, so the marquee has to as well:
    // otherwise the one wall a user cannot rubber-band away is the stray click
    // they most want gone.
    const w = wall(2, 2, 2, 2, 0.3)
    const poly = objectFootprint(docWith({ walls: [w] }), 'wall', w.id) ?? []
    expect(poly).toHaveLength(4)
    expect(polygonArea(poly)).toBeCloseTo(0.3 * 0.3, 12)
    const b = boundsOf(poly)
    expect(b.minX).toBeCloseTo(1.85, 12)
    expect(b.maxX).toBeCloseTo(2.15, 12)
    expect(b.minY).toBeCloseTo(1.85, 12)
    expect(b.maxY).toBeCloseTo(2.15, 12)
    expect(pointInPolygon({ x: 2, y: 2 }, poly)).toBe(true)
    expect(pointInPolygon({ x: 2, y: 2.2 }, poly)).toBe(false)
    // selectTool picks by testing the footprint corners against the marquee.
    const marquee = rectangleFrom({ x: 0, y: 0 }, { x: 4, y: 4 })
    expect(poly.some((p) => pointInPolygon(p, marquee))).toBe(true)
    // Same counter-clockwise winding as a wall with length, so nothing
    // downstream sees a negative area from the degenerate case alone.
    const drawn = wall(0, 0, 4, 0, 0.3)
    const drawnPoly = objectFootprint(docWith({ walls: [drawn] }), 'wall', drawn.id) ?? []
    expect(Math.sign(signedArea(poly))).toBe(Math.sign(signedArea(drawnPoly)))
    expect(signedArea(poly)).toBeGreaterThan(0)
  })

  it('sizes furniture from the catalog when the instance carries no override', () => {
    const item = furniture({ catalogId: 'table-rect-6ft' })
    const size = resolveCatalogItem('table-rect-6ft').size
    const b = boundsOf(objectFootprint(docWith({ furniture: [item] }), 'furniture', item.id) ?? [])
    expect(b.maxX - b.minX).toBeCloseTo(size.width, 9)
    expect(b.maxY - b.minY).toBeCloseTo(size.depth, 9)
  })

  it('prefers a per-instance size override', () => {
    const catalog = resolveCatalogItem('table-rect-6ft').size
    const item = furniture({ size: { width: 3, depth: 1, height: 1 } })
    expect(catalog.width).not.toBeCloseTo(3, 3)
    const b = boundsOf(objectFootprint(docWith({ furniture: [item] }), 'furniture', item.id) ?? [])
    expect(b.maxX - b.minX).toBeCloseTo(3, 9)
    expect(b.maxY - b.minY).toBeCloseTo(1, 9)
  })

  it('rotates the furniture footprint about its position', () => {
    const item = furniture({
      position: { x: 5, y: 5 },
      rotation: Math.PI / 2,
      size: {
        width: 2,
        depth: 0.5,
        height: 1,
      },
    })
    const b = boundsOf(objectFootprint(docWith({ furniture: [item] }), 'furniture', item.id) ?? [])
    expect(b.maxX - b.minX).toBeCloseTo(0.5, 9)
    expect(b.maxY - b.minY).toBeCloseTo(2, 9)
    expect((b.minX + b.maxX) / 2).toBeCloseTo(5, 9)
    expect((b.minY + b.maxY) / 2).toBeCloseTo(5, 9)
  })

  it('falls back to a placeholder footprint for an item this build has never heard of', () => {
    // A document saved by a newer build must still be selectable, not invisible.
    const item = furniture({ catalogId: 'no-such-item-in-this-build' })
    const b = boundsOf(objectFootprint(docWith({ furniture: [item] }), 'furniture', item.id) ?? [])
    expect(b.maxX - b.minX).toBeCloseTo(0.6, 9)
    expect(b.maxY - b.minY).toBeCloseTo(0.6, 9)
  })

  it('hands back a zone polygon the caller owns, like every other kind', () => {
    // Handing back the document's own array let a caller that took the result
    // for its own rewrite the plan in place, past `apply` and past undo.
    const zone: Zone = {
      id: 'z1',
      kind: 'seating',
      name: 'Stalls',
      polygon: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 2 },
      ],
    }
    const poly = objectFootprint(docWith({ zones: [zone] }), 'zone', zone.id) ?? []
    expect(poly).toEqual(zone.polygon)
    expect(poly).not.toBe(zone.polygon)
    poly[0].x = 99
    poly.push({ x: 5, y: 5 })
    expect(zone.polygon).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
    ])
  })

  it('gives a service point the rectangle of its counter', () => {
    const point: ServicePoint = {
      id: 's1',
      name: 'Bar',
      position: { x: 5, y: 5 },
      rotation: Math.PI / 2,
      width: 2,
      depth: 0.8,
      servers: 2,
      serviceTime: { kind: 'constant', mean: 30 },
      queueSpacing: 0.6,
    }
    const poly = objectFootprint(docWith({ servicePoints: [point] }), 'service', point.id) ?? []
    expect(polygonArea(poly)).toBeCloseTo(2 * 0.8, 9)
    const b = boundsOf(poly)
    expect(b.maxX - b.minX).toBeCloseTo(0.8, 9)
    expect(b.maxY - b.minY).toBeCloseTo(2, 9)
  })

  it('returns null for an id that is not in the plan', () => {
    const doc = docWith({})
    expect(objectFootprint(doc, 'wall', 'missing')).toBeNull()
    expect(objectFootprint(doc, 'furniture', 'missing')).toBeNull()
    expect(objectFootprint(doc, 'zone', 'missing')).toBeNull()
    expect(objectFootprint(doc, 'service', 'missing')).toBeNull()
  })

  it('returns null for the plan kinds that have no footprint of their own', () => {
    // Openings belong to their wall, and the backdrop is a tracing aid; neither
    // is marquee-selectable, and selectTool never asks for them.
    const doc = docWith({})
    expect(objectFootprint(doc, 'opening', 'anything')).toBeNull()
    expect(objectFootprint(doc, 'backdrop', 'anything')).toBeNull()
    expect(objectFootprint(doc, 'nonsense', 'anything')).toBeNull()
  })
})

describe('wallMidpoint and wallLabel', () => {
  it('puts the move handle halfway along the wall', () => {
    expect(wallMidpoint(wall(1, 2, 5, 10))).toEqual({ x: 3, y: 6 })
    expect(wallMidpoint(wall(-2, -2, 2, 2))).toEqual({ x: 0, y: 0 })
  })

  it('labels a wall with its length and its drawing direction', () => {
    const label = wallLabel(wall(0, 0, 3, 4))
    expect(label.position).toEqual({ x: 1.5, y: 2 })
    expect(label.length).toBeCloseTo(5, 12)
    expect(label.angle).toBeCloseTo(Math.atan2(4, 3), 12)
  })

  it('reads the angle back along a wall drawn right to left', () => {
    expect(wallLabel(wall(4, 0, 0, 0)).angle).toBeCloseTo(Math.PI, 12)
  })

  it('labels a zero-length wall as zero metres at zero radians', () => {
    const label = wallLabel(wall(2, 2, 2, 2))
    expect(label.length).toBe(0)
    expect(label.angle).toBe(0)
    expect(label.position).toEqual({ x: 2, y: 2 })
  })
})

describe('the helpers agree with each other', () => {
  it('finds each wall of a drawn room from a point just inside it', () => {
    const walls = makeRoomWalls({ x: 0, y: 0 }, { x: 8, y: 5 }, WALL_OPTIONS)
    const doc = docWith({ walls })
    const probes: Array<[Vec2, number]> = [
      [{ x: 4, y: 0.2 }, 0],
      [{ x: 7.8, y: 2.5 }, 1],
      [{ x: 4, y: 4.8 }, 2],
      [{ x: 0.2, y: 2.5 }, 3],
    ]
    for (const [point, index] of probes) {
      const hit = nearestWall(doc, point, 0.5)
      expect(hit?.wall.id).toBe(walls[index].id)
      const aligned = wallAlignedPlacement(doc, point, 0.4)
      expect(aligned?.wall.id).toBe(walls[index].id)
      // Whichever wall of the room it is, the object stands off the centreline
      // by thickness/2 + depth/2 on the side the pointer came from.
      expect(distance(aligned?.position ?? point, hit?.closest ?? point)).toBeCloseTo(0.3, 9)
    }
  })
})
